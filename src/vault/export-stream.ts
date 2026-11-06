function* jsonParts(snapshot: object): Generator<string> {
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

/** The same string chunks are used for preflight byte counting and delivery. */
export function* exportJsonChunks(snapshot: object): Generator<string> {
  let chunk = "";
  for (const part of jsonParts(snapshot)) {
    chunk += part;
    if (chunk.length >= 32 * 1024) { yield chunk; chunk = ""; }
  }
  if (chunk) yield chunk;
}

/** Stream one captured JSON object without serializing the entire snapshot at once. */
export function exportJsonStream(snapshot: object): ReadableStream<Uint8Array> {
  const chunks = exportJsonChunks(snapshot), encoder = new TextEncoder();
  return new ReadableStream({
    type: "bytes",
    pull(controller) {
      const next = chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    cancel() { chunks.return(undefined); },
  }, { highWaterMark: 0 });
}
