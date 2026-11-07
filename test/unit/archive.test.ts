import { describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { createArchive, type ArchiveEntry } from "../../src/render/archive";

const bytes = (value: string) => new TextEncoder().encode(value);
function entry(name: string, value: string): ArchiveEntry {
  const data = bytes(value);
  return { name, size: data.length, open: async () => new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }) };
}
const collect = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

describe("portable ZIP writer", () => {
  it("writes interoperable UTF-8 ZIP members and standard CRC32", async () => {
    const data = await collect(createArchive([entry("vault.json", "123456789"), entry("sources/resume-é.pdf", "source text"), entry("empty", "")]));
    const files = unzipSync(data);
    expect(Object.keys(files).sort()).toEqual(["empty", "sources/resume-é.pdf", "vault.json"]);
    expect(strFromU8(files["vault.json"]!)).toBe("123456789");
    expect(strFromU8(files["sources/resume-é.pdf"]!)).toBe("source text");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const descriptor = 30 + bytes("vault.json").length + 9;
    expect(view.getUint32(descriptor, true)).toBe(0x08074b50);
    expect(view.getUint32(descriptor + 4, true)).toBe(0xcbf43926);
  });

  it("rejects unsafe or duplicate names and excess declared size before reading", () => {
    for (const name of ["", "../secret", "/absolute", "sources/../secret", "a\\b", "a//b", "C:thing", "bad\0name"]) {
      expect(() => createArchive([entry(name, "x")])).toThrow();
    }
    expect(() => createArchive([entry("same", "x"), entry("same", "y")])).toThrow();
    expect(() => createArchive([entry("one", "1234")], { maxBytes: 3 })).toThrow();
    expect(() => createArchive([entry("one", "1")], { maxEntries: 0 })).toThrow();
  });

  it("rejects streams that do not match the snapshot size and fails the download", async () => {
    for (const claimed of [2, 4]) {
      const file = entry("one", "123");
      file.size = claimed;
      await expect(collect(createArchive([file]))).rejects.toThrow("size changed");
    }
    await expect(collect(createArchive([{ name: "missing", size: 0, open: async () => { throw new Error("missing object"); } }]))).rejects.toThrow("missing object");
  });

  it("opens sources lazily and cancels an active source on client cancellation", async () => {
    let canceled = 0;
    let reads = 0;
    const open = vi.fn(async () => new ReadableStream<Uint8Array>({
      pull(c) { reads++; c.enqueue(bytes("x")); },
      cancel() { canceled++; },
    }, { highWaterMark: 0 }));
    const archive = createArchive([{ name: "one", size: 100, open }]);
    expect(open).not.toHaveBeenCalled();
    const reader = archive.getReader();
    await reader.read(); // local header
    await reader.read(); // filename
    expect(open).not.toHaveBeenCalled();
    await reader.read(); // first source chunk
    expect(open).toHaveBeenCalledOnce();
    expect(reads).toBe(1);
    await reader.cancel();
    expect(canceled).toBe(1);
  });

  it("does not block cancellation on an unresolved object open and cancels it if it arrives late", async () => {
    let resolve!: (value: ReadableStream<Uint8Array>) => void;
    let canceled = 0;
    const pending = new Promise<ReadableStream<Uint8Array>>((r) => { resolve = r; });
    const open = vi.fn(() => pending);
    const reader = createArchive([{ name: "one", size: 1, open }]).getReader();
    await reader.read(); await reader.read();
    const reading = reader.read();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    await reader.cancel();
    resolve(new ReadableStream<Uint8Array>({ cancel() { canceled++; } }, { highWaterMark: 0 }));
    await reading;
    await vi.waitFor(() => expect(canceled).toBe(1));
  });

  it("errors on an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(createArchive([entry("one", "hello")], { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("interrupts an outstanding source read when the signal aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const pull = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const reader = createArchive([{ name: "one", size: 1, open: async () => source }], { signal: controller.signal }).getReader();
    await reader.read(); await reader.read();
    const pending = reader.read();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
