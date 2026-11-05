/** R2 keys for one vault all start with this prefix, so erasure is one prefix sweep. */
export function vaultPrefix(vaultId: string): string {
  return `vaults/${vaultId}/`;
}

export function sourceKey(vaultId: string, objectId: string): string {
  return `${vaultPrefix(vaultId)}sources/${objectId}`;
}

export function pdfKey(vaultId: string, resumeId: string, version: number): string {
  return `${vaultPrefix(vaultId)}exports/${resumeId}-${version}.pdf`;
}

/** Deletes every object under a prefix. Returns how many were deleted. Safe to repeat. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
