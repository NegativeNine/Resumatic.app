import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PILOT_LEDGER_NAME } from "../../src/worker/pilot/ledger";
import { app } from "../../src/worker/routes";
import { call } from "./support";

const root = "/auth/test/pilot-budget";
const key = "test-pilot-key-for-local-only-1234567890";
const post = (path: string, body?: unknown, suppliedKey = key) => call(`${root}/${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-pilot-budget-key": suppliedKey },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("staging pilot budget coordinator", () => {
  it("shares one durable, bounded ledger between HTTP and Durable Object callers", async () => {
    const status = () => call(`${root}/status`, { headers: { "x-pilot-budget-key": key } });
    expect((await status()).status).toBe(200);
    expect((await post("initialize", { maxMicros: 1000, maxCalls: 10 }, "wrong")).status).toBe(403);
    expect((await post("initialize", { maxMicros: 10_000_001, maxCalls: 50 })).status).toBe(422);
    expect((await post("initialize", { maxMicros: 1000, maxCalls: 10 })).status).toBe(204);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      post("reserve", { id: `attempt-${i}`, micros: 100, calls: 1 }),
    ));
    // Parallel callers cannot dispatch behind an unresolved provider attempt.
    expect(responses.filter((r) => r.status === 204)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 503)).toHaveLength(19);
    const successful = responses.findIndex((r) => r.status === 204);
    expect((await post("reserve", { id: `attempt-${successful}`, micros: 100, calls: 1 })).status).toBe(409);
    let pendingId = `attempt-${successful}`;
    for (let i = 1; i < 10; i++) {
      expect((await post("settle", { id: pendingId, actualMicros: 90 })).status).toBe(200);
      pendingId = `serial-${i}`;
      expect((await post("reserve", { id: pendingId, micros: 100, calls: 1 })).status).toBe(204);
    }
    // Reinitialization cannot clear earlier reservations, even from a fresh stub.
    expect((await post("initialize", { maxMicros: 1000, maxCalls: 10 })).status).toBe(204);
    expect((await post("initialize", { maxMicros: 1001, maxCalls: 10 })).status).toBe(409);
    const shared = env.PILOT_BUDGET!.getByName(PILOT_LEDGER_NAME);
    expect(await shared.status()).toMatchObject({ initialized: true, reservedMicros: 1000, reservedCalls: 10, pending: 1 });
    const getAttempts = (suppliedKey: string) => call(`${root}/attempts`, { headers: { "x-pilot-budget-key": suppliedKey } });
    expect((await getAttempts("wrong")).status).toBe(403);
    const auditResponse = await getAttempts(key);
    expect(auditResponse.status).toBe(200);
    expect(auditResponse.headers.get("cache-control")).toBe("no-store");
    const body = await auditResponse.json() as { totals: unknown; attempts: { idMac: string; state: string; reservedMicros: number; reservedCalls: number; actualMicros: number | null }[] };
    expect(body.totals).toEqual({ maxMicros: 1000, maxCalls: 10, reservedMicros: 1000, reservedCalls: 10,
      frozen: false, count: 10, pending: 1, unknown: 0, overrun: 0 });
    expect(body.attempts).toHaveLength(10);
    expect(body.attempts.every((a) => /^[0-9a-f]{64}$/.test(a.idMac) &&
      a.reservedMicros === 100 && a.reservedCalls === 1 &&
      (a.state === "pending" ? a.actualMicros === null : a.state === "settled" && a.actualMicros === 90))).toBe(true);
    expect(JSON.stringify(body)).not.toContain("attempt-");
    const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bytes = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`resumatic-pilot-attempt-v1:attempt-${successful}`));
    const mac = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(body.attempts.map((a) => a.idMac)).toContain(mac);
    await evictDurableObject(shared);
    expect(await env.PILOT_BUDGET!.getByName(PILOT_LEDGER_NAME).status()).toMatchObject({
      initialized: true, reservedMicros: 1000, reservedCalls: 10, pending: 1,
    });
    expect((await post("settle", { id: pendingId, actualMicros: null })).status).toBe(200);
    expect(await (await status()).json()).toMatchObject({ frozen: true, unknown: 1, reservedMicros: 1000, reservedCalls: 10 });
    expect((await post("reserve", { id: "after-freeze", micros: 1, calls: 1 })).status).toBe(503);
    expect((await post("reserve", { id: "bad", micros: 1, calls: 1, payload: "career text" })).status).toBe(422);
  });

  it("does not expose the coordinator when staging test mode is disabled", async () => {
    for (const route of ["status", "attempts"]) {
      const response = await app.fetch(
        new Request(`https://resumatic.test/auth/test/pilot-budget/${route}`, { headers: { "x-pilot-budget-key": key } }),
        { ...env, ALLOW_TEST_SIGNIN: "false" } as Env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      );
      expect(response.status).toBe(404);
    }
  });
});
