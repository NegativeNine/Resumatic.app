import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directoryByName, directoryForUser } from "../../src/shared/stubs";

it.each([null, 3])("attributes events in the owning Directory and ignores delivery after deletion starts (shard %s)", async (shard) => {
  const home = directoryByName(env, shard === null ? "global" : `directory-${shard}`);
  const email = `${crypto.randomUUID()}@example.com`;
  const account = await home.signIn({ provider: "test", subject: email, email, hint: "enam", ...(shard === null ? {} : { homeShard: shard }) });
  const routed = directoryForUser(env, account.userId);
  const event = (id: string) => ({ id, type: "customer.subscription.updated", created: 1, livemode: false,
    data: { object: { id: "sub_test", customer: "cus_test" } } });
  await runInDurableObject(routed, async (instance, state) => {
    const local = (instance as unknown as { env: Record<string, unknown> }).env;
    const saved = { ...local };
    Object.assign(local, {
      BILLING_ENABLED: "true",
      BILLING_PLANS_JSON: JSON.stringify({ free: { generationLimit: 3 }, paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }] }),
      STRIPE_SECRET_KEY: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret",
      STRIPE_API_VERSION: "2026-09-30.endive", APP_ORIGIN: "https://app.example.com",
    });
    try {
      // No billing_accounts row exists yet; the Stripe metadata UID still binds the event.
      await instance.acceptBillingEvent(event("evt_before"), account.userId);
      expect(state.storage.sql.exec<{ user_id: string }>("SELECT user_id FROM billing_events WHERE id='evt_before'").one().user_id).toBe(account.userId);
      await instance.deleteAccount(account.userId, account.vaultId);
      // The Worker resolved the UID before deletion but the Directory RPC arrived later.
      await instance.acceptBillingEvent(event("evt_late"), account.userId);
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM billing_events WHERE id='evt_late'").one().n).toBe(0);
      await expect(instance.acceptBillingEvent(event("evt_legacy"))).rejects.toThrow("attribution");
    } finally {
      for (const key of Object.keys(local)) if (!(key in saved)) delete local[key];
      Object.assign(local, saved);
    }
  });
}, 30_000);
