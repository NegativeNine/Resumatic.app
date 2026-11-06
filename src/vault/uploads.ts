import { AppError } from "../shared/errors";
import { sourceKey } from "../shared/r2";

/** Cleanup scheduling threshold, never extended by retries. It does not prove an R2 put has settled. */
export const UPLOAD_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS upload_intents (
    request_key TEXT PRIMARY KEY, descriptor_digest TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL, r2_key TEXT NOT NULL UNIQUE, byte_length INTEGER NOT NULL,
    content_type TEXT NOT NULL, origin TEXT NOT NULL, parent_source_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'expired')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cleaned_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS upload_intents_cleanup ON upload_intents (state, cleaned_at, expires_at)`,
];

export interface UploadDescriptor {
  requestKey: string;
  /** SHA-256 of metadata and body. A body hash alone does not identify an upload. */
  descriptorDigest: string;
  filename: string;
  r2Key: string;
  byteLength: number;
  contentType: string;
  origin?: "upload" | "ocr";
  parentSourceId?: string;
}
export interface UploadIntent extends Omit<
  UploadDescriptor,
  "origin" | "parentSourceId"
> {
  sourceId: string;
  origin: "upload" | "ocr";
  parentSourceId: string | null;
  state: "pending" | "complete" | "expired";
  createdAt: number;
  expiresAt: number;
}
type Row = {
  request_key: string;
  descriptor_digest: string;
  source_id: string;
  filename: string;
  r2_key: string;
  byte_length: number;
  content_type: string;
  origin: "upload" | "ocr";
  parent_source_id: string | null;
  state: UploadIntent["state"];
  created_at: number;
  expires_at: number;
  cleaned_at: number | null;
};
type Transaction = <T>(callback: () => T) => T;
type Reservation = { intent: UploadIntent; replay: boolean };

/**
 * The Vault authenticates before using this store. reserve precedes every R2 put; complete follows
 * an acknowledged put and atomically creates the source/run. An ambiguous failure retains the
 * intent and object. Expiry prevents an intent from being completed, but does not prove a
 * previously dispatched R2 put has settled; expiry cleanup is therefore best effort.
 */
export class UploadStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: Transaction,
    private readonly options: {
      vaultId: string;
      maxSources: number;
      maxQueued: number;
    },
    private readonly now: () => number = Date.now,
  ) {
    for (const value of [options.maxSources, options.maxQueued]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new AppError("invalid", "invalid upload capacity");
    }
  }

  reserve(input: UploadDescriptor): Reservation {
    this.validate(input);
    this.expire();
    return this.transaction(() => {
      const previous = this.get(input.requestKey);
      if (previous) {
        this.assertSame(previous, input);
        if (previous.state === "expired")
          throw new AppError(
            "conflict",
            "this upload expired; start a new upload",
          );
        return { intent: previous, replay: true };
      }
      // A key is never reused, including after cleanup. A delayed writer cannot touch another source.
      if (
        this.sql
          .exec(
            `SELECT request_key FROM upload_intents WHERE r2_key = ?`,
            input.r2Key,
          )
          .toArray().length ||
        this.sql
          .exec(`SELECT id FROM sources WHERE r2_key = ?`, input.r2Key)
          .toArray().length
      ) {
        throw new AppError(
          "conflict",
          "this upload storage key is already reserved",
        );
      }
      if (
        input.parentSourceId &&
        !this.sql
          .exec(`SELECT id FROM sources WHERE id = ?`, input.parentSourceId)
          .toArray().length
      ) {
        throw new AppError("not_found", "no such original source");
      }
      const { total, queued } = this.sql
        .exec<{ total: number; queued: number }>(
          `SELECT COUNT(*) AS total, COALESCE(SUM(state = 'queued'), 0) AS queued FROM sources`,
        )
        .one();
      const pending = this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM upload_intents WHERE state = 'pending'`,
        )
        .one().count;
      if (queued + pending >= this.options.maxQueued)
        throw new AppError(
          "conflict",
          "wait for your other uploads to finish reading",
        );
      if (total + pending >= this.options.maxSources)
        throw new AppError(
          "quota",
          `you can keep at most ${this.options.maxSources} uploads`,
        );
      const createdAt = this.now();
      this.sql.exec(
        `INSERT INTO upload_intents (request_key, descriptor_digest, source_id, filename, r2_key, byte_length, content_type, origin, parent_source_id, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        input.requestKey,
        input.descriptorDigest,
        crypto.randomUUID(),
        input.filename,
        input.r2Key,
        input.byteLength,
        input.contentType,
        input.origin ?? "upload",
        input.parentSourceId ?? null,
        createdAt,
        createdAt + UPLOAD_INTENT_TTL_MS,
      );
      return { intent: this.get(input.requestKey)!, replay: false };
    });
  }

  /** Called only after R2 acknowledged the put. All source/run writes must be synchronous. */
  complete(
    input: UploadDescriptor,
    persist: (intent: UploadIntent) => void,
  ): Reservation {
    this.validate(input);
    this.expire();
    return this.transaction(() => {
      const intent = this.get(input.requestKey);
      if (!intent)
        throw new AppError(
          "conflict",
          "reserve the upload before storing its file",
        );
      this.assertSame(intent, input);
      if (intent.state === "complete") return { intent, replay: true };
      if (intent.state === "expired")
        throw new AppError(
          "conflict",
          "this upload expired; start a new upload",
        );
      const result: unknown = persist(intent);
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new AppError(
          "invalid",
          "upload transaction callbacks must be synchronous",
        );
      const source = this.sql
        .exec<{ id: string; r2_key: string; filename: string }>(
          `SELECT id, r2_key, filename FROM sources WHERE id = ?`,
          intent.sourceId,
        )
        .toArray()[0];
      if (
        !source ||
        source.r2_key !== intent.r2Key ||
        source.filename !== intent.filename
      )
        throw new AppError(
          "invalid",
          "upload completion must create its reserved source",
        );
      this.sql.exec(
        `UPDATE upload_intents SET state = 'complete' WHERE request_key = ?`,
        input.requestKey,
      );
      return { intent: this.get(input.requestKey)!, replay: false };
    });
  }

  get(requestKey: string): UploadIntent | null {
    const row = this.sql
      .exec<Row>(
        `SELECT * FROM upload_intents WHERE request_key = ?`,
        requestKey,
      )
      .toArray()[0];
    return row ? fromRow(row) : null;
  }

  /** Mark before deleting: completion can never race an expired object's cleanup. */
  cleanupCandidates(limit = 100): UploadIntent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new AppError("invalid", "invalid upload cleanup limit");
    this.expire();
    return this.sql
      .exec<Row>(
        `SELECT * FROM upload_intents WHERE state = 'expired' AND cleaned_at IS NULL ORDER BY expires_at, request_key LIMIT ?`,
        limit,
      )
      .toArray()
      .map(fromRow);
  }

  /** A failed or ambiguous R2 delete is retried; only an acknowledged delete is marked. */
  markCleaned(requestKey: string, r2Key: string): void {
    const intent = this.get(requestKey);
    if (!intent || intent.state !== "expired" || intent.r2Key !== r2Key)
      throw new AppError("conflict", "this upload is not eligible for cleanup");
    this.sql.exec(
      `UPDATE upload_intents SET cleaned_at = COALESCE(cleaned_at, ?) WHERE request_key = ?`,
      this.now(),
      requestKey,
    );
  }

  nextAlarm(): number | null {
    const row = this.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(CASE WHEN state = 'expired' THEN ? ELSE expires_at END) AS at FROM upload_intents
       WHERE state = 'pending' OR (state = 'expired' AND cleaned_at IS NULL)`,
        this.now(),
      )
      .one();
    return row.at === null ? null : Math.max(this.now(), row.at);
  }

  private expire(): void {
    this.sql.exec(
      `UPDATE upload_intents SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?`,
      this.now(),
    );
  }

  private assertSame(intent: UploadIntent, input: UploadDescriptor): void {
    if (
      intent.descriptorDigest !== input.descriptorDigest ||
      intent.filename !== input.filename ||
      intent.r2Key !== input.r2Key ||
      intent.byteLength !== input.byteLength ||
      intent.contentType !== input.contentType ||
      intent.origin !== (input.origin ?? "upload") ||
      intent.parentSourceId !== (input.parentSourceId ?? null)
    ) {
      throw new AppError(
        "conflict",
        "the upload request key was already used with different input",
      );
    }
  }

  private validate(input: UploadDescriptor): void {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestKey) ||
      !/^(?:[a-fA-F0-9]{64}|[a-zA-Z0-9_-]{43})$/.test(input.descriptorDigest)
    )
      throw new AppError("invalid", "invalid upload identity");
    if (
      typeof input.filename !== "string" ||
      !input.filename.trim() ||
      input.filename.length > 200 ||
      typeof input.r2Key !== "string" ||
      !input.r2Key.startsWith(sourceKey(this.options.vaultId, "")) ||
      input.r2Key.length > 1024 ||
      !Number.isSafeInteger(input.byteLength) ||
      input.byteLength < 1 ||
      input.byteLength > 12 * 1024 * 1024 ||
      typeof input.contentType !== "string" ||
      !input.contentType ||
      input.contentType.length > 100 ||
      (input.origin !== undefined &&
        input.origin !== "upload" &&
        input.origin !== "ocr") ||
      (input.parentSourceId !== undefined &&
        (typeof input.parentSourceId !== "string" ||
          !input.parentSourceId ||
          input.parentSourceId.length > 100)) ||
      (input.origin === "ocr") !== Boolean(input.parentSourceId)
    ) {
      throw new AppError("invalid", "invalid upload descriptor");
    }
  }
}

function fromRow(row: Row): UploadIntent {
  return {
    requestKey: row.request_key,
    descriptorDigest: row.descriptor_digest,
    sourceId: row.source_id,
    filename: row.filename,
    r2Key: row.r2_key,
    byteLength: row.byte_length,
    contentType: row.content_type,
    origin: row.origin,
    parentSourceId: row.parent_source_id,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Hash the original filename even when the displayed filename is truncated to 200 characters. */
export async function uploadDescriptorDigest(
  metadata: Pick<
    UploadDescriptor,
    "filename" | "contentType" | "origin" | "parentSourceId"
  >,
  body: ArrayBuffer | Uint8Array | string,
): Promise<string> {
  const bytes =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? new Uint8Array(body)
        : body;
  const hash = async (value: ArrayBuffer | Uint8Array) => {
    const input =
      value instanceof ArrayBuffer ? value : new ArrayBuffer(value.byteLength);
    if (!(value instanceof ArrayBuffer)) new Uint8Array(input).set(value);
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", input)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  };
  const bodyDigest = await hash(bytes);
  return hash(
    new TextEncoder().encode(
      JSON.stringify({
        format: 1,
        filename: metadata.filename,
        contentType: metadata.contentType,
        origin: metadata.origin ?? "upload",
        parentSourceId: metadata.parentSourceId ?? null,
        bodyDigest,
      }),
    ),
  );
}
