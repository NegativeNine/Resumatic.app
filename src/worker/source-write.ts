import { errorCode } from "../shared/errors";

/**
 * Retry only the idempotent acknowledgement RPC, after R2 has confirmed the
 * put. A fresh stub is required after an RPC exception. An overloaded object
 * is not retried, and failure never starts or settles a different put.
 */
export async function settleAcknowledgedSourceWrite(
  vault: () => { finishCacheWrite(userId: string, attemptId: string): Promise<void> },
  userId: string,
  attemptId: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await vault().finishCacheWrite(userId, attemptId);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= 2 || (code !== null && code !== "unavailable") ||
          (typeof error === "object" && error !== null &&
            (("overloaded" in error && error.overloaded) || ("retryable" in error && error.retryable === false))))
        throw error;
      await wait(30 * 2 ** attempt);
    }
  }
}

