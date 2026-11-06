import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";
import { Vault } from "../../src/vault/vault";

describe("billing identifiers during account deletion", () => {
  it("preserves legacy free usage when an entitlement arrives before the first quota read", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const userId = crypto.randomUUID();
    await stub.init(userId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '2' WHERE key = 'quota_used'");
    });
    const freePlan = {
      planId: "free", generationLimit: 3, bucket: "free:unused",
      validUntil: null, subscriptionId: "sub_test", status: "incomplete" as const, cancelAtPeriodEnd: false,
    };
    await stub.setPlan(1, freePlan);
    expect((await stub.me({ userId, gen: 1 })).quota.used).toBe(2);
    // Re-delivery must not apply the legacy count again.
    await Promise.all([stub.setPlan(2, freePlan), stub.setPlan(3, freePlan), stub.me({ userId, gen: 1 })]);
    expect((await stub.me({ userId, gen: 1 })).quota.used).toBe(2);
  });
  it("rolls back both entitlement and legacy bucket if the usage migration fails", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const userId = crypto.randomUUID();
    await stub.init(userId);
    const freePlan = {
      planId: "free", generationLimit: 3, bucket: "free:unused", validUntil: null,
      subscriptionId: "sub_test", status: "incomplete" as const, cancelAtPeriodEnd: false,
    };
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE meta SET value = '2' WHERE key = 'quota_used'");
      sql.exec("CREATE TRIGGER fail_legacy_quota BEFORE UPDATE OF used ON quota_buckets BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END");
      await expect(instance.setPlan(1, freePlan)).rejects.toThrow("synthetic migration failure");
      expect(sql.exec("SELECT * FROM quota_buckets").toArray()).toEqual([]);
      expect(sql.exec("SELECT value FROM meta WHERE key IN ('entitlement', 'entitlement_revision')").toArray()).toEqual([]);
      sql.exec("DROP TRIGGER fail_legacy_quota");
      await instance.setPlan(1, freePlan);
    });
    expect((await stub.me({ userId, gen: 1 })).quota.used).toBe(2);
  });
  it("preserves an existing bucket when legacy import history is ambiguous", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const userId = crypto.randomUUID();
    await stub.init(userId);
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE meta SET value = '2' WHERE key = 'quota_used'");
      sql.exec("INSERT INTO quota_buckets (bucket_key, start_at, end_at, allowance, used, reserved) VALUES (?, ?, ?, 5, 1, 0)", `free:${month}`, start, end);
    });
    expect((await stub.me({ userId, gen: 1 })).quota.used).toBe(1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE quota_buckets SET used = 3 WHERE bucket_key = ?", `free:${month}`);
    });
    // The old counter may already be included; it must never be added again.
    expect((await stub.me({ userId, gen: 1 })).quota.used).toBe(3);
  });
  it("restores legacy free usage after a paid-to-free transition", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const userId = crypto.randomUUID();
    await stub.init(userId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '2' WHERE key = 'quota_used'");
    });
    const now = Math.floor(Date.now() / 1000);
    await stub.setPlan(1, {
      planId: "pro", generationLimit: 50, bucket: `paid:sub_test:${now - 1}`,
      validUntil: (now + 3600) * 1000, subscriptionId: "sub_test", status: "active", cancelAtPeriodEnd: false,
    });
    expect((await stub.me({ userId, gen: 1 })).quota.used).toBe(0);
    await stub.setPlan(2, {
      planId: "free", generationLimit: 3, bucket: "free:unused", validUntil: null,
      subscriptionId: "sub_test", status: "canceled", cancelAtPeriodEnd: false,
    });
    expect((await stub.me({ userId, gen: 1 })).quota.used).toBe(2);
  });
  it("schedules a future billing retry at its boundary instead of polling each minute", async () => {
    const directory = env.DIRECTORY.getByName(`billing-scheduler-${crypto.randomUUID()}`);
    const due = Date.now() + 3_600_000;
    await runInDurableObject(directory, async (instance, state) => {
      state.storage.sql.exec(`INSERT INTO billing_events (id,customer_id,created_at,next_attempt_at) VALUES ('deferred:in_future','cus_test',?,?)`, Date.now(), due);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(due);
    });
  });
  it("does not spend a future paid bucket that was delivered by older code", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const userId = crypto.randomUUID();
    await stub.init(userId);
    const now = Math.floor(Date.now() / 1000);
    const plan = {
      planId: "pro", generationLimit: 999,
      bucket: `paid:sub_test:${now + 120}`, validUntil: (now + 3600) * 1000,
      subscriptionId: "sub_test", status: "active" as const, cancelAtPeriodEnd: false,
    };
    await stub.setPlan(1, plan);
    expect((await stub.me({ userId, gen: 1 })).quota.limit).not.toBe(999);
    await stub.setPlan(2, { ...plan, bucket: `paid:sub_test:${now - 1}` });
    expect((await stub.me({ userId, gen: 1 })).quota.limit).toBe(999);
  });
  it("fences an in-flight customer create and records its ID after closure", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const userId = crypto.randomUUID();
    await stub.init(userId);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async () => {
      entered();
      await hold;
      return Response.json({ id: "cus_late" });
    });
    try {
      await runInDurableObject(stub, async (instance) => {
        const local = (instance as unknown as { env: Record<string, unknown> }).env;
        const saved = { ...local };
        Object.assign(local, {
          BILLING_ENABLED: "true",
          BILLING_PLANS_JSON: JSON.stringify({ free: { generationLimit: 3 }, paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }] }),
          STRIPE_SECRET_KEY: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret",
          STRIPE_API_VERSION: "2026-09-30.endive", APP_ORIGIN: "https://app.example.com",
        });
        try {
          const opening = instance.billingCheckout({ userId, gen: 1 }, "pro", "test-key");
          const outcome = opening.then(() => null, (error: Error) => error);
          await ready;
          await expect(instance.close()).rejects.toThrow("customer creation is unresolved");
          await expect(instance.destroy()).rejects.toThrow("customer creation is unresolved");
          release();
          expect(await outcome).toBeInstanceOf(Error);
          expect(await instance.billingCustomerForDeletion()).toBe("cus_late");
          await expect(instance.close()).resolves.toBeDefined();
        } finally {
          release();
          for (const key of Object.keys(local)) if (!(key in saved)) delete local[key];
          Object.assign(local, saved);
        }
      });
    } finally { release(); vi.unstubAllGlobals(); }
  });

  it("keeps deletion recovery fenced when its customer response is lost", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init(crypto.randomUUID());
    vi.stubGlobal("fetch", async () => { throw new Error("synthetic lost response"); });
    try {
      await runInDurableObject(stub, async (instance, state) => {
        const local = (instance as unknown as { env: Record<string, unknown> }).env;
        const saved = { ...local };
        Object.assign(local, {
          BILLING_PLANS_JSON: JSON.stringify({ free: { generationLimit: 3 }, paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }] }),
          STRIPE_SECRET_KEY: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret",
          STRIPE_API_VERSION: "2026-09-30.endive", APP_ORIGIN: "https://app.example.com",
        });
        state.storage.sql.exec("INSERT INTO meta (key,value) VALUES ('billing_customer_requested','1'), ('billing_customer_requested_at',?)", String(Date.now()));
        try {
          await instance.close();
          await expect(instance.billingCustomerForDeletion()).rejects.toThrow();
          await expect(instance.destroy()).rejects.toThrow("customer creation is unresolved");
        } finally {
          for (const key of Object.keys(local)) if (!(key in saved)) delete local[key];
          Object.assign(local, saved);
        }
      });
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps exact checkout IDs across a lost Vault destruction acknowledgement", async () => {
    const d = env.DIRECTORY.getByName(`billing-delete-${crypto.randomUUID()}`);
    const email = `${crypto.randomUUID()}@example.com`;
    const account = await d.signIn({ provider: "test", subject: email, email, hint: "enam" });
    const stub = vault(env, account.vaultId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO meta (key,value) VALUES ('stripe_customer','cus_test'), ('billing_checkout_sessions','["cs_test_late"]')`);
    });
    let open = true, directChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (path === "/v1/checkout/sessions/cs_test_late/expire") { open = false; return Response.json({}); }
      if (path === "/v1/checkout/sessions/cs_test_late") { directChecks++; return Response.json({ id: "cs_test_late", status: open ? "open" : "expired", expires_at: 2_000_000_000, url: null }); }
      if (path === "/v1/checkout/sessions" || path === "/v1/subscriptions") return Response.json({ data: [], has_more: false });
      throw new Error(`unexpected Stripe path: ${path}`);
    });
    const original = Vault.prototype.destroy;
    const lost = vi.spyOn(Vault.prototype, "destroy").mockImplementationOnce(async function (this: Vault) {
      await original.call(this);
      throw new Error("synthetic lost destruction acknowledgement");
    });
    try {
      await d.deleteAccount(account.userId, account.vaultId);
      await runInDurableObject(d, async (instance, state) => {
        const local = (instance as unknown as { env: Record<string, unknown> }).env;
        const saved = { ...local };
        Object.assign(local, {
          BILLING_PLANS_JSON: JSON.stringify({ free: { generationLimit: 3 }, paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }] }),
          STRIPE_SECRET_KEY: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret",
          STRIPE_API_VERSION: "2026-09-30.endive", APP_ORIGIN: "https://app.example.com", SWEEP_DELAY_MS: "0",
        });
        try {
          await instance.alarm();
          expect(state.storage.sql.exec<{ stripe_checkout_sessions: string }>(`SELECT stripe_checkout_sessions FROM vaults WHERE vault_id=?`, account.vaultId).one().stripe_checkout_sessions).toBe('["cs_test_late"]');
          await instance.alarm();
          expect(directChecks).toBeGreaterThanOrEqual(3);
          expect(open).toBe(false);
        } finally {
          for (const key of Object.keys(local)) if (!(key in saved)) delete local[key];
          Object.assign(local, saved);
        }
      });
    } finally { lost.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("blocks Vault destruction while a checkout create is unresolved", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const userId = crypto.randomUUID();
    await stub.init(userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Record<string, unknown> }).env;
      const saved = { ...local };
      Object.assign(local, {
        BILLING_ENABLED: "true",
        BILLING_PLANS_JSON: JSON.stringify({ free: { generationLimit: 3 }, paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }] }),
        STRIPE_SECRET_KEY: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret",
        STRIPE_API_VERSION: "2026-09-30.endive", APP_ORIGIN: "https://app.example.com",
      });
      try {
        const coordinator = (instance as unknown as { checkoutCoordinator(who: { userId: string; gen: number }): { hooks: { beginCheckoutDispatch(): void; settleCheckoutDispatch(id: string): void } } }).checkoutCoordinator({ userId, gen: 1 });
        coordinator.hooks.beginCheckoutDispatch();
        coordinator.hooks.beginCheckoutDispatch();
        await expect(instance.close()).rejects.toThrow("checkout creation is unresolved");
        await expect(instance.destroy()).rejects.toThrow("checkout creation is unresolved");
        coordinator.hooks.settleCheckoutDispatch("cs_test_1");
        await expect(instance.close()).rejects.toThrow("checkout creation is unresolved");
        coordinator.hooks.settleCheckoutDispatch("cs_test_2");
        expect(instance.billingCheckoutSessionsForDeletion()).toEqual(["cs_test_1", "cs_test_2"]);
        await expect(instance.close()).resolves.toBeDefined();
        await expect(instance.destroy()).resolves.toBeUndefined();
      } finally {
        for (const key of Object.keys(local)) if (!(key in saved)) delete local[key];
        Object.assign(local, saved);
      }
    });
  });
  it("leaves an old unknown customer creation pending without replaying a pruned key", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO meta (key,value) VALUES ('billing_customer_requested','1'), ('billing_customer_requested_at',?)",
        String(Date.now() - 86_400_000),
      );
    });
    await stub.close();
    const failure = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.billingCustomerForDeletion();
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(failure).toContain("operator reconciliation");
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT value FROM meta WHERE key = 'billing_customer_requested'")
        .toArray(),
    );
    expect(rows).toEqual([{ value: "1" }]);
  });

  it("retains a known customer on a closed vault and treats timestamp-less uncertainty as pending", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec(
          "INSERT INTO meta (key,value) VALUES ('billing_customer_requested','1')",
        )
        .toArray(),
    );
    await stub.close();
    const failure = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.billingCustomerForDeletion();
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(failure).toContain("operator reconciliation");
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec(
          "INSERT INTO meta (key,value) VALUES ('stripe_customer','cus_recovered')",
        )
        .toArray(),
    );
    expect(await stub.billingCustomerForDeletion()).toBe("cus_recovered");
  });
});
