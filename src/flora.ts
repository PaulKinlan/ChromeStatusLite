import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

const encoder = new TextEncoder();

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

const pipeInto = async (from, controller) => {
  const reader = from.getReader();

  return reader.read().then(function process(result) {
    if (result.done) {
      return;
    }
    const value = result.value;
    const isTypedArray =
      value instanceof Int8Array ||
      value instanceof Int16Array ||
      value instanceof Int32Array ||
      value instanceof Uint8Array ||
      value instanceof Uint8ClampedArray ||
      value instanceof Uint16Array ||
      value instanceof Uint32Array ||
      value instanceof Float32Array ||
      value instanceof Float64Array;
    if (
      (isTypedArray === false && !!result.value) ||
      (isTypedArray && value.length > 0)
    ) {
      controller.enqueue(result.value);
    }
    return reader.read().then(process);
  });
};

const enqueueItem = async (val, controller) => {
  if (val instanceof ReadableStream) {
    await pipeInto(val, controller);
  } else if (val instanceof Promise) {
    let newVal;
    newVal = await val;

    if (newVal instanceof ReadableStream) {
      await pipeInto(newVal, controller);
    } else {
      await enqueueItem(newVal, controller);
    }
  } else {
    if (Array.isArray(val)) {
      for (let item of val) {
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
        controller.enqueue(encoder.encode(val));
      }
    }
  }
};

// Tagged-template HTML streamer. The static string parts are authored markup
// and are emitted verbatim; interpolated values are safe by default: plain
// strings are HTML-escaped, arrays/promises recurse, nested template results
// (ReadableStreams) pass through as already-rendered markup, and raw() is the
// explicit opt-out for intentional markup in a string.
export default async (strings, ...values): ReadableStream => {
  return new ReadableStream({
    start(controller) {
      async function push() {
        let i = 0;
        while (i < values.length) {
          let html = strings[i];
          controller.enqueue(encoder.encode(html));
          await enqueueItem(values[i], controller);

          i++;
        }
        controller.enqueue(encoder.encode(strings[i]));
        controller.close();
      }

      push().catch((err) => controller.error(err));
    },
  });
};
