import { describe, expect, it, vi } from "vitest";
import { guardedStream } from "../../src/worker/guarded-stream";

describe("guarded downloads", () => {
  it("does not release a chunk if the session is revoked during its read", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        entered();
        await waiting;
        controller.enqueue(new Uint8Array([42]));
      },
      cancel,
    }, { highWaterMark: 0 });
    let valid = true;
    const reader = guardedStream(source, async () => {
      if (!valid) throw new Error("session revoked");
    }).getReader();
    const chunk = reader.read();
    await reading;
    valid = false;
    release();
    await expect(chunk).rejects.toThrow("session revoked");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not start an upstream read when access has already been revoked", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const reader = guardedStream(source, async () => { throw new Error("session revoked"); }).getReader();
    await expect(reader.read()).rejects.toThrow("session revoked");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates client cancellation to the upstream stream", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const reader = guardedStream(source, async () => {}).getReader();
    await reader.cancel("client closed");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("client closed");
  });

  it("bounds checks on a stream that sends only empty chunks", async () => {
    const cancel = vi.fn();
    const check = vi.fn(async () => {});
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array()); },
      cancel,
    }, { highWaterMark: 0 });
    const reader = guardedStream(source, check).getReader();
    await expect(reader.read()).rejects.toThrow("source stream made no progress");
    expect(check).toHaveBeenCalledTimes(34);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
