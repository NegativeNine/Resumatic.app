import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";
import { Vault } from "../../src/vault/vault";

describe("billing identifiers during account deletion", () => {
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
