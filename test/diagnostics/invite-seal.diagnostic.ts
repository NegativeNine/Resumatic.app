import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";

// This is an experiment against the real Directory schema, not a deployed
// deletion protocol. These synthetic triggers and coordinator steps do not
// exist in production. A live design must coordinate and authenticate both
// epoch changes, atomically couple final epoch advancement to invite removal
// or keep a coordinator barrier, inventory global users, collect all shard
// close receipts, handle shared invitations and mixed-version draining, and
// reconcile legacy email normalization against the exact sign-in key. Adding
// NFC/NFKC or provider alias rules only to deletion could merge identities
// that sign-in currently treats as distinct. The Google epoch does not protect
// staging test-provider sign-ins; those need their own fence.
type Stub = ReturnType<typeof directory>;

async function setupShard(shard: Stub): Promise<void> {
  await shard.existingIdentity("google", `bootstrap-${crypto.randomUUID()}`);
  await runInDurableObject(shard, (_instance, state) => {
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS diagnostic_email_seals (
      operation_id TEXT PRIMARY KEY, email TEXT, epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','closed'))
    )`);
    state.storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS diagnostic_active_email ON diagnostic_email_seals(email) WHERE state='active'`);
    // This conservative experiment blocks all account creation and email
    // updates while any seal is active, since older writers may not apply
    // the same Unicode normalization. This has an availability cost.
    state.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS diagnostic_block_insert BEFORE INSERT ON users
      WHEN EXISTS(SELECT 1 FROM diagnostic_email_seals WHERE state='active')
      BEGIN SELECT RAISE(ABORT, 'diagnostic_email_sealed'); END`);
    state.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS diagnostic_block_update BEFORE UPDATE OF email ON users
      WHEN EXISTS(SELECT 1 FROM diagnostic_email_seals WHERE state='active')
      BEGIN SELECT RAISE(ABORT, 'diagnostic_email_sealed'); END`);
  });
}

async function bumpGlobal(): Promise<number> {
  return runInDurableObject(directory(env), (_instance, state) => state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const epoch = Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value) + 1;
    sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(epoch));
    return epoch;
  }));
}

/** Atomically seal the actual users table and raise the existing shard floor. */
async function seal(shard: Stub, op: string, email: string, epoch: number): Promise<{ closed: boolean; users: number }> {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("invalid seal epoch");
  return runInDurableObject(shard, (_instance, state) => state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const prior = sql.exec<{ email: string | null; epoch: number; state: string }>(
      `SELECT email,epoch,state FROM diagnostic_email_seals WHERE operation_id=?`, op,
    ).toArray()[0];
    if (prior && prior.epoch !== epoch) throw new Error("seal changed");
    // A closed response is only a tombstone acknowledgement; the coordinator
    // must never count its zero as an active inventory observation.
    if (prior?.state === "closed") return { closed: true, users: 0 };
    if (prior && prior.email !== email) throw new Error("seal changed");
    if (!prior) sql.exec(`INSERT INTO diagnostic_email_seals VALUES (?,?,?,'active')`, op, email, epoch);
    const floor = Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value);
    sql.exec(`UPDATE meta SET value=? WHERE key='shard_auth_floor'`, String(Math.max(floor, epoch)));
    const users = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE email=?`, email).one().n;
    return { closed: false, users };
  }));
}

async function close(shard: Stub, op: string, barrierEpoch: number, finalEpoch: number): Promise<void> {
  if (!Number.isSafeInteger(barrierEpoch) || !Number.isSafeInteger(finalEpoch) || finalEpoch <= barrierEpoch)
    throw new Error("final epoch must advance");
  await runInDurableObject(shard, (_instance, state) => state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const prior = sql.exec<{ epoch: number }>(`SELECT epoch FROM diagnostic_email_seals WHERE operation_id=?`, op).toArray()[0];
    if (prior && prior.epoch !== barrierEpoch) throw new Error("seal epoch changed");
    const floor = Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value);
    sql.exec(`UPDATE meta SET value=? WHERE key='shard_auth_floor'`, String(Math.max(floor, finalEpoch)));
    // Closing an operation never observed by this shard must still leave an
    // opaque tombstone, or an earlier delayed first seal could revive it.
    sql.exec(`INSERT INTO diagnostic_email_seals(operation_id,email,epoch,state) VALUES (?,NULL,?,'closed')
      ON CONFLICT(operation_id) DO UPDATE SET email=NULL,state='closed'`, op, barrierEpoch);
  }));
}

function signIn(email: string, subject: string, shard: number, epoch: number): SignInInput {
  return { provider: "google", email, subject, hint: "enam", homeShard: shard, inviteAuthorized: true, authEpoch: epoch };
}

it("a shard seal observes an unindexed existing account and blocks an in-flight insert", async () => {
  const shardNumber = 5, shard = env.DIRECTORY.getByName(`directory-${shardNumber}`);
  await setupShard(shard);
  const email = `sealed-${crypto.randomUUID()}@example.test`, op = crypto.randomUUID();
  const before = await directory(env).googleAuthEpoch();
  await shard.signIn(signIn(email, `existing-${crypto.randomUUID()}`, shardNumber, before));
  const barrierEpoch = await bumpGlobal();
  const first = await seal(shard, op, email, barrierEpoch);
  expect(first).toEqual({ closed: false, users: 1 });
  // A lost seal acknowledgement is retried without changing the observation.
  expect(await seal(shard, op, email, barrierEpoch)).toEqual(first);
  await runInDurableObject(shard, async (instance) => {
    await expect((instance as Directory).signIn(signIn(email, `late-${crypto.randomUUID()}`, shardNumber, barrierEpoch)))
      .rejects.toThrow(/diagnostic_email_sealed/);
    // Conservative sealing blocks even an unrelated email; a production
    // implementation must address this cost or prove per-email matching.
    await expect((instance as Directory).signIn(signIn(`unrelated-${crypto.randomUUID()}@example.test`, `unrelated-${crypto.randomUUID()}`, shardNumber, barrierEpoch)))
      .rejects.toThrow(/diagnostic_email_sealed/);
  });
  await runInDurableObject(shard, (_instance, state) => {
    expect(() => state.storage.sql.exec(`UPDATE users SET email=? WHERE email=?`, `other-${crypto.randomUUID()}@example.test`, email))
      .toThrow(/diagnostic_email_sealed/);
  });
  const finalEpoch = await bumpGlobal();
  await close(shard, op, barrierEpoch, finalEpoch);
  // A delayed duplicate seal must not recreate the per-email barrier.
  expect(await seal(shard, op, email, barrierEpoch)).toEqual({ closed: true, users: 0 });
  // The floor persists after the seal is redacted and rejects both generations
  // of authorization issued before and during the barrier.
  for (const epoch of [before, barrierEpoch])
    await runInDurableObject(shard, async (instance) => {
      await expect((instance as Directory).signIn(signIn(email, `stale-${crypto.randomUUID()}`, shardNumber, epoch))).rejects.toThrow(/stale/);
    });
  expect((await shard.signIn(signIn(email, `fresh-${crypto.randomUUID()}`, shardNumber, finalEpoch))).userId).toBeTruthy();
}, 30_000);

it("demonstrates that releasing after only one epoch permits an authorization issued during the barrier", async () => {
  const shardNumber = 6, shard = env.DIRECTORY.getByName(`directory-${shardNumber}`);
  await setupShard(shard);
  const email = `single-epoch-${crypto.randomUUID()}@example.test`, op = crypto.randomUUID();
  const barrierEpoch = await bumpGlobal();
  await seal(shard, op, email, barrierEpoch);
  await expect(close(shard, op, barrierEpoch, barrierEpoch)).rejects.toThrow("final epoch must advance");
  // Deliberately reproduce the unsafe transition directly; the tested close
  // helper rejects this. This must never be used as a production protocol.
  await runInDurableObject(shard, (_instance, state) => state.storage.sql.exec(
    `UPDATE diagnostic_email_seals SET email=NULL,state='closed' WHERE operation_id=?`, op,
  ));
  // This is the unsafe behavior that a second epoch transition must prevent.
  expect((await shard.signIn(signIn(email, `during-${crypto.randomUUID()}`, shardNumber, barrierEpoch))).userId).toBeTruthy();
}, 30_000);

it("tombstones a close that arrives before a delayed first seal", async () => {
  const shardNumber = 8, shard = env.DIRECTORY.getByName(`directory-${shardNumber}`);
  await setupShard(shard);
  const email = `late-seal-${crypto.randomUUID()}@example.test`, op = crypto.randomUUID();
  const barrierEpoch = await bumpGlobal(), finalEpoch = await bumpGlobal();
  await close(shard, op, barrierEpoch, finalEpoch);
  expect(await seal(shard, op, email, barrierEpoch)).toEqual({ closed: true, users: 0 });
  await runInDurableObject(shard, async (instance) => {
    await expect((instance as Directory).signIn(signIn(email, `stale-${crypto.randomUUID()}`, shardNumber, barrierEpoch)))
      .rejects.toThrow(/stale/);
  });
  expect((await shard.signIn(signIn(email, `fresh-${crypto.randomUUID()}`, shardNumber, finalEpoch))).userId).toBeTruthy();
}, 30_000);

it("detects an unindexed matching user only after sealing all sixteen shard databases", async () => {
  const shards = Array.from({ length: 16 }, (_, index) => env.DIRECTORY.getByName(`directory-${index}`));
  await Promise.all(shards.map(setupShard));
  const email = `inventory-${crypto.randomUUID()}@example.test`, op = crypto.randomUUID();
  const oldEpoch = await directory(env).googleAuthEpoch();
  const user = await shards[11]!.signIn(signIn(email, `unindexed-${crypto.randomUUID()}`, 11, oldEpoch));
  expect(user.userId).toMatch(/^s11:/);
  const barrierEpoch = await bumpGlobal();
  const receipts = await Promise.all(shards.map((shard) => seal(shard, op, email, barrierEpoch)));
  // A partial collection, even one that has found no matching user, is not
  // enough to authorize deletion; the omitted shard can hold an orphan.
  expect(receipts.slice(0, 11).every((receipt) => receipt.users === 0)).toBe(true);
  expect(receipts.slice(0, 11)).toHaveLength(11);
  expect(receipts).toHaveLength(16);
  expect(receipts.every((receipt) => !receipt.closed)).toBe(true);
  expect(receipts[11]).toEqual({ closed: false, users: 1 });
  expect(receipts.reduce((sum, receipt) => sum + receipt.users, 0)).toBe(1);
  const finalEpoch = await bumpGlobal();
  await Promise.all(shards.map((shard) => close(shard, op, barrierEpoch, finalEpoch)));
}, 60_000);

it("shows that SQLite lower is not a substitute for JavaScript email normalization on legacy rows", async () => {
  const shard = env.DIRECTORY.getByName("directory-7");
  await setupShard(shard);
  const legacyEmail = `EXAMPLE-\u0130-${crypto.randomUUID()}@example.test`;
  const normalized = legacyEmail.trim().toLowerCase();
  const matches = await runInDurableObject(shard, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?, 'active',?)`, crypto.randomUUID(), legacyEmail, Date.now());
    return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE lower(email)=?`, normalized).one().n;
  });
  // A migration must normalize or otherwise account for every legacy row;
  // an SQL-only lowercase scan would miss this synthetic Unicode address.
  expect(matches).toBe(0);
}, 30_000);

it("shows the Google epoch floor alone does not fence staging test identities", async () => {
  const shardNumber = 9, shard = env.DIRECTORY.getByName(`directory-${shardNumber}`);
  await setupShard(shard);
  const email = `test-provider-${crypto.randomUUID()}@example.test`, op = crypto.randomUUID();
  const barrierEpoch = await bumpGlobal();
  await seal(shard, op, email, barrierEpoch);
  const finalEpoch = await bumpGlobal();
  await close(shard, op, barrierEpoch, finalEpoch);
  // This direct synthetic request has no Google epoch. Production disables
  // test sign-in, but a staging audit needs a separate test-identity fence.
  const result = await shard.signIn({ provider: "test", subject: `test-${crypto.randomUUID()}`, email, hint: "enam", homeShard: shardNumber });
  expect(result.userId).toMatch(/^s9:/);
}, 30_000);
