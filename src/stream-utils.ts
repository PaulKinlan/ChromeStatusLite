// chromestatus.com guards its JSON with an XSSI prefix, ")]}'\n" (five bytes),
// which has to be dropped before JSON.parse. Only the START of the body is
// inspected, and a chunk boundary can fall inside the prefix - an HTTP/2 frame,
// a proxy, or a slow first segment may deliver one to four bytes first - so the
// decision waits until five bytes have arrived, and a body shorter than that is
// passed through untouched on flush (chrome-status-lite-95fa).
const XSSI_PREFIX = [41, 93, 125, 39, 10]; // )]}'\n

export class StripStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor() {
    let head: Uint8Array[] = [];
    let headBytes = 0;
    let decided = false;
    super({
      transform(chunk, controller) {
        if (decided) {
          controller.enqueue(chunk);
          return;
        }
        head.push(chunk);
        headBytes += chunk.byteLength;
        if (headBytes < XSSI_PREFIX.length) return; // wait: the prefix may be split
        const joined = new Uint8Array(headBytes);
        let at = 0;
        for (const part of head) {
          joined.set(part, at);
          at += part.byteLength;
        }
        head = [];
        headBytes = 0;
        decided = true;
        const prefixed = XSSI_PREFIX.every((byte, index) => joined[index] === byte);
        const body = prefixed ? joined.subarray(XSSI_PREFIX.length) : joined;
        if (body.byteLength > 0) controller.enqueue(body);
      },
      flush(controller) {
        // The whole body was shorter than the prefix: it cannot be the prefix.
        if (decided) return;
        decided = true;
        for (const part of head) controller.enqueue(part);
        head = [];
      },
    });
  }
}
