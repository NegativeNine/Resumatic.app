import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { identityShard } from "../../src/shared/operations";
import { directory, directoryForUser } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "./support";

async function input(): Promise<SignInInput> {
  const id = crypto.randomUUID();
  return { provider: "google", subject: `invite-${id}`, email: `invite-${id}@example.test`, hint: "enam", authEpoch: await directory(env).googleAuthEpoch() };
}

describe("sharded account invitation claims", () => {
  it("rechecks a prior invitation decision atomically when claiming a home after deletion", async () => {
    const p = await input();
    const global = directory(env);
    const shard = await identityShard(p.provider, p.subject);
    await global.addInvite(p.email);
    // The first Worker has an invite approval but has not called claim yet.
    await global.requireInvite(p.email);
    const initial = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, p);
    const account = await initial.directory.signIn(initial.input);
    await global.bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch, undefined, false, initial.input.shardClaimToken);
    const home = directoryForUser(env, account.userId);
    await home.deleteAccount(account.userId, account.vaultId);
    await runDurableObjectAlarm(home);
    await eventually(async () => !(await home.existingIdentity(p.provider, p.subject)), "sharded identity erasure");
    expect((await global.listInvites()).some((invite) => invite.email === p.email)).toBe(false);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).claimIdentityHome(p.provider, p.subject, shard, p.email)).rejects.toThrow("not been invited");
      // An older Worker has no email argument. It must fail closed, even if a
      // new invitation is later added for a genuinely new attempt.
      await expect((instance as Directory).claimIdentityHome(p.provider, p.subject, shard)).rejects.toThrow("sign-in service is updating");
    });
    const rows = await runInDurableObject(global, (_instance, state) => state.storage.sql
      .exec(`SELECT provider FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).toArray());
    expect(rows).toHaveLength(0);
    await global.addInvite(p.email);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).claimIdentityHome(p.provider, p.subject, shard)).rejects.toThrow("sign-in service is updating");
      // A renewed invite must not revive the authorization captured before
      // the deleted shard's global home was released.
      await expect((instance as Directory).claimIdentityHome(p.provider, p.subject, shard, p.email, undefined, p.authEpoch)).rejects.toThrow("sign-in is stale");
    });
    const fresh = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, { ...p, authEpoch: await global.googleAuthEpoch() });
    expect((await fresh.directory.signIn(fresh.input)).userId).toMatch(/^s(?:[0-9]|1[0-5]):/);
  }, 30_000);

  it("keeps existing shard accounts accessible after invitation removal", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    const initial = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, p);
    const account = await initial.directory.signIn(initial.input);
    await global.bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch, undefined, false, initial.input.shardClaimToken);
    await global.removeInviteV2(p.email);
    const returning = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
    expect(await returning.directory.signIn(returning.input)).toEqual(account);
  }, 30_000);

  it("preserves open registration and test sign-ins without an email argument", async () => {
    const global = directory(env);
    const p = await input();
    await runInDurableObject(global, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.INVITE_ONLY;
      try {
        local.INVITE_ONLY = "false";
        expect(await (instance as Directory).claimIdentityHome(p.provider, p.subject, 0, p.email, undefined, p.authEpoch)).toBe(0);
      } finally {
        local.INVITE_ONLY = previous;
      }
    });
    const subject = `test-${crypto.randomUUID()}@example.test`;
    expect(await global.claimIdentityHome("test", subject, 1)).toBe(1);
  });
});
