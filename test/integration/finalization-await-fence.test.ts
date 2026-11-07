import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";

const billing = {
  BILLING_PLANS_JSON: JSON.stringify({ free: { generationLimit: 3 }, paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }] }),
  STRIPE_SECRET_KEY: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret",
  STRIPE_API_VERSION: "2026-09-30.endive", APP_ORIGIN: "https://app.example.com",
};

async function account(home: ReturnType<typeof env.DIRECTORY.getByName>) {
  const email = `${crypto.randomUUID()}@example.test`;
  return { ...(await home.signIn({ provider: "test", subject: email, email, hint: "enam" })), email };
}

/** Leave a closed, owner-checked account waiting for its delayed final sweep. */
async function prepare(instance: { alarm(): Promise<void> }, state: DurableObjectState, vaultId: string, local: Record<string, unknown>) {
  local.SWEEP_DELAY_MS = "3600000";
  await instance.alarm();
  expect(state.storage.sql.exec<{ phase: string }>(`SELECT phase FROM account_final_sweeps WHERE vault_id=?`, vaultId).one().phase).toBe("awaiting");
  state.storage.sql.exec(`UPDATE vaults SET swept_at=1 WHERE vault_id=?`, vaultId);
  state.storage.sql.exec(`UPDATE account_final_sweeps SET swept_at=1 WHERE vault_id=?`, vaultId);
  local.SWEEP_DELAY_MS = "0";
}

function changeIncarnation(state: DurableObjectState, vaultId: string) {
  state.storage.sql.exec(`UPDATE account_final_sweeps SET generation=? WHERE vault_id=?`, crypto.randomUUID(), vaultId);
}

function restore(local: Record<string, unknown>, old: Record<string, unknown>) {
  for (const key of Object.keys(local)) if (!(key in old)) delete local[key];
  Object.assign(local, old);
}

afterEach(() => vi.unstubAllGlobals());

it("does not remove an invite after placement preparation yields to a changed finalization", async () => {
  const home = env.DIRECTORY.getByName(`final-placement-await-${crypto.randomUUID()}`);
  const user = await account(home);
  await home.deleteAccount(user.userId, user.vaultId);
  await runInDurableObject(home, async (instance, state) => {
    const local = (instance as unknown as { env: Record<string, unknown> }).env;
    const old = { ...local };
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const removeInvite = vi.fn(async () => {});
    let running: Promise<void> | undefined;
    try {
      await prepare(instance, state, user.vaultId, local);
      state.storage.sql.exec(`INSERT INTO placement_identities(provider,subject,generation,user_id) VALUES ('test',?,?,?)`, user.email, crypto.randomUUID(), user.userId);
      const original = env.DIRECTORY;
      local.DIRECTORY = {
        idFromName: (name: string) => original.idFromName(name),
        get: () => ({ captureInviteForDeletion: async () => {}, closePlacementHome: async () => { entered(); await held; return []; }, removeCapturedInvite: removeInvite }),
      };
      running = instance.alarm();
      await ready;
      changeIncarnation(state, user.vaultId);
      release();
      await running;
      expect(removeInvite).not.toHaveBeenCalled();
    } finally { release(); await running?.catch(() => {}); restore(local, old); }
  });
}, 30_000);

it("does not contact Stripe after invite cleanup yields to a changed finalization", async () => {
  const home = env.DIRECTORY.getByName(`final-invite-await-${crypto.randomUUID()}`);
  const user = await account(home);
  await home.deleteAccount(user.userId, user.vaultId);
  await runInDurableObject(home, async (instance, state) => {
    const local = (instance as unknown as { env: Record<string, unknown> }).env;
    const old = { ...local };
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const stripe = vi.fn(async () => new Response(null, { status: 500 }));
    let running: Promise<void> | undefined;
    try {
      await prepare(instance, state, user.vaultId, local);
      state.storage.sql.exec(`UPDATE vaults SET stripe_customer='cus_test' WHERE vault_id=?`, user.vaultId);
      Object.assign(local, billing);
      const original = env.DIRECTORY;
      local.DIRECTORY = {
        idFromName: (name: string) => original.idFromName(name),
        get: () => ({ captureInviteForDeletion: async () => {}, removeCapturedInvite: async () => { entered(); await held; } }),
      };
      vi.stubGlobal("fetch", stripe);
      running = instance.alarm();
      await ready;
      changeIncarnation(state, user.vaultId);
      release();
      await running;
      expect(stripe).not.toHaveBeenCalled();
    } finally { release(); await running?.catch(() => {}); restore(local, old); }
  });
}, 30_000);

it("does not revoke OAuth grants after Stripe cleanup yields to a changed finalization", async () => {
  const home = env.DIRECTORY.getByName(`final-stripe-await-${crypto.randomUUID()}`);
  const user = await account(home);
  await home.deleteAccount(user.userId, user.vaultId);
  await runInDurableObject(home, async (instance, state) => {
    const local = (instance as unknown as { env: Record<string, unknown> }).env;
    const old = { ...local };
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const list = vi.fn(async () => ({ keys: [], list_complete: true }));
    let requests = 0;
    let running: Promise<void> | undefined;
    try {
      await prepare(instance, state, user.vaultId, local);
      state.storage.sql.exec(`UPDATE vaults SET stripe_customer='cus_test' WHERE vault_id=?`, user.vaultId);
      Object.assign(local, billing, { OAUTH_KV: { list } });
      const original = env.DIRECTORY;
      local.DIRECTORY = { idFromName: (name: string) => original.idFromName(name), get: () => ({ captureInviteForDeletion: async () => {}, removeCapturedInvite: async () => {} }) };
      vi.stubGlobal("fetch", vi.fn(async () => {
        if (++requests === 1) { entered(); await held; }
        return Response.json({ object: "list", data: [], has_more: false });
      }));
      running = instance.alarm();
      await ready;
      changeIncarnation(state, user.vaultId);
      release();
      await running;
      expect(requests).toBe(4);
      expect(list).not.toHaveBeenCalled();
    } finally { release(); await running?.catch(() => {}); restore(local, old); }
  });
}, 30_000);
