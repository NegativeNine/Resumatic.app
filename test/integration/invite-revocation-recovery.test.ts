import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { InviteRevocation } from "../../src/directory/invite-revocation";
import { directory } from "../../src/shared/stubs";

const digest = async (operation: string, email: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${operation}:${email}`));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
};

async function fixture() {
  const global = directory(env), nonce = crypto.randomUUID();
  const email = `revoke-${nonce}@example.test`, subject = `subject-${nonce}`;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const { shardInviteClaim } = await global.claimIdentityHomeV3("google", subject, 5, email, undefined, epoch);
  await global.addInvite(email); // The outstanding claim belongs to the prior generation.
  return { global, email, subject, claim: shardInviteClaim! };
}

it("persists absent evidence before a lost close reply and replays without revoking a later grant", async () => {
  const f = await fixture(), op = crypto.randomUUID();
  await runInDurableObject(f.global, async (instance, ctx) => {
    const sql = ctx.storage.sql;
    let closeCalls = 0, seals = 0;
    const c = new InviteRevocation({ sql, storage: ctx.storage, transaction: (fn) => ctx.storage.transactionSync(fn),
      fingerprint: digest, verifyRollout: () => {}, waitMs: 20,
      seal: async () => { seals++; return { state: "absent" }; },
      close: async () => { if (++closeCalls === 1) throw new Error("lost response after remote commit"); },
      removeInvite: (email, generation) => (instance as unknown as { deleteInvite(e: string, g: string): void }).deleteInvite(email, generation),
    });
    await c.begin(f.email, op);
    await c.resume();
    expect(c.status(op)).toEqual({ state: "pending", remaining: 1, orphans: 0 });
    expect(sql.exec<{ state: string }>(`SELECT state FROM invite_revocation_claims WHERE operation_id=?`, op).one().state).toBe("absent");
    await c.resume();
    expect(c.status(op)).toEqual({ state: "complete" });
    expect(seals).toBe(1);
    expect(sql.exec(`SELECT subject FROM identity_homes WHERE subject=?`, f.subject).toArray()).toHaveLength(0);
    expect(sql.exec(`SELECT subject FROM shard_home_claim_tokens WHERE subject=?`, f.subject).toArray()).toHaveLength(0);
    expect(sql.exec(`SELECT email FROM invites WHERE email=?`, f.email).toArray()).toHaveLength(0);
    await expect(c.begin("other@example.test", op)).rejects.toThrow();
  });
  await f.global.addInvite(f.email);
  await runInDurableObject(f.global, async (instance, ctx) => {
    const c = new InviteRevocation({ sql: ctx.storage.sql, storage: ctx.storage, transaction: (fn) => ctx.storage.transactionSync(fn),
      fingerprint: digest, verifyRollout: () => {}, seal: async () => { throw new Error("must not seal"); }, close: async () => {},
      removeInvite: (email, generation) => (instance as unknown as { deleteInvite(e: string, g: string): void }).deleteInvite(email, generation),
    });
    expect(await c.begin(f.email, op)).toEqual({ state: "complete" });
    expect(ctx.storage.sql.exec(`SELECT email FROM invites WHERE email=?`, f.email).toArray()).toHaveLength(1);
  });
});

it("keeps a created target pending and fences reissue and binding", async () => {
  const f = await fixture(), op = crypto.randomUUID();
  const otherEmail = `other-${crypto.randomUUID()}@example.test`;
  await f.global.addInvite(otherEmail);
  await runInDurableObject(f.global, async (instance, ctx) => {
    const sql = ctx.storage.sql;
    const c = new InviteRevocation({ sql, storage: ctx.storage, transaction: (fn) => ctx.storage.transactionSync(fn),
      fingerprint: digest, verifyRollout: () => {},
      seal: async () => ({ state: "created", userId: `s5:${crypto.randomUUID()}`, vaultId: "a".repeat(64) }),
      close: async () => { throw new Error("created claims must not close"); },
      removeInvite: (email, generation) => (instance as unknown as { deleteInvite(e: string, g: string): void }).deleteInvite(email, generation),
    });
    await c.begin(f.email, op);
    await c.resume();
    expect(c.status(op)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    expect(() => sql.exec(`UPDATE invites SET generation=? WHERE email=?`, "a".repeat(32), f.email)).toThrow();
    expect(() => sql.exec(`UPDATE invites SET generation=? WHERE email=?`, "a".repeat(32), otherEmail)).not.toThrow();
    expect(() => sql.exec(`UPDATE identity_homes SET user_id='new-user' WHERE subject=?`, f.subject)).toThrow();
    expect(sql.exec(`SELECT email FROM invites WHERE email=?`, f.email).toArray()).toHaveLength(1);
    // Keep this shared integration Durable Object available to later tests.
    sql.exec(`DELETE FROM invite_revocation_claims WHERE operation_id=?`, op);
    sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, op);
  });
});

it("does not treat an unproven closed response as an absent receipt", async () => {
  const f = await fixture(), op = crypto.randomUUID();
  await runInDurableObject(f.global, async (instance, ctx) => {
    let closed = false;
    const c = new InviteRevocation({ sql: ctx.storage.sql, storage: ctx.storage, transaction: (fn) => ctx.storage.transactionSync(fn),
      fingerprint: digest, verifyRollout: () => {}, seal: async () => ({ state: "closed" }), close: async () => { closed = true; },
      removeInvite: (email, generation) => (instance as unknown as { deleteInvite(e: string, g: string): void }).deleteInvite(email, generation),
    });
    await c.begin(f.email, op);
    await c.resume();
    expect(c.status(op)).toEqual({ state: "pending", remaining: 1, orphans: 0 });
    expect(closed).toBe(false);
    ctx.storage.sql.exec(`DELETE FROM invite_revocation_claims WHERE operation_id=?`, op);
    ctx.storage.sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, op);
  });
});

it("ignores a late seal after a concurrent retry completes and a new operation starts", async () => {
  const f = await fixture(), op = crypto.randomUUID(), next = crypto.randomUUID();
  await runInDurableObject(f.global, async (instance, ctx) => {
    const sql = ctx.storage.sql;
    let calls = 0, release!: () => void;
    const late = new Promise<void>((resolve) => { release = resolve; });
    const c = new InviteRevocation({ sql, storage: ctx.storage, transaction: (fn) => ctx.storage.transactionSync(fn),
      fingerprint: digest, verifyRollout: () => {}, waitMs: 5,
      seal: async () => { if (++calls === 1) await late; return { state: "absent" }; }, close: async () => {},
      removeInvite: (email, generation) => (instance as unknown as { deleteInvite(e: string, g: string): void }).deleteInvite(email, generation),
    });
    await c.begin(f.email, op);
    const old = c.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all([old, c.resume()]);
    expect(c.status(op)).toEqual({ state: "complete" });
    await c.begin(f.email, next);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.status(next)).toEqual({ state: "pending", remaining: 0, orphans: 0 });
    expect(sql.exec<{ operation_id: string }>(`SELECT operation_id FROM invite_revocation_barrier`).one().operation_id).toBe(next);
    await c.resume();
    expect(c.status(next)).toEqual({ state: "complete" });
  });
});
