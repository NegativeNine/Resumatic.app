import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ModelAttempt } from "../../src/ai/usage";
import { OPERATOR_SPEND_MIGRATIONS, OperatorSpendStore } from "../../src/directory/operator-spend";

// The operator ledger: model spend that is no person's, kept by the global Directory against the
// daily cap. Each test has a database of its own, in memory.

const RUN = "taxonomy-index-3191aa55-1";
const NOON = Date.UTC(2026, 10, 11, 12);
const attempt = (id: string, model = "@cf/qwen/qwen3-embedding-0.6b"): ModelAttempt => ({ attemptId: id, route: "embed", model, inputChars: 100, maxOutputTokens: 0 });

function ledger(global = true) {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const values = db.prepare(statement).all(...bindings);
      return {
        toArray: () => values,
        one: () => {
          if (values.length !== 1) throw new Error("expected exactly one row");
          return values[0];
        },
      };
    },
  } as unknown as SqlStorage;
  for (const statement of OPERATOR_SPEND_MIGRATIONS) sql.exec(statement);
  // Atomic as the Directory's transactionSync is: everything or nothing.
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const rows = () => db.prepare(`SELECT id, run_id, step, model, spend_day, max_cost_micros, state, actual_cost_micros FROM operator_model_attempts ORDER BY created_at, id`).all();
  return { store: new OperatorSpendStore(sql, transaction, global), rows, db };
}

describe("the operator ledger", () => {
  it("reserves within the daily cap and refuses beyond it, writing nothing", () => {
    const { store, rows, db } = ledger();
    try {
      store.reserve(RUN, "batch 1", attempt("a1"), 600, 1_000, NOON);
      store.reserve(RUN, "batch 2", attempt("a2"), 400, 1_000, NOON);
      expect(rows()).toEqual([
        { id: "a1", run_id: RUN, step: "batch 1", model: "@cf/qwen/qwen3-embedding-0.6b", spend_day: "2026-11-11", max_cost_micros: 600, state: "reserved", actual_cost_micros: null },
        { id: "a2", run_id: RUN, step: "batch 2", model: "@cf/qwen/qwen3-embedding-0.6b", spend_day: "2026-11-11", max_cost_micros: 400, state: "reserved", actual_cost_micros: null },
      ]);
      // The cap is reached: one micro-dollar more is refused, and nothing is written.
      expect(() => store.reserve(RUN, "batch 3", attempt("a3"), 1, 1_000, NOON)).toThrow("quota: the configured model spend budget is exhausted");
      expect(rows()).toHaveLength(2);
      // Settling below the reservation frees what was not spent.
      store.settle("a1", 100, 4_000, null);
      store.reserve(RUN, "batch 3", attempt("a3"), 500, 1_000, NOON);
      expect(() => store.reserve(RUN, "batch 4", attempt("a4"), 1, 1_000, NOON)).toThrow("quota");
      // A cap of zero refuses everything.
      expect(() => ledger().store.reserve(RUN, "batch 1", attempt("z"), 0, 0, NOON)).toThrow("quota");
      // What the rule refuses as input is refused before anything is read.
      for (const [runId, step, at, max, cap] of [
        ["not a run id!", "batch 1", attempt("b1"), 1, 1_000],
        ["-starts-with-a-dash", "batch 1", attempt("b1"), 1, 1_000],
        [RUN, "", attempt("b1"), 1, 1_000],
        [RUN, "batch 1", attempt(""), 1, 1_000],
        [RUN, "batch 1", attempt("b1", "x".repeat(301)), 1, 1_000],
        [RUN, "batch 1", attempt("b1"), -1, 1_000],
        [RUN, "batch 1", attempt("b1"), 1.5, 1_000],
        [RUN, "batch 1", attempt("b1"), 1, Number.MAX_SAFE_INTEGER + 1],
      ] as const)
        expect(() => store.reserve(runId, step, at, max, cap, NOON), JSON.stringify([runId, step, max, cap])).toThrow("invalid");
      expect(rows()).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("is idempotent for one attempt and refuses its key reused", () => {
    const { store, rows, db } = ledger();
    try {
      store.reserve(RUN, "batch 1", attempt("a1"), 600, 1_000, NOON);
      // The same reservation again is the one already made: nothing more is counted.
      store.reserve(RUN, "batch 1", attempt("a1"), 600, 1_000, NOON);
      expect(rows()).toHaveLength(1);
      for (const [runId, step, at, max] of [
        ["taxonomy-index-3191aa55-2", "batch 1", attempt("a1"), 600],
        [RUN, "batch 2", attempt("a1"), 600],
        [RUN, "batch 1", attempt("a1", "@cf/baai/bge-m3"), 600],
        [RUN, "batch 1", attempt("a1"), 601],
      ] as const)
        expect(() => store.reserve(runId, step, at, max, 1_000, NOON)).toThrow("conflict: the model attempt key was already used");
      store.settle("a1", 50, 10, null);
      store.settle("a1", 50, 10, null);
      expect(() => store.settle("a1", 51, 10, null)).toThrow("conflict");
      expect(() => store.settle("nobody", 1, null, null)).toThrow("not_found");
      expect(rows()).toEqual([expect.objectContaining({ id: "a1", state: "settled", actual_cost_micros: 50 })]);
    } finally {
      db.close();
    }
  });

  it("counts unknown attempts at their reservation", () => {
    const { store, rows, db } = ledger();
    try {
      store.reserve(RUN, "batch 1", attempt("a1"), 600, 1_000, NOON);
      store.settle("a1", null, null, null);
      expect(rows()).toEqual([expect.objectContaining({ id: "a1", state: "unknown", actual_cost_micros: null })]);
      expect(store.dailySpend("2026-11-11")).toEqual({ spentMicros: 0, reservedMicros: 600 });
      // Unknown is not free: what it reserved still stands against the cap.
      expect(() => store.reserve(RUN, "batch 2", attempt("a2"), 401, 1_000, NOON)).toThrow("quota");
      store.reserve(RUN, "batch 2", attempt("a2"), 400, 1_000, NOON);
    } finally {
      db.close();
    }
  });

  it("starts a new day at UTC midnight", () => {
    const { store, rows, db } = ledger();
    try {
      const lastMoment = Date.UTC(2026, 10, 11, 23, 59, 59, 999);
      store.reserve(RUN, "batch 1", attempt("a1"), 1_000, 1_000, lastMoment);
      expect(() => store.reserve(RUN, "batch 2", attempt("a2"), 1, 1_000, lastMoment)).toThrow("quota");
      store.reserve(RUN, "batch 2", attempt("a2"), 1_000, 1_000, lastMoment + 1);
      expect(rows().map((row) => (row as { spend_day: string }).spend_day)).toEqual(["2026-11-11", "2026-11-12"]);
    } finally {
      db.close();
    }
  });

  it("refuses outside the coordinator", () => {
    const { store, rows, db } = ledger(false);
    try {
      expect(() => store.reserve(RUN, "batch 1", attempt("a1"), 1, 1_000, NOON)).toThrow("invalid: operator spending is kept by the coordinator");
      expect(() => store.settle("a1", 1, null, null)).toThrow("invalid: operator spending is kept by the coordinator");
      expect(rows()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
