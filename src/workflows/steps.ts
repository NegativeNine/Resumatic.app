import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { errorCode, errorDetail, type ErrorCode } from "../shared/errors";

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

// Step errors are persisted by the Workflow platform. Exception messages from
// parsers, bindings, models or RPCs can include career text, including when
// they happen to begin with an AppError-like code. Only exact, reviewed
// messages may be retained or returned to the user.
const SAFE_DETAILS = new Set([
  "confirm some facts before tailoring a resume",
  "none of your confirmed facts match this job yet",
  "the uploaded file is missing; upload it again",
  "no text could be read from this file",
  "the import source changed; upload it again",
  "the edit could not be verified against its cited facts",
  "experience changed while this draft was being made; generate it again",
  "experience changed; refresh and review again",
]);
const GENERIC_DETAIL: Record<ErrorCode, string> = {
  unauthenticated: "sign-in is required",
  forbidden: "this operation is not permitted",
  not_found: "the requested item is unavailable",
  conflict: "the requested item changed; try again",
  gone: "the requested item is no longer available",
  invalid: "the input could not be processed; check it and try again",
  too_large: "the input is too large to process",
  quota: "the usage limit has been reached",
  unavailable: "the service is temporarily unavailable",
};

function safeDetail(code: ErrorCode, error: unknown): string {
  const detail = errorDetail(error);
  return SAFE_DETAILS.has(detail) ? detail : GENERIC_DETAIL[code];
}

/** Preserve normal retries, but never expose the original exception to a step. */
export function retrySafely<T>(body: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await body();
    } catch (error) {
      const code = errorCode(error);
      const message = code ? `${code}: ${safeDetail(code, error)}` : "workflow step failed";
      if (error instanceof NonRetryableError) throw new NonRetryableError(message);
      throw new Error(message);
    }
  };
}

/** Runs a step body, turning errors that a retry cannot fix (a deleted vault, bad input) into non-retryable ones. */
export function once<T>(body: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await body();
    } catch (e) {
      const code = errorCode(e);
      if (e instanceof NonRetryableError || (code && FINAL.has(code)))
        throw new NonRetryableError(code ? `${code}: ${safeDetail(code, e)}` : "workflow step failed");
      throw new Error(code ? `${code}: ${safeDetail(code, e)}` : "workflow step failed");
    }
  };
}

/** A short message for the user about why a run stopped. Never includes career text. */
export function userMessage(e: unknown, fallback: string): string {
  const code = errorCode(e);
  if (code && code !== "unavailable") return capitalise(safeDetail(code, e));
  return fallback;
}

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}
