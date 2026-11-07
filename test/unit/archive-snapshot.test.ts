import { expect, it } from "vitest";
import { archivePreflight, readArchiveSnapshot } from "../../src/worker/archive-snapshot";
import { exportJsonChunks, exportJsonStream } from "../../src/vault/export-stream";

const vid = "a".repeat(64), encoder = new TextEncoder();
const manifest = { exportedAt: "2026-11-06T10:00:00.000Z", jsonBytes: 2, files: [
  { id: "id-1", key: `vaults/${vid}/sources/id-1`, path: "sources/id-1.pdf", origin: "upload" },
] };
function frame(value: unknown, body = "{}") {
  const bytes = encoder.encode(JSON.stringify(value)), prefix = new Uint8Array(4 + bytes.length);
  new DataView(prefix.buffer).setUint32(0, bytes.length, false);
  prefix.set(bytes, 4);
  return new Uint8Array([...prefix, ...encoder.encode(body)]);
}
function fragmented(bytes: Uint8Array) {
  let at = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const end = Math.min(at + (at % 7 + 1), bytes.length);
      controller.enqueue(bytes.slice(at, end)); at = end;
    },
  }, { highWaterMark: 0 }));
}

it("reads a fragmented bounded manifest and preserves all following JSON bytes", async () => {
  const snapshot = await readArchiveSnapshot(fragmented(frame(manifest)), vid);
  expect(snapshot.manifest).toEqual(manifest);
  expect(await new Response(snapshot.body).text()).toBe("{}");
});

it("rejects overlarge, truncated, and out-of-vault manifests", async () => {
  const huge = new Uint8Array([0, 16, 0, 1]); // 1 MiB + 1
  await expect(readArchiveSnapshot(fragmented(huge), vid)).rejects.toThrow("archive_manifest_size");
  await expect(readArchiveSnapshot(fragmented(new Uint8Array([0, 0, 0, 9, 123])), vid)).rejects.toThrow("archive_manifest_truncated");
  await expect(readArchiveSnapshot(fragmented(frame({ ...manifest, files: [{ ...manifest.files[0], key: `vaults/${"b".repeat(64)}/sources/x` }] })), vid)).rejects.toThrow("archive_manifest_path");
});

it("counts the same UTF-8 bytes that its JSON stream emits", async () => {
  const data = { text: "Résumé 😀", rows: Array.from({ length: 200 }, (_, i) => ({ i, text: `東京😀${"x".repeat(500)}` })) };
  const counted = [...exportJsonChunks(data)].reduce((sum, chunk) => sum + encoder.encode(chunk).byteLength, 0);
  const bytes = new Uint8Array(await new Response(exportJsonStream(data)).arrayBuffer());
  expect(bytes.byteLength).toBe(counted);
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(data);
});

it("cancels a pending manifest read and rejects an already-aborted request", async () => {
  let cancelled = 0;
  const response = () => new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => {}); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }));
  const controller = new AbortController();
  const pending = readArchiveSnapshot(response(), vid, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(cancelled).toBe(1);
  await expect(readArchiveSnapshot(response(), vid, controller.signal)).rejects.toThrow();
  expect(cancelled).toBe(2);
});

it("stops awaiting an R2 preflight on abort and avoids starting after abort", async () => {
  const controller = new AbortController();
  let started = 0;
  const pending = archivePreflight(controller.signal, () => { started++; return new Promise(() => {}); });
  controller.abort();
  await expect(pending).rejects.toThrow();
  await expect(archivePreflight(controller.signal, () => { started++; return Promise.resolve(1); })).rejects.toThrow();
  expect(started).toBe(1);
});

it("cancels the JSON source if the request aborts after the manifest", async () => {
  const bytes = frame(manifest).slice(0, -2);
  let cancelled = false, first = true;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (first) { first = false; controller.enqueue(bytes); } else return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const controller = new AbortController();
  const snapshot = await readArchiveSnapshot(response, vid, controller.signal);
  controller.abort();
  expect(cancelled).toBe(true);
  await expect(snapshot.body.getReader().read()).rejects.toThrow();
});

it("does not emit JSON buffered with the manifest after abort or explicit cancellation", async () => {
  for (const mode of ["abort", "cancel"] as const) {
    let cancelled = false, first = true;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (first) { first = false; controller.enqueue(frame(manifest)); } },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    const controller = new AbortController();
    const snapshot = await readArchiveSnapshot(response, vid, controller.signal);
    if (mode === "abort") controller.abort(); else await snapshot.cancel("preflight failed");
    await expect(snapshot.body.getReader().read()).rejects.toThrow();
    expect(cancelled).toBe(true);
  }
});

it("cancels an unconsumed JSON source during preflight failure", async () => {
  const bytes = frame(manifest).slice(0, -2);
  let cancelled = false, first = true;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (first) { first = false; controller.enqueue(bytes); } else return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const snapshot = await readArchiveSnapshot(response, vid);
  await snapshot.cancel("preflight failed");
  expect(cancelled).toBe(true);
});

it("propagates cancellation while a JSON body read is pending", async () => {
  const bytes = frame(manifest).slice(0, -2);
  let cancelled = false, first = true;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (first) { first = false; controller.enqueue(bytes); } else return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const snapshot = await readArchiveSnapshot(response, vid);
  const reader = snapshot.body.getReader();
  const pending = reader.read();
  await reader.cancel("client disconnected");
  expect(cancelled).toBe(true);
  expect((await pending).done).toBe(true);
});
