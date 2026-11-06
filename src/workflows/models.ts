import { models, type Models } from "../ai/models";
import { MODEL_PRICES, type ModelAttempt } from "../ai/usage";
import { AppError } from "../shared/errors";
import { vault } from "../shared/stubs";
import { stagingPilotBudget } from "../worker/pilot/access";
import type { PilotIdentityPath } from "../worker/pilot/ledger";
import { sharedPilotSafetyReady } from "./pilot-readiness";

// AI Gateway documents up to five retries. Until live verification proves
// otherwise, reserve for the initial request plus all five for every call.
// This is a reservation, not a claim about the provider's actual behavior.
const PILOT_GATEWAY_ATTEMPTS = 6;
const PILOT_CHAT_ROUTES = new Set(["extract", "analyze", "write", "repair", "judge"]);

/** Reserve every provider attempt, including schema retries, before it leaves the Worker. */
export function runModels(
  env: Env,
  vaultId: string,
  runId: string,
  step: string,
  identityPath: PilotIdentityPath | null = null,
): Models {
  const v = vault(env, vaultId);
  const started = new Map<string, number>();
  const prices = priceTable(env.MODEL_PRICES_JSON);
  if (env.PILOT_SHARED_BUDGET !== undefined && !["true", "false"].includes(env.PILOT_SHARED_BUDGET))
    throw new AppError("unavailable", "pilot budget configuration is invalid");
  const pilot = env.PILOT_SHARED_BUDGET === "true" ? stagingPilotBudget(env) : null;
  const base = models(env, {
    async onAttemptStart(attempt) {
      // An authenticated diagnostic can observe only real call sites, with no
      // provider request. The nonce stays in the ledger, not Workflow state.
      if (pilot && identityPath && await pilot.observeIdentity(identityPath, vaultId, runId, step, env.PILOT_VERSION_METADATA?.id ?? ""))
        throw new AppError("unavailable", "pilot identity observation complete; no model call was made");
      if (pilot && !sharedPilotSafetyReady())
        throw new AppError("unavailable", "shared pilot identity and provider bounds are not verified");
      const cap = Number(env.DAILY_SPEND_CAP_USD);
      if (!Number.isFinite(cap) || cap <= 0)
        throw new AppError("unavailable", "model spending is not configured");
      const price = prices[attempt.model];
      // Workers AI bindings and conversion have unverified hidden attempts or
      // usage bounds. A flat configured amount is not a proven provider cap.
      // Workers AI models may also be reached through the chat endpoint. A
      // chat-shaped request does not establish their billing or retry bounds.
      if (pilot && (!PILOT_CHAT_ROUTES.has(attempt.route) || attempt.model.startsWith("@") || !price))
        throw new AppError("unavailable", "this model route is not bounded for the shared pilot");
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
      const reserved = pilot ? upper * PILOT_GATEWAY_ATTEMPTS : upper;
      if (!Number.isSafeInteger(reserved) || reserved <= 0)
        throw new AppError(
          "unavailable",
          "this model has no configured cost bound",
        );
      if (pilot) await pilot.reserve(attempt.attemptId, reserved, PILOT_GATEWAY_ATTEMPTS);
      try {
        await v.reserveModelAttempt(
          runId,
          step,
          attempt,
          reserved,
          Math.floor(cap * 1_000_000),
        );
      } catch (error) {
        // No provider call was made; preserve the nonrefundable reservation.
        // If settlement is uncertain the durable pilot record remains pending.
        if (pilot) await pilot.settle(attempt.attemptId, 0);
        throw error;
      }
      started.set(attempt.attemptId, Date.now());
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
      const shared = pilot ? await pilot.settle(usage.attemptId, cost) : null;
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
      // Missing usage and an overrun freeze the shared ledger and cannot be
      // exposed as a successful pilot call even if the provider replied.
      if (shared?.frozen) throw new AppError("unavailable", "the shared pilot budget is frozen");
    },
    async onAttemptError(attempt: ModelAttempt) {
      if (pilot) await pilot.settle(attempt.attemptId, null);
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
