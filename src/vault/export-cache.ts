import { AppError } from "../shared/errors";
import { vaultPrefix } from "../shared/r2";

/** Regenerable output only. Individual rows stay below the SQLite value limit. */
export const EXPORT_CACHE_CHUNK_BYTES = 512 * 1024;
export const EXPORT_CACHE_ITEM_BYTES = 4 * 1024 * 1024;
export const EXPORT_CACHE_TOTAL_BYTES = 16 * 1024 * 1024;

export const EXPORT_CACHE_MIGRATIONS = [
  `CREATE TABLE export_cache (cache_key TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND ${EXPORT_CACHE_ITEM_BYTES}), sha256 TEXT NOT NULL, accessed_at INTEGER NOT NULL)`,
  `CREATE TABLE export_cache_chunks (cache_key TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0), bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND ${EXPORT_CACHE_CHUNK_BYTES}), PRIMARY KEY(cache_key, position), FOREIGN KEY(cache_key) REFERENCES export_cache(cache_key) ON DELETE CASCADE)`,
  `CREATE INDEX export_cache_access ON export_cache(accessed_at, cache_key)`,
];

/** Cache state is never transferred: a replacement regenerates exports on demand. */
export class ExportCache {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(fn: () => T) => T,
    private readonly vaultId: string,
  ) {}

  private key(key: string): void {
    if (typeof key !== "string" || key.length > 1024 || !key.startsWith(`${vaultPrefix(this.vaultId)}exports/`) ||
        (!key.endsWith(".pdf") && !key.endsWith(".docx")))
      throw new AppError("invalid", "invalid export cache key");
  }

  read(key: string): { bytes: Uint8Array; digest: string } | null {
    this.key(key);
    const entry = this.sql.exec<{ size: number; sha256: string }>(`SELECT size, sha256 FROM export_cache WHERE cache_key = ?`, key).toArray()[0];
    if (!entry) return null;
    if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > EXPORT_CACHE_ITEM_BYTES || !/^[a-zA-Z0-9_-]{43}$/.test(entry.sha256))
      throw new AppError("unavailable", "export cache is unavailable");
    const chunks = this.sql.exec<{ position: number; bytes: ArrayBuffer }>(
      `SELECT position, bytes FROM export_cache_chunks WHERE cache_key = ? ORDER BY position`, key,
    );
    const result = new Uint8Array(entry.size);
    let offset = 0, position = 0;
    for (const row of chunks) {
      const bytes = new Uint8Array(row.bytes);
      if (row.position !== position++ || !bytes.length || bytes.length > EXPORT_CACHE_CHUNK_BYTES || bytes.length > result.length - offset)
        throw new AppError("unavailable", "export cache is unavailable");
      result.set(bytes, offset);
      offset += bytes.length;
    }
    if (offset !== result.length) throw new AppError("unavailable", "export cache is unavailable");
    this.sql.exec(`UPDATE export_cache SET accessed_at = ? WHERE cache_key = ?`, Date.now(), key);
    return { bytes: result, digest: entry.sha256 };
  }

  /** Oversized results are served normally without entering the cache. */
  put(key: string, input: ArrayBuffer | Uint8Array, digest: string): boolean {
    this.key(key);
    if (!/^[a-zA-Z0-9_-]{43}$/.test(digest)) throw new AppError("invalid", "invalid export cache digest");
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!bytes.byteLength || bytes.byteLength > EXPORT_CACHE_ITEM_BYTES) return false;
    return this.transaction(() => {
      this.remove(key);
      let total = this.sql.exec<{ size: number }>(`SELECT COALESCE(SUM(size), 0) AS size FROM export_cache`).one().size;
      if (!Number.isSafeInteger(total) || total < 0)
        throw new AppError("unavailable", "export cache is unavailable");
      while (total + bytes.length > EXPORT_CACHE_TOTAL_BYTES) {
        const oldest = this.sql.exec<{ cache_key: string; size: number }>(
          `SELECT cache_key, size FROM export_cache ORDER BY accessed_at, cache_key LIMIT 1`,
        ).toArray()[0];
        if (!oldest || !Number.isSafeInteger(oldest.size) || oldest.size < 1)
          throw new AppError("unavailable", "export cache is unavailable");
        this.remove(oldest.cache_key);
        total -= oldest.size;
      }
      this.sql.exec(`INSERT INTO export_cache(cache_key, size, sha256, accessed_at) VALUES (?, ?, ?, ?)`, key, bytes.length, digest, Date.now());
      for (let start = 0, position = 0; start < bytes.length; start += EXPORT_CACHE_CHUNK_BYTES, position++) {
        const chunk = bytes.slice(start, start + EXPORT_CACHE_CHUNK_BYTES);
        this.sql.exec(`INSERT INTO export_cache_chunks(cache_key, position, bytes) VALUES (?, ?, ?)`, key, position, chunk.buffer);
      }
      return true;
    });
  }

  private remove(key: string): void {
    this.sql.exec(`DELETE FROM export_cache_chunks WHERE cache_key = ?`, key);
    this.sql.exec(`DELETE FROM export_cache WHERE cache_key = ?`, key);
  }
}
