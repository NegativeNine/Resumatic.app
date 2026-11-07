import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory } from "../../src/shared/stubs";

it("holds automatic invite cleanup until the explicit rollout assertion is present, then recovers", async () => {
  const d = directory(env), id = crypto.randomUUID(), email = `rollout-${id}@example.test`;
  await d.addInvite(email);
  const account = await d.signIn({ provider: "test", subject: id, email, hint: "enam", authEpoch: await d.googleAuthEpoch() });
  await d.deleteAccount(account.userId, account.vaultId);
  await runInDurableObject(d, async (instance) => {
    const local = (instance as unknown as { env: Env & { INVITE_INVENTORY_DRAIN_VERIFIED?: string } }).env;
    const prior = local.INVITE_INVENTORY_DRAIN_VERIFIED;
    local.INVITE_INVENTORY_DRAIN_VERIFIED = "unverified";
    try { await (instance as Directory).alarm(); }
    finally { local.INVITE_INVENTORY_DRAIN_VERIFIED = prior; }
  });
  expect((await d.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await d.deletionProbe(account.userId, account.vaultId)).toBeGreaterThan(0);
  await runInDurableObject(d, async (instance) => (instance as Directory).alarm());
  expect((await d.listInvites()).some((invite) => invite.email === email)).toBe(false);
  expect(await d.deletionProbe(account.userId, account.vaultId)).toBe(0);
});
