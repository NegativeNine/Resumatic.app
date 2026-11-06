import { nextR2Cursor, vaultPrefix } from "../shared/r2";
import { sha256 } from "./crypto";

type FenceSnapshot =
  | { status: "unavailable" }
  | { status: "available"; total: number; attempts: { id: string; kind: string; createdAt: number; keyDigest: string | null }[] };

type Observation = "no-digest" | "not-observed" | "current-match" | "current-other" | "head-unavailable" | "head-limit";

/**
 * Bounded, read-only correlation hints, never proof that an attempt settled.
 * Object keys and arbitrary metadata stay inside the Worker. The snapshot,
 * listing and heads occur at different times and are not an atomic inventory.
 */
export async function correlateCacheWrites(
  bucket: Pick<R2Bucket, "list" | "head">,
  vaultId: string,
  snapshot: FenceSnapshot,
) {
  if (!/^[a-f0-9]{64}$/i.test(vaultId)) throw new Error("invalid_vault_id");
  if (!snapshot || snapshot.status !== "available") return {
    status: "pending" as const, fenceSnapshot: "unavailable" as const,
    scan: "not-scanned" as const, scanned: 0, total: null, observations: [],
  };
  if (!Array.isArray(snapshot.attempts) || !Number.isSafeInteger(snapshot.total) || snapshot.total < snapshot.attempts.length ||
      snapshot.attempts.length > 100 || new Set(snapshot.attempts.map((item) => item?.id)).size !== snapshot.attempts.length || snapshot.attempts.some((item) =>
        !item || typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id) ||
        !["pdf", "docx", "source"].includes(item.kind) || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 ||
        (item.keyDigest !== null && (typeof item.keyDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.keyDigest)))))
    return {
      status: "pending" as const, fenceSnapshot: "invalid" as const,
      scan: "not-scanned" as const, scanned: 0, total: null, observations: [],
    };
  // Limit all caller-visible work even if a future schema raises the cap.
  const attempts = snapshot.attempts.slice(0, 64);
  const desired = new Set(attempts.flatMap((item) => item.keyDigest ? [item.keyDigest] : []));
  const results = attempts.map((item) => ({
    id: item.id, kind: item.kind, createdAt: item.createdAt, keyDigest: item.keyDigest,
    observation: (item.keyDigest ? "not-observed" : "no-digest") as Observation,
  }));
  // R2 keys are built from the canonical lowercase Durable Object ID.
  const hasSources = attempts.some((item) => item.kind === "source" && item.keyDigest);
  const hasExports = attempts.some((item) => item.kind !== "source" && item.keyDigest);
  // Mixed snapshots scan the vault prefix; all observations remain bounded
  // and are never evidence that an earlier in-flight write has settled.
  const prefix = `${vaultPrefix(vaultId.toLowerCase())}${hasSources ? (hasExports ? "" : "sources/") : "exports/"}`;
  const matches = new Map<string, string>();
  let scan: "not-scanned" | "exhausted" | "limited" | "unavailable" = "not-scanned";
  let scanned = 0;
  if (desired.size) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    try {
      for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
        const page = await bucket.list({ prefix, limit: 100, cursor });
        if (page.objects.length > 100 || page.objects.some((object) => !object.key.startsWith(prefix)))
          throw new Error("invalid_r2_listing");
        scanned += page.objects.length;
        for (const object of page.objects) {
          const digest = Array.from(new Uint8Array(await sha256(object.key)), (byte) => byte.toString(16).padStart(2, "0")).join("");
          if (desired.has(digest)) matches.set(digest, object.key);
        }
        cursor = nextR2Cursor(page, seen);
        if (!cursor) { scan = "exhausted"; break; }
        scan = "limited";
      }
    } catch {
      scan = "unavailable";
    }
  }
  // A head is another independent point-in-time read. Never expose metadata;
  // compare only the known opaque attempt ID, and bound provider operations.
  let heads = 0;
  for (const [digest, key] of matches) {
    const relevant = results.filter((item) => item.keyDigest === digest);
    if (heads >= 16) {
      for (const item of relevant) item.observation = "head-limit";
      continue;
    }
    heads++;
    try {
      const object = await bucket.head(key);
      if (object && object.key !== key) throw new Error("unexpected_r2_object");
      if (!object) continue;
      for (const item of relevant)
        item.observation = object.customMetadata?.resumatic_cache_attempt === item.id ? "current-match" : "current-other";
    } catch {
      for (const item of relevant) item.observation = "head-unavailable";
    }
  }
  return {
    status: "pending" as const, fenceSnapshot: "available" as const,
    scan, scanned, total: snapshot.total, omitted: Math.max(0, snapshot.total - attempts.length), observations: results,
  };
}
