import { AppError, type ErrorCode } from "./errors";

/** Expected application failures, distinct from transport and unexpected exceptions. */
export type Result<T> =
  { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

/** Preserve the existing HTTP error mapping at the edge. */
export function unwrapResult<T>(result: Result<T>): T {
  if (!result.ok) throw new AppError(result.code, result.message);
  return result.value;
}
