import type { FactView, RoleView, SourceView } from "../shared/api";

export interface ReviewView {
  sources: SourceView[];
  roles: RoleView[];
  facts: FactView[];
}

/** Stream a captured review view without sending a large serialized RPC value. */
export function reviewViewStream(view: ReviewView): ReadableStream<Uint8Array> {
  function* json(): Generator<string> {
    yield "{";
    const entries = [["sources", view.sources], ["roles", view.roles], ["facts", view.facts]] as const;
    for (let group = 0; group < entries.length; group++) {
      const [name, items] = entries[group]!;
      yield `${group ? "," : ""}${JSON.stringify(name)}:[`;
      for (let i = 0; i < items.length; i++) yield `${i ? "," : ""}${JSON.stringify(items[i])}`;
      yield "]";
    }
    yield "}";
  }
  const parts = json();
  const encoder = new TextEncoder();
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
