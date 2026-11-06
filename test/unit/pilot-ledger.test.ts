import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PILOT_SCHEMA, PilotLedger } from "../../src/worker/pilot/ledger";

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const statement of PILOT_SCHEMA) db.exec(statement);
  const sql = {
    exec(statement: string, ...params: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...params);
      return { toArray: () => rows, one: () => {
        if (rows.length !== 1) throw new Error("expected one row");
        return rows[0];
      } };
    },
  } as unknown as SqlStorage;
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return { db, ledger: new PilotLedger(sql, transaction) };
}

describe("shared one-shot pilot ledger", () => {
  it("keeps caps fixed and reservations charged across retries and reconstruction", () => {
    const { db, ledger } = fixture();
    try {
      expect(ledger.status()).toEqual({ initialized: false });
      expect(() => ledger.reserve("a", 1, 1)).toThrow(/not initialized/);
      expect(() => ledger.initialize(10_000_001, 50)).toThrow();
      expect(() => ledger.initialize(10_000_000, 51)).toThrow();
      ledger.initialize(10_000_000, 50);
      ledger.reserve("a", 3_000_000, 6);
      ledger.initialize(10_000_000, 50); // idempotent: cannot reset usage
      expect(() => ledger.initialize(9_000_000, 50)).toThrow(/already fixed/);
      expect(() => ledger.reserve("a", 3_000_000, 6)).toThrow(/already reserved/);
      expect(ledger.status()).toMatchObject({ reservedMicros: 3_000_000, reservedCalls: 6, pending: 1 });
      expect(() => db.exec("DELETE FROM pilot_meta")).toThrow();
      expect(() => db.exec("UPDATE pilot_meta SET used_calls=0")).toThrow();
      expect(() => db.exec("DELETE FROM pilot_attempts")).toThrow();
      expect(ledger.settle("a", 2_000_000)).toEqual({ frozen: false });
      expect(ledger.settle("a", 2_000_000)).toEqual({ frozen: false });
      expect(() => ledger.settle("a", 1)).toThrow(/changed/);
      expect(ledger.status()).toMatchObject({ reservedMicros: 3_000_000, reservedCalls: 6, pending: 0 });
    } finally { db.close(); }
  });

  it("atomically rejects reservations that exceed the combined cost or call limits", () => {
    const { db, ledger } = fixture();
    try {
      ledger.initialize(100, 8);
      ledger.reserve("one", 70, 6);
      expect(() => ledger.reserve("cost", 31, 1)).toThrow(/exhausted/);
      expect(() => ledger.reserve("calls", 1, 3)).toThrow(/exhausted/);
      ledger.reserve("two", 30, 2);
      expect(ledger.status()).toMatchObject({ reservedMicros: 100, reservedCalls: 8, pending: 2 });
      expect(() => ledger.reserve("three", 1, 1)).toThrow(/exhausted/);
    } finally { db.close(); }
  });

  it.each([null, 101])("freezes the campaign when usage is unknown or exceeds the reservation: %s", (actual) => {
    const { db, ledger } = fixture();
    try {
      ledger.initialize(1000, 10);
      ledger.reserve("one", 100, 1);
      expect(ledger.settle("one", actual)).toEqual({ frozen: true });
      expect(ledger.settle("one", actual)).toEqual({ frozen: true });
      expect(() => ledger.reserve("two", 1, 1)).toThrow(/frozen/);
      expect(() => db.exec("UPDATE pilot_meta SET frozen=0")).toThrow();
      expect(ledger.status()).toMatchObject({ reservedMicros: 100, reservedCalls: 1, frozen: true });
    } finally { db.close(); }
  });

  it("keeps unknown and invalid state fail-closed", () => {
    const { db, ledger } = fixture();
    try {
      ledger.initialize(100, 1);
      expect(() => ledger.settle("missing", 1)).toThrow(/not reserved/);
      expect(() => ledger.reserve("bad/id", 1, 1)).toThrow();
      expect(() => ledger.reserve("zero", 0, 1)).toThrow();
      ledger.freeze();
      ledger.freeze();
      expect(() => ledger.reserve("later", 1, 1)).toThrow(/frozen/);
    } finally { db.close(); }
  });

  it("returns one bounded accounting snapshot and rejects inconsistencies", () => {
    const { db, ledger } = fixture();
    try {
      ledger.initialize(1000, 10);
      ledger.reserve("first", 100, 2);
      ledger.reserve("second", 30, 1);
      ledger.settle("first", 90);
      expect(ledger.auditAttempts()).toEqual({ totals: {
        maxMicros: 1000, maxCalls: 10, reservedMicros: 130, reservedCalls: 3,
        frozen: false, count: 2, pending: 1, unknown: 0, overrun: 0,
      }, attempts: [
        { id: "first", reservedMicros: 100, reservedCalls: 2, state: "settled", actualMicros: 90 },
        { id: "second", reservedMicros: 30, reservedCalls: 1, state: "pending", actualMicros: null },
      ] });
      expect(ledger.status()).toMatchObject({ reservedMicros: 130, reservedCalls: 3, pending: 1 });
      // The audit checks its totals against the immutable counters and refuses
      // corrupted rows rather than making a partial inventory appear complete.
      db.exec("UPDATE pilot_meta SET used_micros=131");
      expect(() => ledger.auditAttempts()).toThrow(/ledger is invalid/);
    } finally { db.close(); }
  });

  it.each(["unknown", "overrun"])("rejects an unfrozen %s attempt in the audit snapshot", (state) => {
    const { db, ledger } = fixture();
    try {
      ledger.initialize(1000, 10);
      ledger.reserve("first", 100, 1);
      db.prepare("UPDATE pilot_attempts SET state=?,actual_micros=? WHERE id='first'")
        .run(state, state === "unknown" ? null : 101);
      expect(() => ledger.auditAttempts()).toThrow(/ledger is invalid/);
    } finally { db.close(); }
  });
});
