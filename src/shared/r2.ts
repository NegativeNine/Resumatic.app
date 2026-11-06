/** R2 keys for one vault all start with this prefix, so erasure is one prefix sweep. */
export function vaultPrefix(vaultId: string): string {
  return `vaults/${vaultId}/`;
}

export function sourceKey(vaultId: string, objectId: string): string {
  return `${vaultPrefix(vaultId)}sources/${objectId}`;
}

export function pdfKey(vaultId: string, resumeId: string, version: number, unknownEndDates = false): string {
  return `${vaultPrefix(vaultId)}exports/${resumeId}-${version}${unknownEndDates ? "-dates-v2" : ""}.pdf`;
}

export function docxKey(vaultId: string, resumeId: string, version: number, unknownEndDates = false): string {
  return `${vaultPrefix(vaultId)}exports/${resumeId}-${version}-word1${unknownEndDates ? "-dates-v2" : ""}.docx`;
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

/**
 * Deletes the objects observed under a prefix and checks that a fresh first
 * page is empty. This is a point-in-time check, not a fence against a put
 * that is still in flight. Safe to repeat when the check fails.
 */
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
  // Cursors are opaque and the listing is mutated while it is paged. A fresh
  // listing also catches already-visible writes that arrived during the sweep.
  // Neither this check nor an empty result settles an unknown in-flight put.
  const confirmation = await bucket.list({ prefix, limit: 1 });
  if (!confirmation || !Array.isArray(confirmation.objects) || confirmation.truncated !== false)
    throw new Error("r2_incomplete_verification");
  if (confirmation.objects.length)
    throw new Error("r2_prefix_not_empty");
  return deleted;
}
