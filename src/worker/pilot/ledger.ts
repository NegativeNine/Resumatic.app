import { AppError } from "../../shared/errors";

// The user authorized one combined pilot of at most $10 and 50 attempts.
// Reservations are in integer microdollars and are never refunded.
export const PILOT_MAX_MICROS = 10_000_000;
export const PILOT_MAX_CALLS = 50;
export const PILOT_LEDGER_NAME = "first-staging-pilot-v1";
export const PILOT_IDENTITY_PATHS = ["distill", "tailor", "document", "reembed", "vault"] as const;
export type PilotIdentityPath = typeof PILOT_IDENTITY_PATHS[number];
const PROBE_TTL_MS = 120_000;

export const PILOT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pilot_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_micros INTEGER NOT NULL CHECK (max_micros > 0),
    max_calls INTEGER NOT NULL CHECK (max_calls > 0),
    used_micros INTEGER NOT NULL DEFAULT 0 CHECK (used_micros >= 0),
    used_calls INTEGER NOT NULL DEFAULT 0 CHECK (used_calls >= 0),
    frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS pilot_attempts (
    id TEXT PRIMARY KEY, reserved_micros INTEGER NOT NULL CHECK (reserved_micros > 0),
    reserved_calls INTEGER NOT NULL CHECK (reserved_calls > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'unknown', 'overrun')),
    actual_micros INTEGER
  )`,
  // A public random challenge, not a credential or model payload. It is
  // short-lived and can be consumed only once; it never resets accounting.
  `CREATE TABLE IF NOT EXISTS pilot_identity_probe (
    slot INTEGER PRIMARY KEY CHECK (slot = 1), nonce TEXT NOT NULL,
    path TEXT NOT NULL, vault_id TEXT NOT NULL, worker_version TEXT NOT NULL,
    expires_at INTEGER NOT NULL, run_id TEXT, step TEXT, runtime_version TEXT
  )`,
  `CREATE TRIGGER IF NOT EXISTS pilot_meta_no_delete BEFORE DELETE ON pilot_meta
    BEGIN SELECT RAISE(ABORT, 'pilot reset forbidden'); END`,
  `CREATE TRIGGER IF NOT EXISTS pilot_caps_immutable BEFORE UPDATE OF max_micros,max_calls ON pilot_meta
    WHEN OLD.max_micros != NEW.max_micros OR OLD.max_calls != NEW.max_calls
    BEGIN SELECT RAISE(ABORT, 'pilot caps immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS pilot_no_unfreeze BEFORE UPDATE OF frozen ON pilot_meta
    WHEN OLD.frozen = 1 AND NEW.frozen != 1
    BEGIN SELECT RAISE(ABORT, 'pilot unfreeze forbidden'); END`,
  `CREATE TRIGGER IF NOT EXISTS pilot_usage_monotone BEFORE UPDATE OF used_micros,used_calls ON pilot_meta
    WHEN NEW.used_micros < OLD.used_micros OR NEW.used_calls < OLD.used_calls
    BEGIN SELECT RAISE(ABORT, 'pilot reservations cannot decrease'); END`,
  `CREATE TRIGGER IF NOT EXISTS pilot_attempt_no_delete BEFORE DELETE ON pilot_attempts
    BEGIN SELECT RAISE(ABORT, 'pilot attempt deletion forbidden'); END`,
  `CREATE TRIGGER IF NOT EXISTS pilot_attempt_bounds_immutable BEFORE UPDATE OF id,reserved_micros,reserved_calls ON pilot_attempts
    WHEN OLD.id != NEW.id OR OLD.reserved_micros != NEW.reserved_micros OR OLD.reserved_calls != NEW.reserved_calls
    BEGIN SELECT RAISE(ABORT, 'pilot attempt immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS pilot_attempt_final BEFORE UPDATE OF state,actual_micros ON pilot_attempts
    WHEN OLD.state != 'pending' AND (OLD.state != NEW.state OR OLD.actual_micros IS NOT NEW.actual_micros)
    BEGIN SELECT RAISE(ABORT, 'pilot attempt already final'); END`,
] as const;

type Meta = {
  max_micros: number;
  max_calls: number;
  used_micros: number;
  used_calls: number;
  frozen: number;
};
type Attempt = {
  reserved_micros: number;
  reserved_calls: number;
  state: "pending" | "settled" | "unknown" | "overrun";
  actual_micros: number | null;
};
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const validId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id);

/** SQLite-backed, one-shot shared pilot ledger. No career text enters it. */
export class PilotLedger {
  constructor(private readonly sql: SqlStorage, private readonly transaction: <T>(fn: () => T) => T) {}

  beginIdentity(nonce: string, path: PilotIdentityPath, vaultId: string, workerVersion: string): { nonce: string; expiresAt: number } {
    if (!/^[0-9a-f-]{36}$/i.test(nonce) || !PILOT_IDENTITY_PATHS.includes(path) ||
        !/^[0-9a-f]{64}$/i.test(vaultId) || !validId(workerVersion))
      throw new AppError("invalid", "invalid identity probe");
    return this.transaction(() => {
      const now = Date.now();
      this.sql.exec(`DELETE FROM pilot_identity_probe WHERE expires_at <= ?`, now);
      if (this.sql.exec(`SELECT slot FROM pilot_identity_probe WHERE slot=1`).toArray().length)
        throw new AppError("conflict", "an identity probe is already pending");
      this.sql.exec(`INSERT INTO pilot_identity_probe (slot,nonce,path,vault_id,worker_version,expires_at) VALUES (1,?,?,?,?,?)`, nonce, path, vaultId, workerVersion, now + PROBE_TTL_MS);
      return { nonce, expiresAt: now + PROBE_TTL_MS };
    });
  }

  /** Called from the real model-attempt path, never exposed as an HTTP operation. */
  observeIdentity(path: PilotIdentityPath | null, vaultId: string, runId: string, step: string, runtimeVersion: string): boolean {
    return this.transaction(() => {
      const row = this.sql.exec<{ path: string; vault_id: string; expires_at: number; run_id: string | null }>(
        `SELECT path,vault_id,expires_at,run_id FROM pilot_identity_probe WHERE slot=1`,
      ).toArray()[0];
      if (!row || row.expires_at <= Date.now() || row.run_id !== null || row.path !== path || row.vault_id !== vaultId) return false;
      if (!validId(runId) || !/^[A-Za-z0-9 _:-]{1,100}$/.test(step) || !validId(runtimeVersion))
        throw new AppError("unavailable", "identity probe metadata is unavailable");
      this.sql.exec(`UPDATE pilot_identity_probe SET run_id=?,step=?,runtime_version=? WHERE slot=1 AND run_id IS NULL`, runId, step, runtimeVersion);
      return true;
    });
  }

  identityStatus(nonce: string): { state: "waiting" | "observed" } {
    if (!/^[0-9a-f-]{36}$/i.test(nonce)) throw new AppError("invalid", "invalid identity probe");
    const row = this.sql.exec<{ run_id: string | null; expires_at: number }>(`SELECT run_id,expires_at FROM pilot_identity_probe WHERE slot=1 AND nonce=?`, nonce).toArray()[0];
    if (!row || row.expires_at <= Date.now()) throw new AppError("gone", "identity probe expired or consumed");
    return { state: row.run_id === null ? "waiting" : "observed" };
  }

  consumeIdentity(nonce: string, runId: string): { path: string; vaultId: string; runId: string; step: string; workerVersion: string; runtimeVersion: string } {
    if (!/^[0-9a-f-]{36}$/i.test(nonce) || !validId(runId)) throw new AppError("invalid", "invalid identity probe");
    return this.transaction(() => {
      const row = this.sql.exec<{ path: string; vault_id: string; worker_version: string; expires_at: number; run_id: string | null; step: string | null; runtime_version: string | null }>(
        `SELECT path,vault_id,worker_version,expires_at,run_id,step,runtime_version FROM pilot_identity_probe WHERE slot=1 AND nonce=?`, nonce,
      ).toArray()[0];
      if (!row || row.expires_at <= Date.now()) throw new AppError("gone", "identity probe expired or consumed");
      if (row.run_id !== runId || !row.step || !row.runtime_version) throw new AppError("conflict", "identity observation does not match this run");
      this.sql.exec(`DELETE FROM pilot_identity_probe WHERE slot=1 AND nonce=?`, nonce);
      return { path: row.path, vaultId: row.vault_id, runId, step: row.step, workerVersion: row.worker_version, runtimeVersion: row.runtime_version };
    });
  }

  initialize(maxMicros: number, maxCalls: number): void {
    if (!positive(maxMicros) || maxMicros > PILOT_MAX_MICROS || !positive(maxCalls) || maxCalls > PILOT_MAX_CALLS)
      throw new AppError("invalid", "invalid pilot limits");
    this.transaction(() => {
      const existing = this.meta();
      if (existing) {
        if (existing.max_micros !== maxMicros || existing.max_calls !== maxCalls)
          throw new AppError("conflict", "the pilot limits are already fixed");
        return;
      }
      this.sql.exec(`INSERT INTO pilot_meta (id,max_micros,max_calls) VALUES (1,?,?)`, maxMicros, maxCalls);
    });
  }

  reserve(id: string, micros: number, calls: number): void {
    if (!validId(id) || !positive(micros) || !positive(calls) || calls > PILOT_MAX_CALLS)
      throw new AppError("invalid", "invalid pilot reservation");
    this.transaction(() => {
      const meta = this.requiredMeta();
      if (meta.frozen) throw new AppError("unavailable", "the pilot is frozen");
      // A replay is rejected: an acknowledgement may have been lost, and
      // returning success twice could allow two provider dispatches.
      if (this.attempt(id)) throw new AppError("conflict", "pilot attempt already reserved");
      if (micros > meta.max_micros - meta.used_micros || calls > meta.max_calls - meta.used_calls)
        throw new AppError("quota", "the pilot budget is exhausted");
      this.sql.exec(`INSERT INTO pilot_attempts (id,reserved_micros,reserved_calls,state) VALUES (?,?,?,'pending')`, id, micros, calls);
      this.sql.exec(`UPDATE pilot_meta SET used_micros=used_micros+?,used_calls=used_calls+? WHERE id=1`, micros, calls);
    });
  }

  settle(id: string, actualMicros: number | null): { frozen: boolean } {
    if (!validId(id) || (actualMicros !== null && (!Number.isSafeInteger(actualMicros) || actualMicros < 0)))
      throw new AppError("invalid", "invalid pilot settlement");
    return this.transaction(() => {
      const meta = this.requiredMeta();
      const attempt = this.attempt(id);
      if (!attempt) throw new AppError("conflict", "pilot attempt is not reserved");
      if (attempt.state !== "pending") {
        if (attempt.actual_micros !== actualMicros) throw new AppError("conflict", "pilot settlement changed");
        return { frozen: meta.frozen === 1 };
      }
      const state = actualMicros === null ? "unknown" : actualMicros > attempt.reserved_micros ? "overrun" : "settled";
      this.sql.exec(`UPDATE pilot_attempts SET state=?,actual_micros=? WHERE id=?`, state, actualMicros, id);
      if (state !== "settled") this.sql.exec(`UPDATE pilot_meta SET frozen=1 WHERE id=1`);
      return { frozen: meta.frozen === 1 || state !== "settled" };
    });
  }

  freeze(): void {
    this.transaction(() => { this.requiredMeta(); this.sql.exec(`UPDATE pilot_meta SET frozen=1 WHERE id=1`); });
  }

  status() {
    if (!this.meta()) return { initialized: false as const };
    const meta = this.requiredMeta();
    const counts = this.sql.exec<{ pending: number; unknown: number; overrun: number }>(
      `SELECT COUNT(CASE WHEN state='pending' THEN 1 END) AS pending,
        COUNT(CASE WHEN state='unknown' THEN 1 END) AS unknown,
        COUNT(CASE WHEN state='overrun' THEN 1 END) AS overrun FROM pilot_attempts`,
    ).one();
    return { initialized: true as const, maxMicros: meta.max_micros, maxCalls: meta.max_calls,
      reservedMicros: meta.used_micros, reservedCalls: meta.used_calls, frozen: meta.frozen === 1, ...counts };
  }

  private meta(): Meta | null {
    return this.sql.exec<Meta>(`SELECT max_micros,max_calls,used_micros,used_calls,frozen FROM pilot_meta WHERE id=1`).toArray()[0] ?? null;
  }
  private requiredMeta(): Meta {
    const meta = this.meta();
    if (!meta) throw new AppError("unavailable", "the pilot is not initialized");
    if (![meta.max_micros, meta.max_calls, meta.used_micros, meta.used_calls].every(Number.isSafeInteger) ||
        meta.max_micros < 1 || meta.max_micros > PILOT_MAX_MICROS || meta.max_calls < 1 || meta.max_calls > PILOT_MAX_CALLS ||
        meta.used_micros < 0 || meta.used_micros > meta.max_micros || meta.used_calls < 0 || meta.used_calls > meta.max_calls ||
        ![0, 1].includes(meta.frozen))
      throw new AppError("unavailable", "the pilot ledger is invalid");
    return meta;
  }
  private attempt(id: string): Attempt | null {
    return this.sql.exec<Attempt>(`SELECT reserved_micros,reserved_calls,state,actual_micros FROM pilot_attempts WHERE id=?`, id).toArray()[0] ?? null;
  }
}
