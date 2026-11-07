import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationKeys } from "../../src/web/generation-keys";

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

describe("generation retry keys", () => {
  it("reuses an uncertain request across reloads without storing its input text", async () => {
    const values = storage();
    const body = { jdText: "Private career and job text" };
    const first = await new GenerationKeys().acquire("/api/v2/applications", body);
    const second = await new GenerationKeys().acquire("/api/v2/applications", body);
    expect(second).toEqual(first);
    expect([...values.keys(), ...values.values()].join(" ")).not.toContain(body.jdText);
    expect((await new GenerationKeys().acquire("/api/v2/applications", { jdText: "Another job" })).key).not.toBe(first.key);
    const instance = new GenerationKeys();
    const recovered = await instance.acquire("/api/v2/applications", body);
    instance.acknowledge(recovered.fingerprint, recovered.key);
    expect((await new GenerationKeys().acquire("/api/v2/applications", body)).key).not.toBe(first.key);
  });

  it("uses one key for simultaneous identical actions", async () => {
    storage();
    const instance = new GenerationKeys();
    const [first, second] = await Promise.all([
      instance.acquire("/api/documents", { kind: "letter" }),
      instance.acquire("/api/documents", { kind: "letter" }),
    ]);
    expect(second).toEqual(first);
  });

  it("preserves the current key if an older result is acknowledged", async () => {
    storage();
    const instance = new GenerationKeys();
    const current = await instance.acquire("/api/documents", { kind: "letter" });
    instance.acknowledge(current.fingerprint, crypto.randomUUID());
    expect(await instance.acquire("/api/documents", { kind: "letter" })).toEqual(current);
  });

  it("does not reuse an acknowledged key when storage refuses removal", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: () => { throw new Error("disabled"); },
    });
    const instance = new GenerationKeys();
    const first = await instance.acquire("/api/documents", { kind: "letter" });
    instance.acknowledge(first.fingerprint, first.key);
    expect((await instance.acquire("/api/documents", { kind: "letter" })).key).not.toBe(first.key);
  });

  it("keeps retries in memory when tab storage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("disabled"); },
      setItem: () => { throw new Error("disabled"); },
      removeItem: () => { throw new Error("disabled"); },
    });
    const instance = new GenerationKeys();
    const first = await instance.acquire("/api/resumes", undefined);
    expect(await instance.acquire("/api/resumes", undefined)).toEqual(first);
    expect(() => instance.acknowledge(first.fingerprint, first.key)).not.toThrow();
    expect((await instance.acquire("/api/resumes", undefined)).key).not.toBe(first.key);
  });
});
