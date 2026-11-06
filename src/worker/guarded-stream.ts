/**
 * Recheck access before reading and before releasing each source chunk.
 * Bytes already delivered to a client cannot be recalled.
 */
export function guardedStream(
  source: ReadableStream<Uint8Array>,
  check: () => Promise<unknown>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let emptyChunks = 0;
        for (;;) {
          await check();
          const chunk = await reader.read();
          await check();
          if (chunk.done) { controller.close(); return; }
          if (chunk.value.byteLength === 0) {
            // Permit a few legal empty chunks, but bound repeated checks on a
            // source that makes no progress.
            if (++emptyChunks > 16) throw new Error("source stream made no progress");
            continue;
          }
          controller.enqueue(chunk.value);
          return;
        }
      } catch (error) {
        // A failed session check must not keep a live R2 body open. Do not
        // wait for a misbehaving upstream cancellation before failing closed.
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
}
