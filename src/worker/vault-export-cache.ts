import type { Who } from "../shared/types";
import type { RenderData } from "../shared/types";

type CacheVault = {
  readExportCache(who: Who, key: string): Promise<Uint8Array | null>;
  putExportCache(who: Who, key: string, bytes: ArrayBuffer | Uint8Array): Promise<boolean>;
  checkSession(who: Who): Promise<void>;
};

// Bump whenever either renderer's output or its security checks change.
const RENDER_CACHE_VERSION = "resume-render-v3";

/** Bind regenerable bytes to the entire immutable snapshot and renderer version. */
export async function snapshotCacheKey(base: string, data: RenderData): Promise<string> {
  const match = /^(.*)\.(pdf|docx)$/.exec(base);
  if (!match) throw new Error("invalid_export_cache_key");
  const input = new TextEncoder().encode(JSON.stringify({ renderer: RENDER_CACHE_VERSION, data }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hash = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${match[1]}-snapshot-v3-${hash}.${match[2]}`;
}

/** Cache only output generated for the checked snapshot. Older R2 entries are not trusted. */
export async function cachedExport(
  vault: () => CacheVault,
  who: Who,
  key: string,
  render: () => Promise<ArrayBuffer | Uint8Array>,
): Promise<ArrayBuffer | Uint8Array> {
  let bytes: ArrayBuffer | Uint8Array | null = null;
  try {
    bytes = await vault().readExportCache(who, key);
  } catch {
    // A cache miss caused by an older Vault version or a damaged entry must
    // never turn a closed/revoked session into an authorized response.
    // RPC exceptions can leave a Durable Object stub broken. Use a freshly
    // created stub before rechecking the session or making any later call.
    await vault().checkSession(who);
  }
  if (!bytes) {
    // Rendering can interleave with account closure.
    await vault().checkSession(who);
    bytes = await render();
    try {
      await vault().putExportCache(who, key, bytes);
    } catch {
      // The cache is optional, but a failed or lost RPC cannot bypass the
      // final lifecycle/session check before returning the rendered bytes.
      await vault().checkSession(who);
    }
  }
  await vault().checkSession(who);
  return bytes;
}
