import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setModels } from "../../src/ai/models";
import { vault } from "../../src/shared/stubs";
import { fakeModels, signIn, type FakeModelOptions, type User } from "./support";

let options: FakeModelOptions;
beforeEach(() => {
  options = { calls: {} };
  setModels(() => fakeModels(options));
});
afterEach(() => setModels(null));

const body = { roleId: null, kind: "accomplishment" as const, text: "Built an accessible application", level: null };
function create(user: User, key: string, input = body): Promise<Response> {
  return user.fetch("/api/v2/facts", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
}

describe("manual fact request idempotency", () => {
  it("replays a committed fact without a new embedding and rejects changed input", async () => {
    const user = await signIn();
    const first = await create(user, "manual-request", body);
    expect(first.status).toBe(201);
    const saved = await first.json();
    expect(options.calls?.embed).toBe(1);
    const retry = await create(user, "manual-request", body);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(saved);
    expect(options.calls?.embed).toBe(1);
    const changed = await create(user, "manual-request", { ...body, text: "Built a different application" });
    expect(changed.status).toBe(409);
    expect(options.calls?.embed).toBe(1);
    expect((await user.json("/api/facts")).facts).toHaveLength(1);

    // A fresh key is a distinct user action, even when its wording is identical.
    const second = await create(user, "another-request", body);
    expect(second.status).toBe(201);
    expect((await second.json() as { factId: string }).factId).not.toBe((saved as { factId: string }).factId);
    expect((await user.json("/api/facts")).facts).toHaveLength(2);
  });

  it("deduplicates concurrent identical requests after the embedding await", async () => {
    let release!: () => void;
    let bothStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const base = fakeModels(options);
    let calls = 0;
    setModels(() => ({
      ...base,
      async embed(texts, opts) {
        if (++calls === 2) bothStarted();
        await gate;
        return base.embed(texts, opts);
      },
    }));
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "manual-fact-race", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const a = instance.addFactIdempotent(who, body, "concurrent-request");
      const b = instance.addFactIdempotent(who, body, "concurrent-request");
      try {
        await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("both requests did not reach embedding")), 5000))]);
      } finally { release(); }
      const [first, second] = await Promise.all([a, b]);
      expect(first).toEqual(second);
      expect(await instance.listFacts(who)).toHaveLength(1);
    });
  });

  it("commits only one of two different facts competing for the same key", async () => {
    let release!: () => void, bothStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const base = fakeModels(options);
    let calls = 0;
    setModels(() => ({
      ...base,
      async embed(texts, opts) {
        if (++calls === 2) bothStarted();
        await gate;
        return base.embed(texts, opts);
      },
    }));
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "manual-fact-conflict", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const a = instance.addFactIdempotent(who, body, "same-key");
      const b = instance.addFactIdempotent(who, { ...body, text: "Built a different application" }, "same-key");
      try {
        await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("both requests did not reach embedding")), 5000))]);
      } finally { release(); }
      const results = await Promise.allSettled([a, b]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(failures).toHaveLength(1);
      expect(String(failures[0]!.reason)).toContain("this fact request changed");
      expect(await instance.listFacts(who)).toHaveLength(1);
    });
  });

  it("scopes keys to the vault and preserves the legacy route", async () => {
    const alice = await signIn(), bob = await signIn();
    const [a, b] = await Promise.all([create(alice, "same-key"), create(bob, "same-key")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await a.json() as { factId: string }).factId).not.toBe((await b.json() as { factId: string }).factId);
    expect((await alice.send("POST", "/api/facts", { ...body, text: "Legacy client fact" })).status).toBe(201);
  });
});
