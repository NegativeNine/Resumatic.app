import { errorCode, errorDetail } from "../shared/errors";
import type { Result } from "../shared/result";

/**
 * Retry only explicitly selected idempotent reads. Each retry must obtain a new
 * Durable Object stub: a stub that has thrown is no longer safe to reuse.
 * The caller must not use this helper for writes or read-modify-write methods.
 */
export async function retryDurableRead<Stub, Result>(
  createStub: () => Stub,
  read: (stub: Stub) => Promise<Result>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read(createStub());
    } catch (error) {
      const flags =
        typeof error === "object" && error !== null
          ? (error as { retryable?: unknown; overloaded?: unknown })
          : null;
      if (
        flags?.overloaded === true ||
        errorCode(error) !== null ||
        flags?.retryable !== true ||
        attempt >= 2
      )
        throw error;
      await wait(30 * 2 ** attempt);
    }
  }
}

/** Convert known RPC application failures to typed results; transport faults still throw. */
export async function durableReadResult<Stub, Value>(
  createStub: () => Stub,
  read: (stub: Stub) => Promise<Value>,
  wait?: (ms: number) => Promise<void>,
): Promise<Result<Value>> {
  try {
    return { ok: true, value: await retryDurableRead(createStub, read, wait) };
  } catch (error) {
    const code = errorCode(error);
    if (!code) throw error;
    return { ok: false, code, message: errorDetail(error) };
  }
}
