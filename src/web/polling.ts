import { ApiError, ApiNetworkError } from "./api";

/** Retry only failures that can reasonably clear without a change in user input. */
export function isTransientReadError(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status === 408 || error.status === 425 || error.status === 429 ||
      (error.status >= 500 && error.status <= 599);
  // Only errors wrapped at the fetch boundary count as network failures.
  // A TypeError in response handling or pollWhile is a programming error,
  // so automatic polling stops and the explicit retry remains available.
  return error instanceof ApiNetworkError;
}
