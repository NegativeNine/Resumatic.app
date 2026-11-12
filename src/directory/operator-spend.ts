import type { ModelAttempt } from "../ai/usage";
import { AppError } from "../shared/errors";

// Model spend that is no person's: an operator's job, such as building the taxonomy's vector
// index (src/workflows/taxonomy-index.ts). It is reserved before each call and settled after it,
// by the rules a vault's own runs follow (RunStore.reserveAttempt in src/vault/runs.ts), against
// the same DAILY_SPEND_CAP_USD as a separate daily total. Only the global Directory keeps it.

/**
 * Operator model spend (taxonomy index builds). No personal data: outside deletion, export and
 * transfer. A row names a Workflow instance, a step and a model, with amounts; nothing in it is
 * anyone's career text or identity, and no account's deletion has anything here to erase.
 */
export const OPERATOR_SPEND_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS operator_model_attempts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step TEXT NOT NULL, model TEXT NOT NULL,
    spend_day TEXT NOT NULL, max_cost_micros INTEGER NOT NULL CHECK (max_cost_micros >= 0),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'unknown')),
    actual_cost_micros INTEGER, input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS operator_model_attempts_by_day ON operator_model_attempts (spend_day)`,
];

type AttemptRow = {
  id: string;
  run_id: string;
  step: string;
  model: string;
  spend_day: string;
  max_cost_micros: number;
  state: "reserved" | "settled" | "unknown";
  actual_cost_micros: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: number;
};

/** A Workflow instance ID. It is a label for the attempt, not an authority: only Worker code reaches the Directory. */
const RUN_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) throw new AppError("invalid", "invalid run identifier");
}

function integer(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("invalid", `${name} must be a nonnegative safe integer`);
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** All callbacks are synchronous SQL; the injected transaction rolls them back on error. */
export class OperatorSpendStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(fn: () => T) => T,
    /** Only the coordinator, the global Directory, keeps operator spend. */
    private readonly global: boolean,
  ) {}

  /**
   * Reserves a call's most it can cost before it is sent. The same attempt reserved again with the
   * same fields is the reservation already made; with other fields it is refused. A cap of zero, or
   * a day whose settled cost, unsettled reservations and this one would pass the cap, is refused
   * with nothing written.
   */
  reserve(runId: string, step: string, attempt: ModelAttempt, maxCostMicros: number, dailyCapMicros: number, now = Date.now()): void {
    this.requireGlobal();
    if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new AppError("invalid", "invalid run identifier");
    identifier(attempt?.attemptId);
    identifier(step);
    identifier(attempt.model);
    integer(maxCostMicros, "model reservation");
    integer(dailyCapMicros, "daily spend cap");
    this.transaction(() => {
      const previous = this.attempt(attempt.attemptId);
      if (previous) {
        if (previous.run_id !== runId || previous.step !== step || previous.model !== attempt.model || previous.max_cost_micros !== maxCostMicros)
          throw new AppError("conflict", "the model attempt key was already used");
        return;
      }
      const today = day(now);
      const spend = this.dailySpend(today);
      if (dailyCapMicros === 0 || maxCostMicros > dailyCapMicros - spend.spentMicros - spend.reservedMicros)
        throw new AppError("quota", "the configured model spend budget is exhausted");
      this.sql.exec(
        `INSERT INTO operator_model_attempts (id, run_id, step, model, spend_day, max_cost_micros, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`,
        attempt.attemptId,
        runId,
        step,
        attempt.model,
        today,
        maxCostMicros,
        now,
      );
    });
  }

  /**
   * Settles an attempt at what it cost. A null cost means it is not known, and the attempt goes on
   * counting at its reservation. Stopping a build cannot undo a provider's charge, so settling is
   * always allowed; an attempt settled twice must say the same both times.
   */
  settle(id: string, costMicros: number | null, inputTokens: number | null, outputTokens: number | null): void {
    this.requireGlobal();
    identifier(id);
    if (costMicros !== null) integer(costMicros, "actual model cost");
    if (inputTokens !== null) integer(inputTokens, "input tokens");
    if (outputTokens !== null) integer(outputTokens, "output tokens");
    this.transaction(() => {
      const attempt = this.attempt(id);
      if (!attempt) throw new AppError("not_found", "no such model attempt");
      if (costMicros === null) {
        this.sql.exec(`UPDATE operator_model_attempts SET state = 'unknown' WHERE id = ? AND state = 'reserved'`, id);
        return;
      }
      if (attempt.state === "settled") {
        if (attempt.actual_cost_micros !== costMicros || attempt.input_tokens !== inputTokens || attempt.output_tokens !== outputTokens)
          throw new AppError("conflict", "the model attempt is already settled");
        return;
      }
      // Record even an unexpectedly expensive bill; never hide spend to make a cap appear intact.
      this.sql.exec(
        `UPDATE operator_model_attempts SET state = 'settled', actual_cost_micros = ?, input_tokens = ?, output_tokens = ? WHERE id = ?`,
        costMicros,
        inputTokens,
        outputTokens,
        id,
      );
    });
  }

  /** One UTC day's operator spend: settled cost, and what is reserved and not settled, unknown included. */
  dailySpend(spendDay: string): { spentMicros: number; reservedMicros: number } {
    const row = this.sql
      .exec<{ spent: number; reserved: number }>(
        `SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_cost_micros ELSE 0 END), 0) AS spent,
         COALESCE(SUM(CASE WHEN state != 'settled' THEN max_cost_micros ELSE 0 END), 0) AS reserved
         FROM operator_model_attempts WHERE spend_day = ?`,
        spendDay,
      )
      .one();
    return { spentMicros: row.spent, reservedMicros: row.reserved };
  }

  private attempt(id: string): AttemptRow | null {
    return this.sql.exec<AttemptRow>(`SELECT * FROM operator_model_attempts WHERE id = ?`, id).toArray()[0] ?? null;
  }

  private requireGlobal(): void {
    if (!this.global) throw new AppError("invalid", "operator spending is kept by the coordinator");
  }
}
