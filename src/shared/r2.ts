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

/** A malformed or repeated continuation cannot prove a prefix was fully scanned. */
export function nextR2Cursor(
  page: { truncated: boolean; cursor?: string },
  seen: Set<string>,
): string | undefined {
  if (page.truncated === false) return undefined;
  if (page.truncated !== true || typeof page.cursor !== "string" || !page.cursor || seen.has(page.cursor))
    throw new Error("r2_incomplete_pagination");
  seen.add(page.cursor);
  return page.cursor;
}

/** Deletes every object under a prefix. Returns how many were deleted. Safe to repeat. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = nextR2Cursor(page, seen);
  } while (cursor);
  return deleted;
}
