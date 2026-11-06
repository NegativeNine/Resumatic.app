import type { Who } from "../shared/types";

type CacheVault = {
  readExportCache(who: Who, key: string): Promise<Uint8Array | null>;
  putExportCache(who: Who, key: string, bytes: ArrayBuffer | Uint8Array): Promise<boolean>;
  checkSession(who: Who): Promise<void>;
};

/** Read legacy R2 caches, but all newly rendered cache entries stay in the Vault. */
export async function cachedExport(
  vault: () => CacheVault,
  bucket: Pick<R2Bucket, "get">,
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
    const legacy = await bucket.get(key);
    if (legacy) bytes = await legacy.arrayBuffer();
    else {
      // R2 lookup and rendering can each interleave with account closure.
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
  }
  await vault().checkSession(who);
  return bytes;
}
