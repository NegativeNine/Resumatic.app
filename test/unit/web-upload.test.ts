import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";

afterEach(() => vi.unstubAllGlobals());

it("reuses the explicit action key after a lost response; a new upload gets a fresh key", async () => {
  const keys: string[] = [];
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["idempotency-key"]!);
      if (++calls === 1) throw new TypeError("network disconnected");
      return new Response(JSON.stringify({ sourceId: "source-1" }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const file = new File(["same content"], "resume.pdf", {
    type: "application/pdf",
  });
  const actionKey = crypto.randomUUID();
  await expect(api.uploadSource(file, actionKey)).rejects.toThrow(
    "network disconnected",
  );
  await expect(api.uploadSource(file, actionKey)).resolves.toEqual({
    sourceId: "source-1",
  });
  await api.uploadSource(file);
  expect(keys[0]).toBe(actionKey);
  expect(keys[1]).toBe(actionKey);
  expect(keys[2]).not.toBe(actionKey);
});
