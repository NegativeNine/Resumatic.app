import { z } from "zod";
import { MAX_ARCHIVE_BYTES } from "../render/archive";

const Manifest = z.object({
  exportedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  jsonBytes: z.number().int().min(2).max(MAX_ARCHIVE_BYTES),
  files: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    key: z.string().min(1),
    path: z.string(),
    origin: z.string().max(100),
  }).strict()).max(128),
}).strict();

/** Read only the bounded prefix; keep the JSON behind the same RPC stream. */
export async function readArchiveSnapshot(response: Response, vaultId: string, signal?: AbortSignal) {
  if (!response.body) throw new Error("archive_snapshot_missing");
  const reader = response.body.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let stopped = false;
  const abort = () => {
    stopped = true;
    pending = new Uint8Array(0);
    void reader.cancel("archive aborted").catch(() => {});
  };
  if (signal?.aborted) { abort(); throw new DOMException("archive aborted", "AbortError"); }
  signal?.addEventListener("abort", abort, { once: true });
  const cancel = (reason?: unknown) => {
    stopped = true;
    pending = new Uint8Array(0);
    signal?.removeEventListener("abort", abort);
    return reader.cancel(reason);
  };
  async function exact(length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(length);
    let used = 0, empty = 0;
    while (used < length) {
      if (stopped) throw new DOMException("archive aborted", "AbortError");
      if (!pending.byteLength) {
        const next = await reader.read();
        if (stopped) throw new DOMException("archive aborted", "AbortError");
        if (next.done || !(next.value instanceof Uint8Array)) throw new Error("archive_manifest_truncated");
        if (!next.value.byteLength) {
          if (++empty > 16) throw new Error("archive_manifest_empty");
          continue;
        }
        pending = next.value;
      }
      const count = Math.min(length - used, pending.byteLength);
      bytes.set(pending.subarray(0, count), used);
      pending = pending.subarray(count);
      used += count;
    }
    return bytes;
  }
  try {
    const prefix = await exact(4);
    const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, false);
    if (!length || length > 1024 * 1024) throw new Error("archive_manifest_size");
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await exact(length));
    const manifest = Manifest.parse(JSON.parse(raw));
    for (const file of manifest.files) {
      if (!file.key.startsWith(`vaults/${vaultId}/sources/`) ||
          !["pdf", "docx", "zip", "json", "txt", "bin"].some((ext) => file.path === `sources/${file.id}.${ext}`) ||
          (file.origin === "ocr" && file.path !== `sources/${file.id}.json`))
        throw new Error("archive_manifest_path");
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (stopped) throw new DOMException("archive aborted", "AbortError");
          if (pending.byteLength) {
            const chunk = pending;
            pending = new Uint8Array(0);
            controller.enqueue(chunk);
            return;
          }
          const next = await reader.read();
          if (stopped) throw new DOMException("archive aborted", "AbortError");
          if (next.done) controller.close(); else controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      cancel,
    }, { highWaterMark: 0 });
    if (signal?.aborted) throw new DOMException("archive aborted", "AbortError");
    return { manifest, body, cancel };
  } catch (error) {
    void cancel(error).catch(() => {});
    throw error;
  }
}

/** Stop awaiting a read-only metadata call when its download is cancelled. */
export async function archivePreflight<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new DOMException("archive aborted", "AbortError");
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("archive aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    if (signal.aborted) throw new DOMException("archive aborted", "AbortError");
    return await Promise.race([start(), interrupted]);
  } finally { signal.removeEventListener("abort", abort); }
}
