/** Stream one captured JSON object without serializing the entire snapshot at once. */
export function exportJsonStream(snapshot: object): ReadableStream<Uint8Array> {
  function* json(): Generator<string> {
    yield "{";
    let first = true;
    for (const [key, value] of Object.entries(snapshot)) {
      const encoded = Array.isArray(value) ? null : JSON.stringify(value);
      // Match JSON.stringify's treatment of undefined object properties.
      if (!Array.isArray(value) && encoded === undefined) continue;
      yield `${first ? "" : ","}${JSON.stringify(key)}:`;
      first = false;
      if (Array.isArray(value)) {
        yield "[";
        for (let i = 0; i < value.length; i++)
          yield `${i ? "," : ""}${JSON.stringify(value[i]) ?? "null"}`;
        yield "]";
      } else yield encoded!;
    }
    yield "}";
  }
  const parts = json(), encoder = new TextEncoder();
  return new ReadableStream({
    type: "bytes",
    pull(controller) {
      let chunk = "";
      while (chunk.length < 32 * 1024) {
        const part = parts.next();
        if (part.done) {
          if (chunk) controller.enqueue(encoder.encode(chunk));
          else controller.close();
          return;
        }
        chunk += part.value;
      }
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() { parts.return(undefined); },
  }, { highWaterMark: 0 });
}
