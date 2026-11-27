const encoder = new TextEncoder();

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

// Intentional markup produced outside a template (already-rendered HTML) that
// must be emitted verbatim. Every plain string interpolated into a template is
// HTML-escaped by the engine; wrapping in raw() is the only way to emit markup
// from a string, and it is explicit at the call site.
class RawMarkup {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export const raw = (value: unknown): RawMarkup => new RawMarkup(String(value));

export type TemplateResult = Promise<ReadableStream<Uint8Array>>;

const pipeInto = async (
  from: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> => {
  const reader = from.getReader();

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      const value = result.value;
      const isTypedArray = ArrayBuffer.isView(value);
      if (
        (!isTypedArray && Boolean(value)) ||
        (isTypedArray && value.byteLength > 0)
      ) {
        controller.enqueue(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
};

const enqueueItem = async (
  val: unknown,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> => {
  if (val instanceof ReadableStream) {
    await pipeInto(val as ReadableStream<Uint8Array>, controller);
  } else if (val instanceof Promise) {
    const newVal = await val;
    if (newVal instanceof ReadableStream) {
      await pipeInto(newVal as ReadableStream<Uint8Array>, controller);
    } else {
      await enqueueItem(newVal, controller);
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      await enqueueItem(item, controller);
    }
  } else if (val !== undefined && val !== null) {
    // Safe by default: plain strings are untrusted text and are escaped
    // here, so a forgotten escapeHtml at a call site can no longer become
    // XSS. Nested template results are ReadableStreams (already-rendered
    // markup) and pass through above; only an explicit raw() wrapper emits
    // a string verbatim. Non-strings (numbers, booleans) stringify as
    // before.
    if (val instanceof RawMarkup) {
      controller.enqueue(encoder.encode(val.value));
    } else if (typeof val === "string") {
      controller.enqueue(encoder.encode(escapeHtml(val)));
    } else {
      // Objects with a custom toString (URL instances, String wrappers,
      // domain objects) stringify through ToString — without escaping here
      // they would emit raw markup, the same unsafe direction the engine
      // default exists to remove. escapeHtml(String(...)) is
      // output-identical for numbers and booleans (chrome-status-lite-d9n).
      controller.enqueue(encoder.encode(escapeHtml(String(val))));
    }
  }
};

// Tagged-template HTML streamer. The static string parts are authored markup
// and are emitted verbatim; interpolated values are safe by default: plain
// strings are HTML-escaped, arrays/promises recurse, nested template results
// (ReadableStreams) pass through as already-rendered markup, and raw() is the
// explicit opt-out for intentional markup in a string.
export default async function template(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<ReadableStream<Uint8Array>> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      async function push(): Promise<void> {
        let i = 0;
        while (i < values.length) {
          controller.enqueue(encoder.encode(strings[i]));
          await enqueueItem(values[i], controller);
          i++;
        }
        controller.enqueue(encoder.encode(strings[i]));
        controller.close();
      }

      push().catch((err) => controller.error(err));
    },
  });
}
