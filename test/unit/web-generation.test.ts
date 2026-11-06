import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";

afterEach(() => vi.unstubAllGlobals());

describe("generation request keys", () => {
  it("keeps an uncertain key through a rate-limited retry, then clears it on success", async () => {
    const keys: string[] = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["idempotency-key"]!);
      call++;
      if (call === 1) throw new TypeError("connection lost");
      if (call === 2) return Response.json({ error: "quota", message: "try again" }, { status: 429 });
      return Response.json({ resumeId: "resume" });
    }));
    const application = crypto.randomUUID();
    await expect(api.tailor(application)).rejects.toThrow("connection lost");
    await expect(api.tailor(application)).rejects.toThrow("try again");
    await expect(api.tailor(application)).resolves.toEqual({ resumeId: "resume" });
    await expect(api.tailor(application)).resolves.toEqual({ resumeId: "resume" });
    expect(keys[0]).toBeTruthy();
    expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("does not clear a key on a 4xx while another attempt is still unresolved", async () => {
    const keys: string[] = [];
    let rejectFirst!: (error: Error) => void;
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["idempotency-key"]!);
      call++;
      if (call === 1) return await new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
      if (call === 2) return Response.json({ error: "quota", message: "try again" }, { status: 429 });
      return Response.json({ resumeId: "resume" });
    }));
    const application = crypto.randomUUID();
    const first = api.tailor(application);
    const firstFailure = expect(first).rejects.toThrow("connection lost");
    await expect(api.tailor(application)).rejects.toThrow("try again");
    rejectFirst(new TypeError("connection lost"));
    await firstFailure;
    await expect(api.tailor(application)).resolves.toEqual({ resumeId: "resume" });
    expect(keys).toEqual([keys[0], keys[0], keys[0]]);
  });

  it("retains the action key after an initial client error", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["idempotency-key"]!);
      return keys.length === 1
        ? Response.json({ error: "invalid", message: "invalid input" }, { status: 400 })
        : Response.json({ resumeId: "resume" });
    }));
    const application = crypto.randomUUID();
    await expect(api.tailor(application)).rejects.toThrow("invalid input");
    await expect(api.tailor(application)).resolves.toEqual({ resumeId: "resume" });
    expect(keys[1]).toBe(keys[0]);
  });
});
