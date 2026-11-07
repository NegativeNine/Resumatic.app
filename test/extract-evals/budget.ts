import {
  reservePilotLedger,
  settlePilotAttempt,
  freezePilotLedger,
} from "./budget-ledger.mjs";
import { MODEL_PRICES, type Usage } from "../../src/ai/usage";

export interface EvalBudgetConfig {
  usd: number;
  maxCalls: number;
  prices?: Record<string, readonly [number, number]>;
  ledger?: { file: string; suite: string };
}

/** Reservation is conservative and never refunded; actual provider spend is also reported. */
export class EvalBudget {
  calls = 0;
  reservedUsd = 0;
  measuredUsd = 0;
  unpricedCalls = 0;
  private readonly prices: Readonly<Record<string, readonly [number, number]>>;
  private readonly attempts = new Map<
    string,
    { model: string; reservedMicros: number }
  >();
  private readonly seenAttempts = new Set<string>();
  private frozen = false;
  constructor(private readonly config: EvalBudgetConfig) {
    if (
      !Number.isFinite(config.usd) ||
      config.usd <= 0 ||
      !Number.isSafeInteger(Math.floor(config.usd * 1_000_000)) ||
      !Number.isSafeInteger(config.maxCalls) ||
      config.maxCalls < 1
    )
      throw new Error("live_eval_budget_required");
    this.prices = { ...MODEL_PRICES, ...config.prices };
    for (const price of Object.values(this.prices))
      if (
        !Array.isArray(price) ||
        price.length !== 2 ||
        price.some((p) => !Number.isFinite(p) || p < 0) ||
        price.every((p) => p === 0)
      )
        throw new Error("live_eval_price_invalid");
  }
  /** Metadata only: use the already-reserved bound when coordinating a second ledger. */
  reservation(attemptId: string): number {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error("live_eval_ledger_unavailable");
    return attempt.reservedMicros;
  }
  /** Recompute against the reviewed price table before any response is exposed. */
  actualMicros(usage: Usage): number | null {
    const attempt = usage.attemptId ? this.attempts.get(usage.attemptId) : undefined;
    if (!attempt || attempt.model !== usage.model) return null;
    const price = this.prices[usage.model];
    if (!price || !Number.isSafeInteger(usage.inputTokens) || (usage.inputTokens ?? -1) < 0 ||
        (usage.outputTokens === null ? price[1] !== 0 : !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0)) return null;
    const micros = Math.ceil((usage.inputTokens ?? 0) * price[0] + (usage.outputTokens ?? 0) * price[1]);
    return Number.isSafeInteger(micros) && micros >= 0 ? micros : null;
  }
  reserve(
    model: string,
    input: string,
    maxOutputTokens: number,
    passes = 1,
    attemptWeight = 1,
    attemptId = crypto.randomUUID(),
  ): string {
    if (this.frozen) throw new Error("live_eval_campaign_frozen");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(attemptId)) throw new Error("live_eval_attempt_invalid");
    if (this.seenAttempts.has(attemptId)) throw new Error("live_eval_attempt_duplicate");
    const price = this.prices[model];
    if (!price) throw new Error("live_eval_model_price_required");
    if (
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 0 ||
      !Number.isSafeInteger(passes) ||
      passes < 1 ||
      passes > 100 ||
      !Number.isSafeInteger(attemptWeight) ||
      attemptWeight < 1 ||
      attemptWeight > 100 ||
      price[0] <= 0 ||
      (maxOutputTokens > 0 && price[1] <= 0) ||
      // Zero is the input-only sentinel, not a provider output limit. If the
      // reviewed table prices output, it cannot bound this request's spend.
      (maxOutputTokens === 0 && price[1] > 0)
    )
      throw new Error("live_eval_cost_bound_invalid");
    // Includes the serialized payload, schema and messages; four tokens per UTF-8
    // byte plus 4096 overhead is deliberately conservative, not a provider guarantee.
    const inputBound = new TextEncoder().encode(input).length * 4 + 4096;
    const cost =
      ((inputBound * price[0] + maxOutputTokens * price[1]) * passes) /
      1_000_000;
    const micros = Math.max(1, Math.ceil(cost * 1_000_000));
    const reservedMicros = Math.round(this.reservedUsd * 1_000_000);
    const budgetMicros = Math.floor(this.config.usd * 1_000_000);
    if (
      !Number.isFinite(cost) ||
      cost <= 0 ||
      !Number.isSafeInteger(micros) ||
      !Number.isSafeInteger(reservedMicros) ||
      this.calls + attemptWeight > this.config.maxCalls ||
      micros > budgetMicros - reservedMicros
    )
      throw new Error("live_eval_budget_exhausted");
    if (this.config.ledger) {
      const result = reservePilotLedger(
        this.config.ledger.file,
        this.config.ledger.suite,
        budgetMicros,
        this.config.maxCalls,
        micros,
        attemptWeight,
        attemptId,
      );
      this.calls = result.calls;
      this.reservedUsd = result.reservedUsd;
    } else {
      this.calls += attemptWeight;
      this.reservedUsd = (reservedMicros + micros) / 1_000_000;
    }
    this.attempts.set(attemptId, {
      model,
      reservedMicros: micros,
    });
    this.seenAttempts.add(attemptId);
    return attemptId;
  }
  observe(usage: Usage): Usage {
    const price = this.prices[usage.model];
    const costUsd =
      price &&
      usage.inputTokens !== null &&
      (usage.outputTokens !== null || price[1] === 0)
        ? (usage.inputTokens * price[0] +
            (usage.outputTokens ?? 0) * price[1]) /
          1_000_000
        : null;
    if (usage.attemptId) {
      const attempt = this.attempts.get(usage.attemptId);
      if (!attempt || attempt.model !== usage.model) {
        this.frozen = true;
        if (this.config.ledger) {
          try { freezePilotLedger(this.config.ledger.file); } catch { /* unavailable ledger stays unresolved */ }
        }
        throw new Error("live_eval_ledger_unavailable");
      }
      // Apply the same integer, non-negative token validation used by the
      // shared coordinator. Otherwise a malformed report (for example, a
      // negative input count offset by positive output) can settle locally
      // as a valid undercount even though the shared ledger froze it.
      const actualMicros = this.actualMicros(usage);
      if (this.config.ledger) {
        try {
          settlePilotAttempt(
            this.config.ledger.file,
            this.config.ledger.suite,
            usage.attemptId,
            actualMicros,
          );
        } catch (error) {
          this.frozen = true;
          try { freezePilotLedger(this.config.ledger.file); } catch { /* unavailable ledger stays unresolved */ }
          throw error;
        }
      }
      this.attempts.delete(usage.attemptId);
      if (actualMicros === null || actualMicros > attempt.reservedMicros) {
        this.frozen = true;
        throw new Error("live_eval_campaign_frozen");
      }
    } else {
      this.frozen = true;
      if (this.config.ledger) {
        try { freezePilotLedger(this.config.ledger.file); } catch { /* unavailable ledger stays unresolved */ }
      }
      throw new Error("live_eval_ledger_unavailable");
    }
    if (costUsd === null) this.unpricedCalls += 1;
    else this.measuredUsd += costUsd;
    return { ...usage, costUsd };
  }
  failAttempt(attemptId: string): void {
    if (!this.attempts.has(attemptId))
      throw new Error("live_eval_ledger_unavailable");
    this.frozen = true;
    if (this.config.ledger) {
      try {
        settlePilotAttempt(
          this.config.ledger.file,
          this.config.ledger.suite,
          attemptId,
          null,
        );
      } catch (error) {
        try { freezePilotLedger(this.config.ledger.file); } catch { /* unavailable ledger stays unresolved */ }
        throw error;
      }
    }
    this.attempts.delete(attemptId);
  }
}

let shared: EvalBudget | undefined;
/** Shared across cases in one process, so each case cannot reset the spending allowance. */
export function evalBudgetFromEnv(): EvalBudget {
  if (shared) return shared;
  let prices: Record<string, readonly [number, number]> | undefined;
  if (process.env.EVAL_MODEL_PRICES) {
    try {
      prices = JSON.parse(process.env.EVAL_MODEL_PRICES);
    } catch {
      throw new Error("live_eval_price_invalid");
    }
    if (!prices || typeof prices !== "object" || Array.isArray(prices))
      throw new Error("live_eval_price_invalid");
  }
  const ledgerFile = process.env.EVAL_BUDGET_LEDGER;
  const ledgerSuite = process.env.EVAL_BUDGET_LEDGER_SUITE;
  if (!!ledgerFile !== !!ledgerSuite)
    throw new Error("live_eval_ledger_unavailable");
  shared = new EvalBudget({
    usd: Number(process.env.EVAL_BUDGET_USD),
    maxCalls: Number(process.env.EVAL_MAX_CALLS),
    prices,
    ...(ledgerFile && ledgerSuite
      ? { ledger: { file: ledgerFile, suite: ledgerSuite } }
      : {}),
  });
  return shared;
}
