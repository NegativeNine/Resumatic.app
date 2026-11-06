import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { errorCode, errorDetail } from "../shared/errors";

/** Quick steps that touch the vault or R2. */
export const STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

/** Steps that call models. */
export const MODEL_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

const FINAL = new Set([
  "gone",
  "not_found",
  "forbidden",
  "invalid",
  "conflict",
  "too_large",
  "quota",
]);

/** Runs a step body, turning errors that a retry cannot fix (a deleted vault, bad input) into non-retryable ones. */
export function once<T>(body: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await body();
    } catch (e) {
      const code = errorCode(e);
      if (code && FINAL.has(code))
        throw new NonRetryableError(`${code}: ${errorDetail(e)}`);
      throw e;
    }
  };
}

/** A short message for the user about why a run stopped. Never includes career text. */
export function userMessage(e: unknown, fallback: string): string {
  const code = errorCode(e);
  if (code && code !== "unavailable") return capitalise(errorDetail(e));
  return fallback;
}

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}
