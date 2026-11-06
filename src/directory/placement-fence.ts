import { AppError } from "../shared/errors";

/** Experimental protocol storage. All methods run inside their caller's DO. */
export const PLACEMENT_FENCE_MIGRATIONS = [
  `ALTER TABLE identity_homes ADD COLUMN generation TEXT`,
  `ALTER TABLE identity_homes ADD COLUMN placement_state TEXT NOT NULL DEFAULT 'open'`,
  `CREATE TABLE placement_attempts (attempt_id TEXT PRIMARY KEY, generation TEXT NOT NULL, shard INTEGER)`,
  `CREATE INDEX placement_attempts_generation ON placement_attempts(generation)`,
  `CREATE TABLE placement_receipts (attempt_id TEXT PRIMARY KEY, generation TEXT NOT NULL, state TEXT NOT NULL, user_id TEXT)`,
  `CREATE TABLE placement_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, generation TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(provider, subject))`,
  `CREATE TABLE placement_finalizations (user_id TEXT NOT NULL, vault_id TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(user_id, provider, subject))`,
  `CREATE TABLE placement_releases (generation TEXT PRIMARY KEY)`,
] as const;

export interface PlacementAttempt { id: string; generation: string; shard: number | null }
type Home = { shard: number | null; user_id: string | null; generation: string | null; placement_state: string };
type Receipt = { generation: string; state: string; user_id: string | null };
type SyncTransaction = <T>(fn: () => T) => T;
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
/** This experimental protocol may only create disposable staging identities. */
export const syntheticPlacementIdentity = (provider: string, subject: string) =>
  provider === "test" && /^placement-[0-9a-f-]{36}@placement\.invalid$/.test(subject);

/** Global claim operations and target-local receipt operations share a schema, not state. */
export class PlacementFence {
  constructor(private sql: SqlStorage, private transaction: SyncTransaction) {}

  reserve(provider: string, subject: string, preferred: number | null): PlacementAttempt {
    if (!syntheticPlacementIdentity(provider, subject)) throw new AppError("unavailable", "placement fencing is restricted to synthetic identities");
    if (preferred !== null && (!Number.isInteger(preferred) || preferred < 0 || preferred > 15))
      throw new AppError("invalid", "invalid directory shard");
    return this.transaction(() => {
      let home = this.home(provider, subject);
      if (!home) {
        const generation = crypto.randomUUID();
        this.sql.exec(`INSERT INTO identity_homes(provider,subject,shard,generation,placement_state) VALUES (?,?,?,?,'open')`, provider, subject, preferred, generation);
        home = this.home(provider, subject)!;
      }
      // A pre-protocol home may have outstanding untracked dispatches.
      if (!home.generation) throw new AppError("unavailable", "legacy account placement requires review");
      if (home.placement_state !== "open") throw new AppError("conflict", "account deletion is in progress");
      if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM placement_attempts WHERE generation=?`, home.generation).one().n >= 128)
        throw new AppError("quota", "too many pending sign-in attempts");
      const id = crypto.randomUUID();
      this.sql.exec(`INSERT INTO placement_attempts(attempt_id,generation,shard) VALUES (?,?,?)`, id, home.generation, home.shard);
      return { id, generation: home.generation, shard: home.shard };
    });
  }

  private home(provider: string, subject: string): Home | null {
    return this.sql.exec<Home>(`SELECT shard,user_id,generation,placement_state FROM identity_homes WHERE provider=? AND subject=?`, provider, subject).toArray()[0] ?? null;
  }

  pending(provider: string, subject: string): PlacementAttempt[] {
    if (!syntheticPlacementIdentity(provider, subject)) throw new AppError("unavailable", "placement fencing is restricted to synthetic identities");
    const home = this.home(provider, subject);
    if (!home?.generation) throw new AppError("unavailable", "account placement requires review");
    return this.sql.exec<{ attempt_id: string; shard: number | null }>(`SELECT attempt_id,shard FROM placement_attempts WHERE generation=? ORDER BY attempt_id`, home.generation).toArray().map((row) => ({ id: row.attempt_id, generation: home.generation!, shard: row.shard }));
  }

  inspect(provider: string, subject: string): { generation: string; state: string; bound: boolean; pending: number } | null {
    if (!syntheticPlacementIdentity(provider, subject)) throw new AppError("unavailable", "placement fencing is restricted to synthetic identities");
    const home = this.home(provider, subject);
    if (!home) return null;
    if (!home.generation) throw new AppError("unavailable", "legacy account placement requires review");
    const pending = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM placement_attempts WHERE generation=?`, home.generation).one().n;
    return { generation: home.generation, state: home.placement_state, bound: home.user_id !== null, pending };
  }

  /** A generation-qualified orphan sweep blocks new registered dispatches first. */
  beginOrphanCleanup(provider: string, subject: string, generation: string): { released: boolean; attempts: PlacementAttempt[] } {
    if (!syntheticPlacementIdentity(provider, subject) || !validId(generation)) throw new AppError("invalid", "invalid synthetic placement");
    return this.transaction(() => {
      if (this.sql.exec(`SELECT generation FROM placement_releases WHERE generation=?`, generation).toArray().length) return { released: true, attempts: [] };
      const home = this.home(provider, subject);
      if (!home || home.generation !== generation) throw new AppError("conflict", "placement generation changed");
      if (home.placement_state === "closing") throw new AppError("conflict", "account deletion is in progress");
      if (!["open", "orphan"].includes(home.placement_state)) throw new AppError("unavailable", "account placement requires review");
      if (home.placement_state === "open" && home.user_id !== null) throw new AppError("conflict", "an account already exists");
      this.sql.exec(`UPDATE identity_homes SET placement_state='orphan' WHERE provider=? AND subject=? AND generation=?`, provider, subject, generation);
      return { released: false, attempts: this.sql.exec<{ attempt_id: string; shard: number | null }>(`SELECT attempt_id,shard FROM placement_attempts WHERE generation=? ORDER BY attempt_id`, generation).toArray().map((row) => ({ id: row.attempt_id, generation, shard: row.shard })) };
    });
  }

  finishOrphanCleanup(provider: string, subject: string, generation: string): "released" | "account-present" {
    if (!syntheticPlacementIdentity(provider, subject) || !validId(generation)) throw new AppError("invalid", "invalid synthetic placement");
    return this.transaction(() => {
      if (this.sql.exec(`SELECT generation FROM placement_releases WHERE generation=?`, generation).toArray().length) return "released";
      const home = this.home(provider, subject);
      if (!home || home.generation !== generation || home.placement_state !== "orphan") throw new AppError("conflict", "placement generation changed");
      if (this.sql.exec(`SELECT attempt_id FROM placement_attempts WHERE generation=? LIMIT 1`, generation).toArray().length) throw new AppError("unavailable", "account placement attempts are unresolved");
      if (home.user_id !== null) {
        this.sql.exec(`UPDATE identity_homes SET placement_state='open' WHERE provider=? AND subject=? AND generation=? AND placement_state='orphan'`, provider, subject, generation);
        return "account-present";
      }
      this.sql.exec(`INSERT INTO placement_releases(generation) VALUES (?)`, generation);
      this.sql.exec(`DELETE FROM identity_homes WHERE provider=? AND subject=? AND generation=? AND user_id IS NULL AND placement_state='orphan'`, provider, subject, generation);
      return "released";
    });
  }

  /** Called before account creation, in the same transaction as any new identity. */
  accept(attempt: PlacementAttempt, userId: string): void {
    if (!validId(attempt.id) || !validId(attempt.generation)) throw new AppError("invalid", "invalid placement attempt");
    const receipt = this.receipt(attempt.id);
    if (receipt) {
      if (receipt.generation !== attempt.generation || receipt.state !== "accepted" || receipt.user_id !== userId)
        throw new AppError("conflict", "placement attempt was closed");
      return;
    }
    this.sql.exec(`INSERT INTO placement_receipts(attempt_id,generation,state,user_id) VALUES (?,?,'accepted',?)`, attempt.id, attempt.generation, userId);
  }

  receipt(id: string): Receipt | null {
    return this.sql.exec<Receipt>(`SELECT generation,state,user_id FROM placement_receipts WHERE attempt_id=?`, id).toArray()[0] ?? null;
  }

  /** Serialize with target creation: a late creation must see the permanent tombstone. */
  seal(attempt: PlacementAttempt): { userId: string | null } {
    if (!validId(attempt.id) || !validId(attempt.generation)) throw new AppError("invalid", "invalid placement attempt");
    return this.transaction(() => {
      const receipt = this.receipt(attempt.id);
      if (receipt && receipt.generation !== attempt.generation) throw new AppError("conflict", "placement generation changed");
      if (!receipt) this.sql.exec(`INSERT INTO placement_receipts(attempt_id,generation,state,user_id) VALUES (?,?,'sealed',NULL)`, attempt.id, attempt.generation);
      else this.sql.exec(`UPDATE placement_receipts SET state='sealed' WHERE attempt_id=?`, attempt.id);
      return { userId: receipt?.user_id ?? null };
    });
  }

  /** Caller has received the target seal; uncertain RPCs leave the marker pending. */
  settle(provider: string, subject: string, attempt: PlacementAttempt, userId: string | null): void {
    if (!syntheticPlacementIdentity(provider, subject)) throw new AppError("unavailable", "placement fencing is restricted to synthetic identities");
    this.transaction(() => {
      const home = this.home(provider, subject);
      if (!home || home.generation !== attempt.generation || home.shard !== attempt.shard)
        throw new AppError("conflict", "placement generation changed");
      const pending = this.sql.exec<{ generation: string; shard: number | null }>(`SELECT generation,shard FROM placement_attempts WHERE attempt_id=?`, attempt.id).toArray()[0];
      if (!pending) return; // idempotent settlement while this generation exists
      if (pending.generation !== attempt.generation || pending.shard !== attempt.shard)
        throw new AppError("conflict", "placement attempt changed");
      if (userId !== null) {
        if (typeof userId !== "string" || !userId) throw new AppError("invalid", "invalid placement owner");
        const prefix = /^s(\d+):/.exec(userId);
        if ((prefix ? Number(prefix[1]) : null) !== home.shard)
          throw new AppError("unavailable", "account placement requires review");
      }
      if (userId !== null && home.user_id !== null && userId !== home.user_id)
        throw new AppError("unavailable", "account placement requires review");
      if (userId !== null && home.user_id === null)
        this.sql.exec(`UPDATE identity_homes SET user_id=? WHERE provider=? AND subject=? AND generation=?`, userId, provider, subject, attempt.generation);
      this.sql.exec(`DELETE FROM placement_attempts WHERE attempt_id=?`, attempt.id);
    });
  }

  close(provider: string, subject: string, generation: string, userId: string): PlacementAttempt[] {
    if (!syntheticPlacementIdentity(provider, subject)) throw new AppError("unavailable", "placement fencing is restricted to synthetic identities");
    return this.transaction(() => {
      const home = this.home(provider, subject);
      if (!home || home.generation !== generation || home.user_id !== userId)
        throw new AppError("unavailable", "account placement requires review");
      if (!["open", "closing", "orphan"].includes(home.placement_state))
        throw new AppError("unavailable", "account placement requires review");
      this.sql.exec(`UPDATE identity_homes SET placement_state='closing' WHERE provider=? AND subject=? AND generation=?`, provider, subject, generation);
      return this.sql.exec<{ attempt_id: string; shard: number | null }>(`SELECT attempt_id,shard FROM placement_attempts WHERE generation=? ORDER BY attempt_id`, generation).toArray().map((row) => ({ id: row.attempt_id, generation, shard: row.shard }));
    });
  }

  /** CAS-release only after the target identity is gone; an opaque release receipt makes lost ACKs retryable. */
  release(provider: string, subject: string, generation: string, userId: string): void {
    if (!syntheticPlacementIdentity(provider, subject)) throw new AppError("unavailable", "placement fencing is restricted to synthetic identities");
    this.transaction(() => {
      if (this.sql.exec(`SELECT generation FROM placement_releases WHERE generation=?`, generation).toArray().length) return;
      const home = this.home(provider, subject);
      if (!home || home.generation !== generation || home.user_id !== userId || home.placement_state !== "closing")
        throw new AppError("unavailable", "account placement requires review");
      if (this.sql.exec(`SELECT attempt_id FROM placement_attempts WHERE generation=? LIMIT 1`, generation).toArray().length)
        throw new AppError("unavailable", "account placement attempts are unresolved");
      this.sql.exec(`INSERT INTO placement_releases(generation) VALUES (?)`, generation);
      this.sql.exec(`DELETE FROM identity_homes WHERE provider=? AND subject=? AND generation=? AND user_id=?`, provider, subject, generation, userId);
    });
  }
}
