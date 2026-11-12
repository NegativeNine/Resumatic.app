import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";

afterEach(() => vi.unstubAllGlobals());

it("does not report an upload as successful when the source ID is missing", async () => {
  const keys: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    keys.push((init?.headers as Record<string, string>)["idempotency-key"]!);
    return Response.json(keys.length === 1 ? {} : { sourceId: "source-1" });
  }));
  const file = new File(["resume"], "resume.pdf", { type: "application/pdf" });
  const actionKey = crypto.randomUUID();
  await expect(api.uploadSource(file, actionKey)).rejects.toThrow();
  await expect(api.uploadSource(file, actionKey)).resolves.toEqual({ sourceId: "source-1" });
  expect(keys).toEqual([actionKey, actionKey]);
});

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

it("pastes with the caller's key, so a retry of one action reuses it and a new action does not", async () => {
  const sent: { key: string; path: string; body: unknown; type: string }[] = [];
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      sent.push({ key: headers["idempotency-key"]!, path: String(input), body: JSON.parse(String(init?.body)), type: headers["content-type"]! });
      if (++calls === 1) throw new TypeError("network disconnected");
      return Response.json({ sourceId: "source-1" }, { status: 201 });
    }),
  );
  const body = { text: "Led the Q3 launch.", title: "Q3 review" };
  const actionKey = crypto.randomUUID();
  await expect(api.pasteSource(body, actionKey)).rejects.toThrow("network disconnected");
  await expect(api.pasteSource(body, actionKey)).resolves.toEqual({ sourceId: "source-1" });
  await api.pasteSource(body);
  expect(sent.map((s) => s.key)).toEqual([actionKey, actionKey, expect.any(String)]);
  expect(sent[2]!.key).not.toBe(actionKey);
  expect(sent[0]).toMatchObject({ path: "/api/sources/paste", body, type: "application/json" });
});

it("does not report a paste as added when the source ID is missing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  await expect(api.pasteSource({ text: "Led the Q3 launch." }, crypto.randomUUID())).rejects.toThrow();
});
