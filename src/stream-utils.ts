export class StripStream extends TransformStream {
  constructor() {
    let parsedFirstChunk: boolean = false;
    super({
      transform(chunk, controller) {
        if (parsedFirstChunk == false) {
          const firstChunk = chunk.slice(0, 5);
          console.log(firstChunk.toString());
          if (firstChunk.toString() != ")]}'\n") {
            // 41,  93, 125,  39, 10 == ")]}'\n"
            controller.enqueue(chunk.slice(5));
          }
          parsedFirstChunk = true;
        } else {
          controller.enqueue(chunk);
        }
      },
    });
  }
}
