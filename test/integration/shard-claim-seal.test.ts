import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import type { RevokedShardClaim } from "../../src/directory/shard-claim-revocation";
import { directory, directoryByName } from "../../src/shared/stubs";

function claim(shard = 5): RevokedShardClaim {
  const id = crypto.randomUUID();
  return { operationId: crypto.randomUUID(), provider: "google", subject: `sealed-${id}`,
    shard, token: crypto.randomUUID(), email: `sealed-${id}@example.test`, generation: "a".repeat(32) };
}
function input(c: RevokedShardClaim, authEpoch: number) {
  return { provider: "google" as const, subject: c.subject, email: c.email, hint: "enam" as const,
    homeShard: c.shard, inviteAuthorized: true, authEpoch, shardClaimToken: c.token,
    shardInviteClaim: { token: c.token, email: c.email, generation: c.generation }, reportCreation: true };
}
const rejected = async (home: ReturnType<typeof directoryByName>, run: (object: Directory) => Promise<unknown>, message: RegExp) =>
  runInDurableObject(home, async (instance) => { await expect(run(instance as Directory)).rejects.toThrow(message); });

describe("shard invitation claim seals", () => {
  it("tombstones before create, rejects changed retries and survives eviction", async () => {
    const c = claim(), home = directoryByName(env, `directory-${c.shard}`), epoch = await directory(env).googleAuthEpoch();
    expect(await home.sealShardInviteClaimV2(c)).toEqual({ state: "absent" });
    await rejected(home, (d) => d.signInWithInviteClaimV2(input(c, epoch)), /no longer available/);
    await rejected(home, (d) => d.signInWithInviteClaim(input(c, epoch)), /no longer available/);
    await rejected(home, (d) => d.sealShardInviteClaimV2({ ...c, email: `other-${crypto.randomUUID()}@example.test` }), /changed/);
    await rejected(home, (d) => d.sealShardInviteClaimV2({ ...c, operationId: crypto.randomUUID() }), /changed/);
    // Once the migrated guard is active, an older tokenless create cannot
    // evade the token tombstone on that shard.
    await rejected(home, (d) => d.signIn({ provider: "google", subject: `legacy-${crypto.randomUUID()}`,
      email: `legacy-${crypto.randomUUID()}@example.test`, hint: "enam", homeShard: c.shard,
      inviteAuthorized: true, authEpoch: epoch }), /registration_required/);
    await home.closeShardInviteClaimV2(c);
    await evictDurableObject(home);
    expect(await home.sealShardInviteClaimV2(c)).toEqual({ state: "closed" });
    await rejected(home, (d) => d.signInWithInviteClaimV2(input(c, epoch)), /no longer available/);
    await runInDurableObject(home, (_instance, state) => {
      const row = state.storage.sql.exec<{ state: string; user_id: string | null; vault_id: string | null }>(
        `SELECT state,user_id,vault_id FROM shard_revoked_invite_claims WHERE token=?`, c.token,
      ).one();
      expect(row).toEqual({ state: "closed", user_id: null, vault_id: null });
      expect(() => state.storage.sql.exec(`DELETE FROM shard_revoked_invite_claims WHERE token=?`, c.token)).toThrow(/tombstone_required/);
      expect(() => state.storage.sql.exec(`UPDATE shard_revoked_invite_claims SET tuple_digest='changed' WHERE token=?`, c.token)).toThrow(/tombstone_immutable/);
    });
  }, 30_000);

  it("reports an already created account and does not erase or close it", async () => {
    const c = claim(6), home = directoryByName(env, `directory-${c.shard}`), epoch = await directory(env).googleAuthEpoch();
    const account = await home.signInWithInviteClaimV2(input(c, epoch));
    expect(await home.sealShardInviteClaimV2(c)).toEqual({ state: "created", userId: account.userId, vaultId: account.vaultId });
    expect(await home.sealShardInviteClaimV2(c)).toEqual({ state: "created", userId: account.userId, vaultId: account.vaultId });
    await rejected(home, (d) => d.closeShardInviteClaimV2(c), /orphan account requires reconciliation/);
    expect(await home.existingIdentity("google", c.subject)).toEqual({ userId: account.userId, vaultId: account.vaultId });
    expect(await home.deletionProbe(account.userId, account.vaultId)).toBeGreaterThan(0);
    // A routed existing-account retry does not carry the claim; the stored
    // binding still prevents it from bypassing the seal.
    const retry = { ...input(c, epoch), expectedUserId: account.userId };
    delete (retry as { shardInviteClaim?: unknown }).shardInviteClaim;
    delete (retry as { shardClaimToken?: unknown }).shardClaimToken;
    await rejected(home, (d) => d.signInWithInviteClaimV2(retry), /no longer available/);
  }, 30_000);

  it("never treats an unexpected committed creation marker as absence", async () => {
    const c = claim(8), home = directoryByName(env, `directory-${c.shard}`);
    await runInDurableObject(home, async (instance, state) => {
      state.storage.sql.exec(`INSERT INTO shard_invite_create_marker(provider,subject,user_id,token) VALUES (?,?,?,?)`,
        c.provider, c.subject, crypto.randomUUID(), c.token);
      await expect((instance as Directory).sealShardInviteClaimV2(c)).rejects.toThrow(/requires review/);
      expect(state.storage.sql.exec(`SELECT token FROM shard_revoked_invite_claims WHERE token=?`, c.token).toArray()).toHaveLength(0);
    });
  });

  it("rejects ambiguous owner or token provenance instead of reporting absence", async () => {
    const c = claim(9), home = directoryByName(env, `directory-${c.shard}`), epoch = await directory(env).googleAuthEpoch();
    await home.signInWithInviteClaimV2(input(c, epoch));
    await rejected(home, (d) => d.sealShardInviteClaimV2({ ...c, token: crypto.randomUUID() }), /requires review/);
    await rejected(home, (d) => d.sealShardInviteClaimV2({ ...c, subject: `other-${crypto.randomUUID()}` }), /requires review/);
    await rejected(home, (d) => d.sealShardInviteClaimV2({ ...c, email: `other-${crypto.randomUUID()}@example.test` }), /requires review/);
    expect((await home.sealShardInviteClaimV2(c)).state).toBe("created");
  }, 30_000);

  it("fences a claim while its newly created Vault initialization is suspended", async () => {
    const c = claim(7), home = directoryByName(env, `directory-${c.shard}`), epoch = await directory(env).googleAuthEpoch();
    await runInDurableObject(home, async (instance, state) => {
      const object = instance as Directory, local = (instance as unknown as { env: Env }).env, original = local.VAULT;
      let enter!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => { enter = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      local.VAULT = {
        newUniqueId: () => original.newUniqueId(),
        idFromString: (value: string) => original.idFromString(value),
        get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
          init: async (userId: string) => { enter(); await hold; await original.get(id, options).init(userId); },
        }),
      } as unknown as typeof original;
      const pending = object.signInWithInviteClaimV2(input(c, epoch)).then(() => "ok", (error: unknown) => String(error));
      try {
        await started;
        const row = state.storage.sql.exec<{ user_id: string; vault_id: string }>(
          `SELECT user_id,vault_id FROM vaults WHERE user_id IN (SELECT user_id FROM identities WHERE provider='google' AND subject=?)`, c.subject,
        ).one();
        expect(await object.sealShardInviteClaimV2(c)).toEqual({ state: "created", userId: row.user_id, vaultId: row.vault_id });
        expect(state.storage.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id=?`, row.vault_id).toArray()).toHaveLength(1);
        release();
        expect(await pending).toContain("no longer available");
        expect((await object.sealShardInviteClaimV2(c)).state).toBe("created");
      } finally { release(); await pending; local.VAULT = original; }
    });
  }, 30_000);
});
