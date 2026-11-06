import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import { identityShard } from "../../src/shared/operations";
import type { SignInInput } from "../../src/shared/types";

// Exercise an invitation reissued before a deletion's capture reaches the
// coordinator. The creation-time binding must preserve that newer grant.
it("preserves an invite reissued before a sharded deletion capture reaches the coordinator", async () => {
  const global = directory(env);
  const id = crypto.randomUUID();
  const email = `invite-window-${id}@example.test`;
  const input: SignInInput = { provider: "google", subject: `invite-window-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(email);
  const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, input);
  const account = await target.directory.signInWithInviteClaim({ ...target.input, reportCreation: true });
  await global.bindIdentityHomeV3(input.provider, input.subject, account.userId, input.authEpoch, undefined, false, account.shardInviteClaim!);
  const key = `vaults/${account.vaultId}/sources/synthetic`;
  await env.FILES.put(key, "synthetic");
  const generation = () => runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec<{ generation: string }>(`SELECT generation FROM invites WHERE email=?`, email).one().generation,
  );
  const originalGeneration = await generation();
  await runInDurableObject(target.directory, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const original = local.DIRECTORY;
    let injected = false;
    local.DIRECTORY = {
      idFromName: (name: string) => original.idFromName(name),
      get: () => ({
        captureInviteForDeletion: async (...args: Parameters<ReturnType<typeof original.get>["captureInviteForDeletion"]>) => {
          await original.get(original.idFromName("global")).addInvite(email);
          injected = true;
          await original.get(original.idFromName("global")).captureInviteForDeletion(...args);
        },
      }),
    } as unknown as typeof original;
    try {
      await (instance as Directory).deleteAccount(account.userId, account.vaultId);
      expect(injected).toBe(true);
    } finally {
      local.DIRECTORY = original;
    }
  });
  const reissuedGeneration = await generation();
  expect(reissuedGeneration).not.toBe(originalGeneration);
  await runInDurableObject(target.directory, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await (instance as Directory).alarm(); }
    finally { local.SWEEP_DELAY_MS = delay; }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await generation()).toBe(reissuedGeneration);
  expect(await env.FILES.get(key)).toBeNull();
  expect(await target.directory.deletionProbe(account.userId, account.vaultId)).toBe(0);
  expect(await global.deletionProbe(account.userId, account.vaultId)).toBe(0);
  await global.removeInviteV2(email);
}, 30_000);

it("fences legacy invite delete permits while allowing deliberate admin revocation", async () => {
  const global = directory(env), email = `legacy-permit-${crypto.randomUUID()}@example.test`;
  await global.addInvite(email);
  await runInDurableObject(global, (_instance, state) => {
    expect(() => state.storage.sql.exec(`INSERT INTO invite_delete_permits(email) VALUES (?)`, email))
      .toThrow(/invite_delete_authorization_required/);
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeInviteV2(email);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
});

it("holds a legacy unbound deletion until deliberate invite revocation", async () => {
  const global = directory(env), id = crypto.randomUUID();
  const input: SignInInput = { provider: "google", subject: `invite-revoke-${id}`, email: `invite-revoke-${id}@example.test`, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(input.email);
  const shard = await identityShard(input.provider, input.subject);
  const legacy = await global.claimIdentityHomeV2(input.provider, input.subject, shard, input.email, undefined, input.authEpoch);
  const home = env.DIRECTORY.getByName(`directory-${shard}`);
  const account = await home.signIn({ ...input, homeShard: shard, inviteAuthorized: true, shardClaimToken: legacy.shardClaimToken! });
  await global.bindIdentityHomeV2(input.provider, input.subject, account.userId, input.authEpoch, undefined, false, legacy.shardClaimToken);
  await home.deleteAccount(account.userId, account.vaultId);
  const runAlarm = () => runInDurableObject(home, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await (instance as Directory).alarm(); }
    finally { local.SWEEP_DELAY_MS = delay; }
  });
  await runAlarm();
  expect(await home.deletionProbe(account.userId, account.vaultId)).toBeGreaterThan(0);
  await global.removeInviteV2(input.email);
  await runAlarm();
  expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
  expect((await global.listInvites()).some((invite) => invite.email === input.email)).toBe(false);
}, 30_000);
