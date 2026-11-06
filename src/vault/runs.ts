import { AppError } from "../shared/errors";
import {
  isTerminalRun,
  RUN_KINDS,
  type BeginRun,
  type CreditState,
  type ModelAttempt,
  type QuotaBalance,
  type QuotaBucket,
  type ReserveModelAttempt,
  type RunKind,
  type RunRecord,
  type RunState,
  type SpendBalance,
} from "../shared/runs";

/** Applied by the vault's ordinary schema migration, never lazily by RunStore. */
export const RUN_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS quota_buckets (
    bucket_key TEXT PRIMARY KEY, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
    allowance INTEGER NOT NULL CHECK (allowance >= 0),
    used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL,
    request_key TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL, state TEXT NOT NULL,
    steps TEXT NOT NULL, next_step INTEGER NOT NULL DEFAULT 0,
    bucket_key TEXT REFERENCES quota_buckets(bucket_key), credit_state TEXT NOT NULL,
    error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS runs_by_state ON runs(state, created_at)`,
  `CREATE TABLE IF NOT EXISTS model_attempts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step TEXT NOT NULL,
    attempt INTEGER NOT NULL, model TEXT NOT NULL, spend_day TEXT NOT NULL,
    max_cost_micros INTEGER NOT NULL CHECK (max_cost_micros >= 0),
    state TEXT NOT NULL, actual_cost_micros INTEGER, input_tokens INTEGER, output_tokens INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS model_attempts_by_day ON model_attempts(spend_day)`,
];

type Transaction = <T>(callback: () => T) => T;
type RunRow = {
  id: string;
  kind: RunKind;
  target_id: string;
  request_key: string;
  input_digest: string;
  state: RunState;
  steps: string;
  next_step: number;
  bucket_key: string | null;
  credit_state: CreditState;
  error_code: string | null;
  created_at: number;
  updated_at: number;
};
type BucketRow = {
  bucket_key: string;
  start_at: number;
  end_at: number;
  allowance: number;
  used: number;
  reserved: number;
};
type AttemptRow = {
  id: string;
  run_id: string;
  step: string;
  attempt: number;
  model: string;
  spend_day: string;
  max_cost_micros: number;
  state: ModelAttempt["state"];
  actual_cost_micros: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
};

/** All callbacks must be synchronous SQL writes; the injected transaction rolls them back on error. */
export class RunStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: Transaction,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): RunRecord | null {
    const row = this.sql
      .exec<RunRow>(`SELECT * FROM runs WHERE id = ?`, id)
      .toArray()[0];
    return row ? runRecord(row) : null;
  }

  findRequest(requestKey: string): RunRecord | null {
    const row = this.sql
      .exec<RunRow>(`SELECT * FROM runs WHERE request_key = ?`, requestKey)
      .toArray()[0];
    return row ? runRecord(row) : null;
  }

  listPending(): RunRecord[] {
    return this.sql
      .exec<RunRow>(
        `SELECT * FROM runs WHERE state IN ('starting', 'running', 'cancel_requested') ORDER BY created_at, id`,
      )
      .toArray()
      .map(runRecord);
  }

  list(limit = 100): RunRecord[] {
    integer(limit, "run limit");
    return this.sql
      .exec<RunRow>(
        `SELECT * FROM runs ORDER BY created_at DESC, id LIMIT ?`,
        Math.min(limit, 1000),
      )
      .toArray()
      .map(runRecord);
  }

  begin(
    input: BeginRun,
    persist?: () => void,
  ): { run: RunRecord; replay: boolean } {
    identifier(input.id);
    identifier(input.targetId);
    identifier(input.requestKey);
    identifier(input.inputDigest);
    if (
      !RUN_KINDS.includes(input.kind) ||
      input.steps.length > 100 ||
      new Set(input.steps).size !== input.steps.length
    ) {
      throw new AppError("invalid", "invalid run definition");
    }
    input.steps.forEach(identifier);
    return this.transaction(() => {
      const previous = this.findRequest(input.requestKey);
      if (previous) {
        if (
          previous.inputDigest !== input.inputDigest ||
          previous.kind !== input.kind ||
          previous.targetId !== input.targetId
        ) {
          throw new AppError(
            "conflict",
            "the request key was already used with different input",
          );
        }
        return { run: previous, replay: true };
      }
      if (this.get(input.id))
        throw new AppError("conflict", "the run ID already exists");
      if (input.quota) {
        this.writeBucket(input.quota);
        const quota = this.quota(input.quota.key)!;
        const now = this.now();
        if (now < quota.startAt || now >= quota.endAt)
          throw new AppError("quota", "this allowance period is not active");
        if (quota.available < 1)
          throw new AppError(
            "quota",
            "the output allowance for this period is exhausted",
          );
        this.sql.exec(
          `UPDATE quota_buckets SET reserved = reserved + 1 WHERE bucket_key = ?`,
          quota.key,
        );
      }
      const now = this.now();
      this.sql.exec(
        `INSERT INTO runs (id, kind, target_id, request_key, input_digest, state, steps, bucket_key, credit_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)`,
        input.id,
        input.kind,
        input.targetId,
        input.requestKey,
        input.inputDigest,
        JSON.stringify(input.steps),
        input.quota?.key ?? null,
        input.quota ? "reserved" : "none",
        now,
        now,
      );
      syncWrite(persist);
      return { run: this.required(input.id), replay: false };
    });
  }

  /** Explicit entitlement publication; changing limits never resets spent/reserved credits. */
  setBucket(bucket: QuotaBucket): QuotaBalance {
    return this.transaction(() => {
      this.writeBucket(bucket);
      return this.quota(bucket.key)!;
    });
  }

  quota(key: string): QuotaBalance | null {
    const row = this.sql
      .exec<BucketRow>(`SELECT * FROM quota_buckets WHERE bucket_key = ?`, key)
      .toArray()[0];
    return row
      ? {
          key: row.bucket_key,
          startAt: row.start_at,
          endAt: row.end_at,
          limit: row.allowance,
          used: row.used,
          reserved: row.reserved,
          available: Math.max(0, row.allowance - row.used - row.reserved),
        }
      : null;
  }

  claim(id: string): RunRecord {
    return this.transaction(() => {
      const run = this.active(id);
      if (run.state === "starting")
        this.sql.exec(
          `UPDATE runs SET state = 'running', error_code = NULL, updated_at = ? WHERE id = ?`,
          this.now(),
          id,
        );
      return this.required(id);
    });
  }

  commitStep(
    id: string,
    step: string,
    write: () => void,
  ): { applied: boolean } {
    return this.transaction(() => {
      const run = this.required(id);
      const index = run.steps.indexOf(step);
      if (index < 0) throw new AppError("invalid", "unknown run step");
      if (
        (run.state === "running" || run.state === "succeeded") &&
        index < run.nextStep
      )
        return { applied: false };
      this.active(id);
      if (index !== run.nextStep)
        throw new AppError("conflict", "run steps must finish in order");
      syncWrite(write);
      this.sql.exec(
        `UPDATE runs SET state = 'running', next_step = next_step + 1, error_code = NULL, updated_at = ? WHERE id = ?`,
        this.now(),
        id,
      );
      return { applied: true };
    });
  }

  /** publish must perform its input-revision check and all output writes in this transaction. */
  finish(
    id: string,
    publish: () => void,
    consumeCredit = true,
  ): { applied: boolean } {
    return this.transaction(() => {
      const run = this.required(id);
      if (run.state === "succeeded") return { applied: false };
      this.active(id);
      if (run.nextStep !== run.steps.length)
        throw new AppError("conflict", "the run still has unfinished steps");
      syncWrite(publish);
      if (run.creditState === "reserved") {
        this.sql.exec(
          `UPDATE quota_buckets SET reserved = reserved - 1, used = used + ? WHERE bucket_key = ?`,
          consumeCredit ? 1 : 0,
          run.bucketKey,
        );
      }
      this.sql.exec(
        `UPDATE runs SET state = 'succeeded', credit_state = ?, error_code = NULL, updated_at = ? WHERE id = ?`,
        run.creditState === "reserved"
          ? consumeCredit
            ? "consumed"
            : "released"
          : run.creditState,
        this.now(),
        id,
      );
      return { applied: true };
    });
  }

  fail(id: string, code: string): RunRecord {
    codeOnly(code);
    return this.transaction(() => {
      const run = this.required(id);
      if (isTerminalRun(run.state) || run.state === "cancel_requested")
        return run;
      this.release(run, "failed", code);
      return this.required(id);
    });
  }

  requestCancel(id: string): RunRecord {
    return this.transaction(() => {
      const run = this.required(id);
      if (!isTerminalRun(run.state))
        this.sql.exec(
          `UPDATE runs SET state = 'cancel_requested', updated_at = ? WHERE id = ?`,
          this.now(),
          id,
        );
      return this.required(id);
    });
  }

  /** Call only after platform termination/absence is confirmed. */
  cancel(id: string): RunRecord {
    return this.transaction(() => {
      const run = this.required(id);
      if (isTerminalRun(run.state)) return run;
      if (run.state !== "cancel_requested")
        throw new AppError(
          "conflict",
          "request cancellation before completing it",
        );
      this.release(run, "cancelled", null);
      return this.required(id);
    });
  }

  noteUncertain(id: string, code: string): void {
    codeOnly(code);
    this.transaction(() => {
      const run = this.required(id);
      if (!isTerminalRun(run.state))
        this.sql.exec(
          `UPDATE runs SET error_code = ?, updated_at = ? WHERE id = ?`,
          code,
          this.now(),
          id,
        );
    });
  }

  reserveAttempt(
    input: ReserveModelAttempt,
    dailyCapMicros: number,
    lifetime?: { maxCostMicros: number; maxCalls: number },
  ): ModelAttempt {
    identifier(input.id);
    identifier(input.model);
    identifier(input.step);
    integer(input.maxCostMicros, "model reservation");
    integer(dailyCapMicros, "daily spend cap");
    integer(input.attempt, "attempt number");
    if (input.attempt < 1)
      throw new AppError("invalid", "attempt numbers start at one");
    return this.transaction(() => {
      const previous = this.attempt(input.id);
      if (previous) {
        if (
          previous.runId !== input.runId ||
          previous.step !== input.step ||
          previous.attempt !== input.attempt ||
          previous.model !== input.model ||
          previous.maxCostMicros !== input.maxCostMicros
        ) {
          throw new AppError(
            "conflict",
            "the model attempt key was already used",
          );
        }
        return previous;
      }
      const run = this.active(input.runId);
      if (run.state !== "running")
        throw new AppError("conflict", "claim the run before calling models");
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (lifetime) {
        integer(lifetime.maxCostMicros, "lifetime model spend cap");
        integer(lifetime.maxCalls, "lifetime model call cap");
        const total = this.sql
          .exec<{ calls: number; cost: number }>(
            `SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_cost_micros ELSE max_cost_micros END), 0) AS cost FROM model_attempts`,
          )
          .one();
        if (
          total.calls >= lifetime.maxCalls ||
          input.maxCostMicros > lifetime.maxCostMicros - total.cost
        )
          throw new AppError("quota", "the test model budget is exhausted");
      }
      const spend = this.dailySpend(day);
      if (
        dailyCapMicros === 0 ||
        input.maxCostMicros >
          dailyCapMicros - spend.spentMicros - spend.reservedMicros
      ) {
        throw new AppError(
          "quota",
          "the configured model spend budget is exhausted",
        );
      }
      this.sql.exec(
        `INSERT INTO model_attempts (id, run_id, step, attempt, model, spend_day, max_cost_micros, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved')`,
        input.id,
        input.runId,
        input.step,
        input.attempt,
        input.model,
        day,
        input.maxCostMicros,
      );
      return this.attempt(input.id)!;
    });
  }

  attempt(id: string): ModelAttempt | null {
    const row = this.sql
      .exec<AttemptRow>(`SELECT * FROM model_attempts WHERE id = ?`, id)
      .toArray()[0];
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          step: row.step,
          attempt: row.attempt,
          model: row.model,
          spendDay: row.spend_day,
          maxCostMicros: row.max_cost_micros,
          state: row.state,
          actualCostMicros: row.actual_cost_micros,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
        }
      : null;
  }

  /** Settlement remains allowed after cancellation: stopping a run cannot undo provider charges. */
  settleAttempt(
    id: string,
    actualCostMicros: number,
    usage?: { inputTokens: number; outputTokens: number },
  ): ModelAttempt {
    integer(actualCostMicros, "actual model cost");
    if (usage) {
      integer(usage.inputTokens, "input tokens");
      integer(usage.outputTokens, "output tokens");
    }
    return this.transaction(() => {
      const attempt = this.attempt(id);
      if (!attempt) throw new AppError("not_found", "no such model attempt");
      if (attempt.state === "settled") {
        if (
          attempt.actualCostMicros !== actualCostMicros ||
          (usage &&
            (attempt.inputTokens !== usage.inputTokens ||
              attempt.outputTokens !== usage.outputTokens))
        )
          throw new AppError(
            "conflict",
            "the model attempt is already settled",
          );
        return attempt;
      }
      // Record even an unexpectedly expensive bill; never hide spend to make a cap appear intact.
      this.sql.exec(
        `UPDATE model_attempts SET state = 'settled', actual_cost_micros = ?, input_tokens = ?, output_tokens = ? WHERE id = ?`,
        actualCostMicros,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        id,
      );
      return this.attempt(id)!;
    });
  }

  markAttemptUnknown(id: string): void {
    if (!this.attempt(id))
      throw new AppError("not_found", "no such model attempt");
    this.sql.exec(
      `UPDATE model_attempts SET state = 'unknown' WHERE id = ? AND state = 'reserved'`,
      id,
    );
  }

  dailySpend(
    day = new Date(this.now()).toISOString().slice(0, 10),
  ): SpendBalance {
    const row = this.sql
      .exec<{ spent: number; reserved: number; unknown: number }>(
        `SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_cost_micros ELSE 0 END), 0) AS spent,
        COALESCE(SUM(CASE WHEN state != 'settled' THEN max_cost_micros ELSE 0 END), 0) AS reserved,
        COALESCE(SUM(CASE WHEN state = 'unknown' THEN max_cost_micros ELSE 0 END), 0) AS unknown
       FROM model_attempts WHERE spend_day = ?`,
        day,
      )
      .one();
    return {
      day,
      spentMicros: row.spent,
      reservedMicros: row.reserved,
      unknownMicros: row.unknown,
    };
  }

  private required(id: string): RunRecord {
    const run = this.get(id);
    if (!run) throw new AppError("not_found", "no such run");
    return run;
  }

  private active(id: string): RunRecord {
    const run = this.required(id);
    if (run.state !== "starting" && run.state !== "running")
      throw new AppError("conflict", "this run no longer accepts writes");
    return run;
  }

  private writeBucket(bucket: QuotaBucket): void {
    identifier(bucket.key);
    integer(bucket.limit, "output allowance");
    integer(bucket.startAt, "period start");
    integer(bucket.endAt, "period end");
    if (bucket.startAt >= bucket.endAt)
      throw new AppError("invalid", "the allowance period is empty");
    const previous = this.quota(bucket.key);
    if (
      previous &&
      (previous.startAt !== bucket.startAt || previous.endAt !== bucket.endAt)
    )
      throw new AppError(
        "conflict",
        "an allowance period cannot change its boundaries",
      );
    this.sql.exec(
      `INSERT INTO quota_buckets (bucket_key, start_at, end_at, allowance) VALUES (?, ?, ?, ?) ON CONFLICT (bucket_key) DO UPDATE SET allowance = excluded.allowance`,
      bucket.key,
      bucket.startAt,
      bucket.endAt,
      bucket.limit,
    );
  }

  private release(
    run: RunRecord,
    state: "failed" | "cancelled",
    code: string | null,
  ): void {
    if (run.creditState === "reserved")
      this.sql.exec(
        `UPDATE quota_buckets SET reserved = reserved - 1 WHERE bucket_key = ?`,
        run.bucketKey,
      );
    this.sql.exec(
      `UPDATE runs SET state = ?, credit_state = ?, error_code = ?, updated_at = ? WHERE id = ?`,
      state,
      run.creditState === "reserved" ? "released" : run.creditState,
      code,
      this.now(),
      run.id,
    );
  }
}

function runRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    requestKey: row.request_key,
    inputDigest: row.input_digest,
    state: row.state,
    steps: JSON.parse(row.steps) as string[],
    nextStep: row.next_step,
    bucketKey: row.bucket_key,
    creditState: row.credit_state,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function identifier(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 300)
    throw new AppError("invalid", "invalid run identifier");
}

function codeOnly(value: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    throw new AppError("invalid", "use a stable error code");
}

function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AppError("invalid", `${name} must be a nonnegative safe integer`);
}

function syncWrite(write?: () => void): void {
  const result: unknown = write?.();
  if (result && typeof (result as { then?: unknown }).then === "function")
    throw new AppError(
      "invalid",
      "run transaction callbacks must be synchronous",
    );
}
