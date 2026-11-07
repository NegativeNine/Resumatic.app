export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "gone"
  | "invalid"
  | "too_large"
  | "quota"
  | "unavailable";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  too_large: 413,
  invalid: 422,
  quota: 429,
  unavailable: 503,
};

// Workflows re-throw a step's error with its class name in front ("NonRetryableError: gone: ..."),
// so any leading "<Name>Error: " parts are skipped.
const CODE_PREFIX = /^(?:[A-Za-z]*Error: )*(unauthenticated|forbidden|not_found|conflict|gone|invalid|too_large|quota|unavailable): /;

/**
 * An expected failure with a stable code. The code travels in the message, so it
 * survives Durable Object and Workflow RPC, which keep an error's message but not
 * its class or extra fields.
 */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "AppError";
    this.code = code;
  }
}

/** Recovers the code of an AppError, including one that crossed an RPC boundary. */
export function errorCode(e: unknown): ErrorCode | null {
  try {
    if (e instanceof AppError) {
      const code = e.code;
      return typeof code === "string" && Object.hasOwn(STATUS, code)
        ? code
        : null;
    }
    const match = CODE_PREFIX.exec(messageOf(e));
    return match ? (match[1] as ErrorCode) : null;
  } catch {
    // Error properties can be accessor-backed and need not be trustworthy.
    return null;
  }
}

/** A fixed vocabulary for logs, including when an Error's fields were mutated. */
export function logErrorCode(e: unknown): ErrorCode | "unexpected" {
  try {
    const code = errorCode(e);
    return typeof code === "string" && Object.hasOwn(STATUS, code)
      ? code
      : "unexpected";
  } catch {
    return "unexpected";
  }
}

/** The human-readable part of an AppError's message. */
export function errorDetail(e: unknown): string {
  return messageOf(e).replace(CODE_PREFIX, "");
}

export function httpStatus(code: ErrorCode): number {
  return STATUS[code];
}

function messageOf(e: unknown): string {
  try {
    if (e instanceof Error) {
      const message = e.message;
      return typeof message === "string" ? message : "";
    }
    return typeof e === "string" ? e : "";
  } catch {
    return "";
  }
}
