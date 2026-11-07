import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { errorCode, errorDetail, type ErrorCode } from "../shared/errors";
import { MODEL_FAILURE_DETAILS } from "../shared/model-failures";
import { asSentence } from "../shared/sentence";

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
  ...MODEL_FAILURE_DETAILS,
  "Confirm some facts before tailoring a resume.",
  "None of your confirmed facts match this job yet. Add facts that cover its requirements, then tailor a new version.",
  "The uploaded file is missing. Upload it again.",
  "No text could be read from this file.",
  "This file couldn't be read. Try a Word file (.docx) or a PDF with selectable text.",
  "This file is too long to read. Upload a resume of a few pages.",
  "The import source changed. Upload it again.",
  "This edit couldn't be checked against the facts it cites. Change the wording or the facts, then try again.",
  "Your facts changed while this draft was being made. Create it again.",
  "Your facts changed. Refresh the page, then review again.",
]);
const GENERIC_DETAIL: Record<ErrorCode, string> = {
  unauthenticated: "Sign in to continue.",
  forbidden: "This isn't available to your account.",
  not_found: "Something this needed is no longer available.",
  conflict: "Something changed while Resumatic was working. Try again.",
  gone: "This is no longer available.",
  invalid: "This couldn't be processed. Check it, then try again.",
  too_large: "This is too large to process.",
  quota: "You've reached a usage limit.",
  unavailable: "Resumatic is busy right now. Try again in a few minutes.",
};

function safeDetail(code: ErrorCode, error: unknown): string {
  const detail = errorDetail(error);
  return SAFE_DETAILS.has(detail) ? detail : GENERIC_DETAIL[code];
}

function isNonRetryable(error: unknown): boolean {
  try {
    return error instanceof NonRetryableError;
  } catch {
    return false;
  }
}

/** Preserve normal retries, but never expose the original exception to a step. */
export function retrySafely<T>(body: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await body();
    } catch (error) {
      const code = errorCode(error);
      const message = code ? `${code}: ${safeDetail(code, error)}` : "workflow step failed";
      if (isNonRetryable(error)) throw new NonRetryableError(message);
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
      if (isNonRetryable(e) || (code && FINAL.has(code)))
        throw new NonRetryableError(code ? `${code}: ${safeDetail(code, e)}` : "workflow step failed");
      throw new Error(code ? `${code}: ${safeDetail(code, e)}` : "workflow step failed");
    }
  };
}

/** A short message for the user about why a run stopped, as sentences. Never includes career text. */
export function userMessage(e: unknown, fallback: string): string {
  const code = errorCode(e);
  if (code && code !== "unavailable") return asSentence(safeDetail(code, e));
  return fallback;
}

/** Report service failures without implying that the uploaded file is invalid. */
export function sourceFailureMessage(e: unknown): string {
  if (errorCode(e) === "unavailable")
    return "Reading isn't available right now. Try again in a few minutes.";
  return userMessage(e, "Resumatic couldn't finish reading this file. Try again in a few minutes.");
}
