import type { Who } from "../shared/types";
import { AppError } from "../shared/errors";

type CacheVault = {
  checkSession(who: Who): Promise<void>;
  beginCacheWrite(who: Who, attemptId: string, kind: "pdf" | "docx"): Promise<void>;
  finishCacheWrite(userId: string, attemptId: string): Promise<void>;
};

/** Gated by staging-style bindings; production preflight also rejects this setting. */
export function cacheFenceEnabled(env: Env): boolean {
  const setting = env.R2_CACHE_FENCE_ENABLED;
  if (!setting || setting === "false") return false;
  if (setting !== "true" || env.ALLOW_TEST_SIGNIN !== "true" || !env.PILOT_BUDGET)
    throw new AppError("unavailable", "export cache fencing is restricted to staging");
  return true;
}

/**
 * Optional experimental fencing for a single export-cache put. An exception
 * from R2 may represent an operation still in flight, so it does not settle
 * the marker. Existing writers and other R2 paths remain outside this fence.
 */
export async function putExportCache(
  bucket: Pick<R2Bucket, "put">,
  vault: CacheVault,
  who: Who,
  key: string,
  bytes: ArrayBuffer | Uint8Array,
  kind: "pdf" | "docx",
  enabled: boolean,
): Promise<void> {
  const contentType = kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (!enabled) {
    await vault.checkSession(who);
    await bucket.put(key, bytes, { httpMetadata: { contentType } });
    return;
  }
  const attemptId = crypto.randomUUID();
  await vault.beginCacheWrite(who, attemptId, kind);
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
  // The R2 acknowledgement was observed. An RPC failure here still leaves
  // the outcome unknown to the caller and must never trigger another put.
  await vault.finishCacheWrite(who.userId, attemptId);
}
