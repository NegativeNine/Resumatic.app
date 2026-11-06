import { models, type Models } from "../ai/models";
import { MODEL_PRICES, type ModelAttempt } from "../ai/usage";
import { AppError } from "../shared/errors";
import { vault } from "../shared/stubs";

/** Reserve every provider attempt, including schema retries, before it leaves the Worker. */
export function runModels(
  env: Env,
  vaultId: string,
  runId: string,
  step: string,
): Models {
  const v = vault(env, vaultId);
  const started = new Map<string, number>();
  const prices = priceTable(env.MODEL_PRICES_JSON);
  const base = models(env, {
    async onAttemptStart(attempt) {
      const cap = Number(env.DAILY_SPEND_CAP_USD);
      if (!Number.isFinite(cap) || cap <= 0)
        throw new AppError("unavailable", "model spending is not configured");
      started.set(attempt.attemptId, Date.now());
      const price = prices[attempt.model];
      if (price && (price[0] <= 0 || (attempt.maxOutputTokens > 0 && price[1] <= 0)))
        throw new AppError(
          "unavailable",
          "this model has no configured cost bound",
        );
      // Four tokens per input character is conservative for byte tokenizers; bound unknown services explicitly.
      const upper = price
        ? Math.ceil(
            attempt.inputChars * 4 * price[0] +
              attempt.maxOutputTokens * price[1],
          )
        : Math.ceil(Number(env.MODEL_MAX_CALL_USD) * 1_000_000);
      if (!Number.isSafeInteger(upper) || upper <= 0)
        throw new AppError(
          "unavailable",
          "this model has no configured cost bound",
        );
      await v.reserveModelAttempt(
        runId,
        step,
        attempt,
        upper,
        Math.floor(cap * 1_000_000),
      );
    },
    async onUsage(usage) {
      if (!usage.attemptId) return;
      const price = prices[usage.model];
      const cost =
        usage.inputTokens !== null &&
        price &&
        (usage.outputTokens !== null || price[1] === 0)
          ? Math.ceil(
              usage.inputTokens * price[0] +
                (usage.outputTokens ?? 0) * price[1],
            )
          : usage.costUsd !== null
            ? Math.ceil(usage.costUsd * 1_000_000)
            : null;
      await v.settleModelAttempt(
        usage.attemptId,
        cost,
        usage.inputTokens,
        usage.outputTokens,
      );
      env.METRICS?.writeDataPoint({
        indexes: [vaultId],
        blobs: [
          runId,
          step,
          usage.route,
          usage.model,
          cost === null ? "usage_unknown" : "ok",
        ],
        doubles: [
          Date.now() - (started.get(usage.attemptId) ?? Date.now()),
          usage.inputTokens ?? 0,
          usage.outputTokens ?? 0,
          cost ?? 0,
        ],
      });
    },
    async onAttemptError(attempt: ModelAttempt) {
      await v.settleModelAttempt(attempt.attemptId, null, null, null);
      env.METRICS?.writeDataPoint({
        indexes: [vaultId],
        blobs: [runId, step, attempt.route, attempt.model, "failed"],
        doubles: [
          Date.now() - (started.get(attempt.attemptId) ?? Date.now()),
          0,
          0,
          0,
        ],
      });
    },
  });
  return {
    ...base,
    embed: async (texts, opts) =>
      base.embed(texts, {
        model: opts?.model ?? (await v.embeddingModel(runId)),
      }),
  };
}

function priceTable(
  raw?: string,
): Readonly<Record<string, readonly [number, number]>> {
  if (!raw) return MODEL_PRICES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError("unavailable", "model prices are invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AppError("unavailable", "model prices are invalid");
  for (const value of Object.values(parsed))
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
    )
      throw new AppError("unavailable", "model prices are invalid");
  return { ...MODEL_PRICES, ...(parsed as Record<string, [number, number]>) };
}
