import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";

const BILLING = {
  BILLING_PLANS_JSON: JSON.stringify({ free: { generationLimit: 3 }, paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }] }),
  STRIPE_SECRET_KEY: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret",
  STRIPE_API_VERSION: "2026-09-30.endive", APP_ORIGIN: "https://app.example.com",
};

async function account(d: ReturnType<typeof env.DIRECTORY.getByName>) {
  const email = `${crypto.randomUUID()}@example.com`;
  return d.signIn({ provider: "test", subject: email, email, hint: "enam" });
}

async function pendingSource(vaultId: string, customer?: string) {
  const stub = vault(env, vaultId);
  const attempt = crypto.randomUUID();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO r2_cache_dispatches(attempt_id,kind,created_at) VALUES (?, 'source', ?)`, attempt, Date.now());
    if (customer) state.storage.sql.exec(`INSERT INTO meta(key,value) VALUES ('stripe_customer', ?)`, customer);
  });
  const key = `vaults/${vaultId}/sources/synthetic`;
  await env.FILES.put(key, "synthetic source");
  return { stub, attempt, key };
}

function subscription(status: "active" | "canceled") {
  return { id: "sub_test", customer: "cus_test", status, items: { data: [{ price: { id: "price_pro" } }], has_more: false } };
}

afterEach(() => vi.unstubAllGlobals());

describe("preliminary account cleanup", () => {
  it("sweeps a deleting account while an unrelated billing inbox read is stalled", async () => {
    const d = env.DIRECTORY.getByName(`preliminary-${crypto.randomUUID()}`);
    const active = await account(d), deleting = await account(d);
    const pending = await pendingSource(deleting.vaultId);
    await d.deleteAccount(deleting.userId, deleting.vaultId);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = new URL(typeof request === "string" ? request : request.toString());
      if (url.pathname !== "/v1/customers/cus_unrelated") throw new Error("unexpected synthetic Stripe request");
      entered(); await hold;
      throw new Error("synthetic unavailable");
    });
    await runInDurableObject(d, async (instance, state) => {
      const local = (instance as unknown as { env: Record<string, unknown> }).env;
      const old = { ...local };
      Object.assign(local, BILLING, { BILLING_ENABLED: "true" });
      state.storage.sql.exec(
        `INSERT INTO billing_events(id,customer_id,user_id,created_at) VALUES ('evt_held','cus_unrelated',?,1)`, active.userId,
      );
      const running = instance.alarm();
      try {
        await ready;
        for (let i = 0; i < 100 && await env.FILES.head(pending.key); i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await env.FILES.head(pending.key)).toBeNull();
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, deleting.vaultId).one().state).toBe("deleting");
        expect((await vault(env, deleting.vaultId).deletionProbe()).rows).toBeGreaterThan(0);
        expect(state.storage.sql.exec(`SELECT id FROM billing_events WHERE id='evt_held'`).toArray()).toHaveLength(1);
      } finally {
        release(); await running;
        for (const key of Object.keys(local)) if (!(key in old)) delete local[key];
        Object.assign(local, old);
      }
    });
  }, 30_000);

  it("repeatedly deletes known Workflow instances without settling an uncertain create", async () => {
    const d = env.DIRECTORY.getByName(`preliminary-${crypto.randomUUID()}`);
    const user = await account(d);
    const stub = vault(env, user.vaultId);
    const ids = { distill: crypto.randomUUID(), tailor: crypto.randomUUID(), future: crypto.randomUUID(), letter: crypto.randomUUID() };
    await runInDurableObject(stub, (_instance, state) => {
      for (const [kind, id] of Object.entries(ids)) state.storage.sql.exec(
        `INSERT INTO runs (id,kind,target_id,request_key,input_digest,state,steps,credit_state,created_at,updated_at)
         VALUES (?, ?, ?, ?, 'digest', 'running', '[]', 'none', 1, 1)`,
        id, kind, id, id,
      );
      state.storage.sql.exec(`INSERT INTO workflow_dispatches(run_id) VALUES (?)`, ids.distill);
    });
    await runInDurableObject(stub, (instance) => {
      expect(() => instance.knownRunsForDeletion()).toThrow(/vault must be closed/);
    });
    let lateVisible = false;
    const deleted: string[] = [];
    const binding = (kind: "distill" | "tailor" | "letter") => ({ get: async (id: string) => {
      if (deleted.includes(id) || (kind === "distill" && !lateVisible)) throw new Error(`Workflow instance ${id} not found`);
      return { status: async () => ({ status: "running" }), terminate: async () => {}, delete: async () => { deleted.push(id); } };
    } });
    await d.deleteAccount(user.userId, user.vaultId);
    await runInDurableObject(d, async (instance, state) => {
      const local = (instance as unknown as { env: Record<string, unknown> }).env;
      const old = { ...local };
      Object.assign(local, { DISTILL: binding("distill"), TAILOR: binding("tailor"), DOCUMENTS: binding("letter") });
      try {
        await instance.alarm();
        // Even an unknown run kind does not prevent cleanup of a later known kind.
        expect(deleted.sort()).toEqual([ids.tailor, ids.letter].sort());
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("deleting");
        lateVisible = true;
        await instance.alarm();
        expect(deleted).toContain(ids.distill);
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("deleting");
      } finally {
        for (const key of Object.keys(local)) if (!(key in old)) delete local[key];
        Object.assign(local, old);
      }
    });
    await runInDurableObject(stub, (_vault, state) => {
      expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id=?`, ids.distill).toArray()).toHaveLength(1);
    });
  }, 30_000);

  it("cancels known billing and repeatedly sweeps visible files while an uncertain write keeps deletion pending", async () => {
    const d = env.DIRECTORY.getByName(`preliminary-${crypto.randomUUID()}`);
    const user = await account(d);
    const { attempt, key } = await pendingSource(user.vaultId, "cus_test");
    let canceled = false;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof request === "string" ? request : request.toString());
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ data: [], has_more: false });
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: canceled ? [] : [subscription("active")], has_more: false });
      if (url.pathname === "/v1/subscriptions/sub_test" && init?.method === "DELETE") { canceled = true; return Response.json(subscription("canceled")); }
      if (url.pathname === "/v1/subscriptions/sub_test") return Response.json(subscription(canceled ? "canceled" : "active"));
      throw new Error("unexpected synthetic Stripe request");
    });
    await d.deleteAccount(user.userId, user.vaultId);
    await runInDurableObject(d, async (instance, state) => {
      const local = (instance as unknown as { env: Record<string, unknown> }).env;
      const old = { ...local };
      Object.assign(local, BILLING);
      try {
        // An unresolved initialization remains a destruction fence, but must
        // not block independent cleanup of already-known billing and objects.
        state.storage.sql.exec(`INSERT INTO vault_initializations(vault_id,sticky) VALUES (?,0)`, user.vaultId);
        await instance.alarm();
        expect(canceled).toBe(true);
        expect(await env.FILES.head(key)).toBeNull();
        expect(state.storage.sql.exec<{ state: string; stripe_customer: string }>(`SELECT state,stripe_customer FROM vaults WHERE vault_id=?`, user.vaultId).one()).toEqual({ state: "deleting", stripe_customer: "cus_test" });
        expect(state.storage.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id=?`, user.vaultId).toArray()).toHaveLength(1);
        expect((await vault(env, user.vaultId).deletionProbe()).rows).toBeGreaterThan(0);
        state.storage.sql.exec(`DELETE FROM vault_initializations WHERE vault_id=?`, user.vaultId);
        // A late put can still arrive. The next alarm removes it but must not
        // treat the provisional sweep as proof that the write has settled.
        await env.FILES.put(key, "late synthetic source");
        await instance.alarm();
        expect(await env.FILES.head(key)).toBeNull();
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("deleting");
        // Stand in for the originating Vault observing its own put ACK.
        await runInDurableObject(vault(env, user.vaultId), (_vault, vaultState) => {
          vaultState.storage.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, attempt);
        });
        await instance.alarm();
        const remaining = state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).toArray();
        // The configured second sweep may also remove the Directory row in
        // the same alarm; neither outcome is allowed before fence settlement.
        expect(remaining.length === 0 || remaining[0]?.state === "swept").toBe(true);
        expect(await env.FILES.head(key)).toBeNull();
      } finally {
        for (const key of Object.keys(local)) if (!(key in old)) delete local[key];
        Object.assign(local, old);
      }
    });
  }, 30_000);

  it("does not start customer creation while an unrelated fence prevents close", async () => {
    const d = env.DIRECTORY.getByName(`preliminary-${crypto.randomUUID()}`);
    const user = await account(d);
    const { stub, key } = await pendingSource(user.vaultId);
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(
      `INSERT INTO meta(key,value) VALUES ('billing_customer_requested','1'), ('billing_customer_requested_at',?)`, String(Date.now()),
    ));
    const fetcher = vi.fn(async () => { throw new Error("unexpected customer creation"); });
    vi.stubGlobal("fetch", fetcher);
    await d.deleteAccount(user.userId, user.vaultId);
    await runInDurableObject(d, async (instance, state) => {
      await instance.alarm();
      expect(fetcher).not.toHaveBeenCalled();
      expect(await env.FILES.head(key)).toBeNull();
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("deleting");
    });
  }, 30_000);

  it("cancels known billing even when the preliminary R2 listing fails", async () => {
    const d = env.DIRECTORY.getByName(`preliminary-${crypto.randomUUID()}`);
    const user = await account(d);
    await pendingSource(user.vaultId, "cus_test");
    let canceled = false;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof request === "string" ? request : request.toString());
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ data: [], has_more: false });
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: canceled ? [] : [subscription("active")], has_more: false });
      if (url.pathname === "/v1/subscriptions/sub_test" && init?.method === "DELETE") { canceled = true; return Response.json(subscription("canceled")); }
      if (url.pathname === "/v1/subscriptions/sub_test") return Response.json(subscription(canceled ? "canceled" : "active"));
      throw new Error("unexpected synthetic Stripe request");
    });
    await d.deleteAccount(user.userId, user.vaultId);
    await runInDurableObject(d, async (instance, state) => {
      const local = (instance as unknown as { env: Record<string, unknown> }).env;
      const old = { ...local };
      Object.assign(local, BILLING, { FILES: { list: async () => { throw new Error("synthetic R2 unavailable"); } } });
      try {
        await instance.alarm();
        expect(canceled).toBe(true);
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("deleting");
      } finally {
        for (const key of Object.keys(local)) if (!(key in old)) delete local[key];
        Object.assign(local, old);
      }
    });
  }, 30_000);

  it("starts other vaults and the provisional sweep while one billing request is held", async () => {
    const d = env.DIRECTORY.getByName(`preliminary-${crypto.randomUUID()}`);
    const first = await account(d), second = await account(d);
    const pending = await pendingSource(first.vaultId, "cus_test");
    const secondKey = `vaults/${second.vaultId}/sources/synthetic`;
    await env.FILES.put(secondKey, "other synthetic source");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async () => { entered(); await hold; throw new Error("synthetic unavailable"); });
    await d.deleteAccount(first.userId, first.vaultId);
    await d.deleteAccount(second.userId, second.vaultId);
    await runInDurableObject(d, async (instance, state) => {
      const local = (instance as unknown as { env: Record<string, unknown> }).env;
      const old = { ...local };
      Object.assign(local, BILLING);
      const running = instance.alarm();
      try {
        await ready;
        let secondState = "";
        for (let i = 0; i < 100; i++) {
          secondState = state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, second.vaultId).one().state;
          if (secondState === "swept" && !(await env.FILES.head(pending.key))) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(secondState).toBe("swept");
        expect(await env.FILES.head(pending.key)).toBeNull();
        expect(await env.FILES.head(secondKey)).toBeNull();
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, first.vaultId).one().state).toBe("deleting");
      } finally {
        release();
        await running;
        for (const key of Object.keys(local)) if (!(key in old)) delete local[key];
        Object.assign(local, old);
      }
    });
  }, 30_000);
});
