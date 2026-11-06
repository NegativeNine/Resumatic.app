import { AppError } from "../shared/errors";
import {
  contentDigest,
  TRANSFER_TABLES,
  type ImportStatus,
  type TransferManifest,
  type TransferPage,
  type TransferTable,
  type TransferValue,
} from "../shared/operations";
import { vaultPrefix } from "../shared/r2";

type Transaction = <T>(callback: () => T) => T;
type Cell = string | number | null | ArrayBuffer;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

export const OPERATION_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS vault_operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, manifest TEXT NOT NULL, state TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS vault_import_progress (operation_id TEXT NOT NULL, table_name TEXT NOT NULL, last_rowid INTEGER NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(operation_id, table_name))`,
  `CREATE TABLE IF NOT EXISTS vault_import_pages (operation_id TEXT NOT NULL, table_name TEXT NOT NULL, after_rowid INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(operation_id, table_name, after_rowid))`,
  `CREATE TABLE IF NOT EXISTS embedding_jobs (id TEXT PRIMARY KEY, model TEXT NOT NULL, dimensions INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS embedding_staging (job_id TEXT NOT NULL, fact_id TEXT NOT NULL, revision INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(job_id, fact_id))`,
];

/**
 * Transfer content between same-owner vaults while both are externally fenced.
 * Pages contain career data: send them directly to storage/the destination, never Workflow returns.
 * R2 objects must be copied and checked by the caller before finishImport's final callback.
 */
export class VaultOperations {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: Transaction,
    private readonly context: {
      vaultId: string;
      userId: string;
      schemaVersion: number;
      requireMaintenanceFence: () => void;
      now?: () => number;
    },
  ) {}

  beginExport(operationId: string): TransferManifest {
    this.fenced();
    identifier(operationId);
    return this.transaction(() => {
      const existing = this.operation(operationId);
      if (existing) {
        if (existing.kind !== "export")
          throw new AppError(
            "conflict",
            "maintenance operation ID is already in use",
          );
        return existing.manifest;
      }
      const manifest: TransferManifest = {
        format: 1,
        operationId,
        sourceVaultId: this.context.vaultId,
        ownerId: this.context.userId,
        schemaVersion: this.context.schemaVersion,
        createdAt: this.context.now?.() ?? Date.now(),
        embedding: {
          model: this.meta("embedding_model") ?? "@cf/baai/bge-m3",
          dimensions: Number(this.meta("embedding_dimensions") ?? "1024"),
          generation: this.meta("embedding_generation") ?? "legacy",
        },
        tables: TRANSFER_TABLES.filter((table) => this.hasTable(table)).map(
          (name) => ({
            name,
            count: this.sql
              .exec<{ count: number }>(
                `SELECT COUNT(*) AS count FROM "${name}"`,
              )
              .one().count,
          }),
        ),
      };
      this.sql.exec(
        `INSERT INTO vault_operations (id, kind, manifest, state) VALUES (?, 'export', ?, 'exporting')`,
        operationId,
        JSON.stringify(manifest),
      );
      return manifest;
    });
  }

  async exportPage(
    operationId: string,
    table: TransferTable,
    after = 0,
    limit = 50,
  ): Promise<TransferPage> {
    this.fenced();
    tableName(table);
    whole(after);
    whole(limit);
    if (limit < 1 || limit > 50)
      throw new AppError(
        "invalid",
        "transfer pages hold between one and fifty rows",
      );
    const operation = this.operation(operationId);
    if (
      !operation ||
      operation.kind !== "export" ||
      !operation.manifest.tables.some((entry) => entry.name === table)
    )
      throw new AppError("not_found", "no such export table");
    const columns = this.columns(table);
    const found = this.sql
      .exec<Record<string, Cell>>(
        `SELECT rowid AS __transfer_rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        after,
        limit + 1,
      );
    const rows: TransferValue[][] = [];
    let size = 0;
    let lastRowid = after;
    let done = true;
    for (const row of found) {
      if (rows.length === limit) {
        done = false;
        break;
      }
      const values = columns.map((column) => encode(row[column]!));
      const bytes = new TextEncoder().encode(JSON.stringify(values)).byteLength;
      if (size + bytes > MAX_PAGE_BYTES) {
        if (rows.length === 0)
          throw new AppError(
            "too_large",
            "a row exceeds the transfer page limit",
          );
        done = false;
        break;
      }
      rows.push(values);
      size += bytes;
      lastRowid = Number(row.__transfer_rowid);
    }
    const page = {
      operationId,
      table,
      after,
      lastRowid,
      done,
      columns,
      rows,
    };
    const sha256 = await contentDigest(page);
    this.fenced();
    return { ...page, sha256 };
  }

  beginImport(manifest: TransferManifest): ImportStatus {
    this.fenced();
    validateManifest(manifest);
    if (
      manifest.ownerId !== this.context.userId ||
      manifest.sourceVaultId === this.context.vaultId
    )
      throw new AppError(
        "forbidden",
        "import requires a fresh vault belonging to the same account",
      );
    if (manifest.schemaVersion !== this.context.schemaVersion)
      throw new AppError(
        "conflict",
        "source and destination schema versions must match",
      );
    return this.transaction(() => {
      const prior = this.operation(manifest.operationId);
      if (prior) {
        if (
          prior.kind !== "import" ||
          JSON.stringify(prior.manifest) !== JSON.stringify(manifest)
        )
          throw new AppError(
            "conflict",
            "maintenance operation ID is already in use",
          );
        return this.importStatus(manifest.operationId);
      }
      if (
        this.sql
          .exec(`SELECT id FROM vault_operations WHERE kind = 'import'`)
          .toArray().length
      )
        throw new AppError("conflict", "this vault already has an import");
      if (
        JSON.stringify(manifest.tables.map((table) => table.name)) !==
        JSON.stringify(TRANSFER_TABLES.filter((table) => this.hasTable(table)))
      )
        throw new AppError(
          "conflict",
          "manifest must include every content table",
        );
      for (const table of TRANSFER_TABLES) {
        if (!this.hasTable(table)) continue;
        const count = this.sql
          .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM "${table}"`)
          .one().count;
        if (table !== "profile" && count > 0)
          throw new AppError(
            "conflict",
            "the import destination must be empty",
          );
      }
      // init() creates the default profile; replacing it is part of this same transaction.
      if (this.hasTable("profile")) this.sql.exec(`DELETE FROM profile`);
      this.sql.exec(
        `INSERT INTO vault_operations (id, kind, manifest, state) VALUES (?, 'import', ?, 'importing')`,
        manifest.operationId,
        JSON.stringify(manifest),
      );
      for (const table of manifest.tables) {
        if (!this.hasTable(table.name))
          throw new AppError(
            "conflict",
            "the destination is missing a content table",
          );
        this.sql.exec(
          `INSERT INTO vault_import_progress (operation_id, table_name) VALUES (?, ?)`,
          manifest.operationId,
          table.name,
        );
      }
      return this.importStatus(manifest.operationId);
    });
  }

  async importPage(page: TransferPage): Promise<ImportStatus> {
    this.fenced();
    tableName(page.table);
    whole(page.after);
    whole(page.lastRowid);
    if (
      !Array.isArray(page.rows) ||
      page.rows.length > 50 ||
      !Array.isArray(page.columns) ||
      page.columns.length > 100 ||
      page.lastRowid < page.after ||
      typeof page.done !== "boolean" ||
      (!page.done && page.rows.length === 0)
    )
      throw new AppError("invalid", "invalid transfer page");
    if (
      new TextEncoder().encode(JSON.stringify(page)).byteLength >
      MAX_PAGE_BYTES + 4096
    )
      throw new AppError("too_large", "transfer page is too large");
    const { sha256, ...payload } = page;
    if ((await contentDigest(payload)) !== sha256)
      throw new AppError("invalid", "transfer page checksum does not match");
    this.fenced();
    return this.transaction(() => {
      const operation = this.operation(page.operationId);
      if (!operation || operation.kind !== "import")
        throw new AppError("not_found", "no such import");
      const prior = this.sql
        .exec<{ sha256: string }>(
          `SELECT sha256 FROM vault_import_pages WHERE operation_id = ? AND table_name = ? AND after_rowid = ?`,
          page.operationId,
          page.table,
          page.after,
        )
        .toArray()[0];
      if (prior) {
        if (prior.sha256 !== sha256)
          throw new AppError("conflict", "an imported page cannot be changed");
        return this.importStatus(page.operationId);
      }
      if (operation.state !== "importing")
        throw new AppError("conflict", "this import is already finalized");
      const index = operation.manifest.tables.findIndex(
        (entry) => entry.name === page.table,
      );
      if (index < 0)
        throw new AppError("invalid", "table is not in the manifest");
      const priorTables = operation.manifest.tables
        .slice(0, index)
        .map((entry) => entry.name);
      for (const table of priorTables)
        if (!this.progress(page.operationId, table)?.done)
          throw new AppError("conflict", "import tables in manifest order");
      const progress = this.progress(page.operationId, page.table);
      if (!progress || progress.done || progress.last_rowid !== page.after)
        throw new AppError("conflict", "import pages must arrive in order");
      const columns = this.columns(page.table);
      if (JSON.stringify(columns) !== JSON.stringify(page.columns))
        throw new AppError(
          "conflict",
          "transfer columns do not match the destination schema",
        );
      if (page.rows.length > 0 && page.lastRowid <= page.after)
        throw new AppError("invalid", "transfer cursor must advance");
      const expected = operation.manifest.tables[index]!.count;
      const count = progress.row_count + page.rows.length;
      if (count > expected || (page.done && count !== expected))
        throw new AppError(
          "invalid",
          "transfer row count does not match the manifest",
        );
      const query = `INSERT INTO "${page.table}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
      for (const row of page.rows) {
        if (row.length !== columns.length)
          throw new AppError("invalid", "transfer row width does not match");
        const values = row.map(decode);
        this.rewriteRow(page.table, columns, values, operation.manifest);
        this.sql.exec(query, ...values);
      }
      this.sql.exec(
        `UPDATE vault_import_progress SET last_rowid = ?, row_count = ?, done = ? WHERE operation_id = ? AND table_name = ?`,
        page.lastRowid,
        count,
        page.done ? 1 : 0,
        page.operationId,
        page.table,
      );
      this.sql.exec(
        `INSERT INTO vault_import_pages (operation_id, table_name, after_rowid, sha256) VALUES (?, ?, ?, ?)`,
        page.operationId,
        page.table,
        page.after,
        sha256,
      );
      return this.importStatus(page.operationId);
    });
  }

  /** Caller validates copied R2 objects and installs CURRENT financial state in this transaction. */
  finishImport(
    operationId: string,
    newEpoch: string,
    installCurrentControlState: () => void,
  ): ImportStatus {
    this.fenced();
    identifier(newEpoch);
    if (newEpoch === "legacy")
      throw new AppError(
        "invalid",
        "replacement vaults need a fresh security epoch",
      );
    return this.transaction(() => {
      const status = this.importStatus(operationId);
      if (status.state === "ready") return status;
      if (status.completedTables !== status.totalTables)
        throw new AppError("conflict", "the content import is incomplete");
      if (this.sql.exec(`PRAGMA foreign_key_check`).toArray().length)
        throw new AppError(
          "invalid",
          "imported content contains missing references",
        );
      // The callback must install current quota/spend and billing checkpoints, not archive values.
      const result: unknown = installCurrentControlState();
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new AppError(
          "invalid",
          "maintenance callbacks must be synchronous",
        );
      for (const table of [
        "share_grants",
        "mcp_grants",
        "oauth_grants",
        "oauth_tokens",
      ])
        if (this.hasTable(table)) this.sql.exec(`DELETE FROM "${table}"`);
      for (const [key, value] of [
        ["user_id", this.context.userId],
        ["security_epoch", newEpoch],
        ["session_gen", "1"],
        ["state", "maintenance"],
      ]) {
        this.sql.exec(
          `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key!,
          value!,
        );
      }
      const embedding = this.operation(operationId)!.manifest.embedding;
      for (const [key, value] of [
        ["embedding_model", embedding.model],
        ["embedding_dimensions", String(embedding.dimensions)],
        ["embedding_generation", embedding.generation],
      ])
        this.sql.exec(
          `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key!,
          value!,
        );
      this.sql.exec(
        `UPDATE vault_operations SET state = 'ready' WHERE id = ?`,
        operationId,
      );
      return this.importStatus(operationId);
    });
  }

  importStatus(operationId: string): ImportStatus {
    const operation = this.operation(operationId);
    if (!operation || operation.kind !== "import")
      throw new AppError("not_found", "no such import");
    const totals = this.sql
      .exec<{ count: number; done: number; rows: number }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(done), 0) AS done, COALESCE(SUM(row_count), 0) AS rows FROM vault_import_progress WHERE operation_id = ?`,
        operationId,
      )
      .one();
    return {
      operationId,
      state: operation.state as "importing" | "ready",
      completedTables: totals.done,
      totalTables: totals.count,
      rows: totals.rows,
    };
  }

  private rewriteRow(
    table: TransferTable,
    columns: string[],
    row: Cell[],
    manifest: TransferManifest,
  ): void {
    const replace = (column: string, value: Cell) => {
      const index = columns.indexOf(column);
      if (index >= 0) row[index] = value;
    };
    if (table === "sources") {
      const index = columns.indexOf("r2_key");
      const key = row[index];
      if (
        typeof key !== "string" ||
        !key.startsWith(vaultPrefix(manifest.sourceVaultId))
      )
        throw new AppError(
          "invalid",
          "source file is outside its original vault",
        );
      row[index] =
        vaultPrefix(this.context.vaultId) +
        key.slice(vaultPrefix(manifest.sourceVaultId).length);
    }
    if (table === "sources" || table === "resumes") replace("run_id", null);
    if (["sources", "resumes", "documents"].includes(table)) {
      const state = row[columns.indexOf("state")];
      if (state === "queued" || state === "running") {
        replace("state", "failed");
        replace(
          "error",
          "Work was interrupted by maintenance. Start a new run.",
        );
      }
    }
  }

  private fenced(): void {
    this.context.requireMaintenanceFence();
  }
  private meta(key: string): string | undefined {
    return this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
      .toArray()[0]?.value;
  }
  private hasTable(table: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
          table,
        )
        .toArray().length > 0
    );
  }
  private columns(table: TransferTable): string[] {
    return this.sql
      .exec<{ name: string }>(`PRAGMA table_info("${table}")`)
      .toArray()
      .map((row) => row.name);
  }
  private operation(
    id: string,
  ): { kind: string; state: string; manifest: TransferManifest } | null {
    const row = this.sql
      .exec<{ kind: string; state: string; manifest: string }>(
        `SELECT kind, state, manifest FROM vault_operations WHERE id = ?`,
        id,
      )
      .toArray()[0];
    return row
      ? { ...row, manifest: JSON.parse(row.manifest) as TransferManifest }
      : null;
  }
  private progress(operationId: string, table: string) {
    return this.sql
      .exec<{ last_rowid: number; row_count: number; done: number }>(
        `SELECT last_rowid, row_count, done FROM vault_import_progress WHERE operation_id = ? AND table_name = ?`,
        operationId,
        table,
      )
      .toArray()[0];
  }
}

export interface EmbeddingBatchItem {
  id: string;
  revision: number;
  text: string;
}

/** Builds a full generation beside the active vectors; edits invalidate only their own staged rows. */
export class ReembedStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: Transaction,
  ) {}

  begin(id: string, model: string, dimensions: number): void {
    identifier(id);
    identifier(model);
    whole(dimensions);
    if (dimensions < 1 || dimensions > 16384)
      throw new AppError("invalid", "invalid embedding dimensions");
    this.transaction(() => {
      const prior = this.job(id);
      if (prior) {
        if (prior.model !== model || prior.dimensions !== dimensions)
          throw new AppError(
            "conflict",
            "embedding job configuration cannot change",
          );
        return;
      }
      if (
        this.sql
          .exec(`SELECT id FROM embedding_jobs WHERE state = 'building'`)
          .toArray().length
      )
        throw new AppError(
          "conflict",
          "another embedding generation is being built",
        );
      this.sql.exec(
        `INSERT INTO embedding_jobs (id, model, dimensions, state, created_at) VALUES (?, ?, ?, 'building', ?)`,
        id,
        model,
        dimensions,
        Date.now(),
      );
    });
  }

  nextBatch(id: string, limit = 50): EmbeddingBatchItem[] {
    this.building(id);
    whole(limit);
    if (limit < 1 || limit > 50)
      throw new AppError(
        "invalid",
        "embedding batches hold between one and fifty facts",
      );
    return this.sql
      .exec<{ id: string; revision: number; text: string }>(
        `SELECT f.id, f.revision, f.text FROM facts f LEFT JOIN embedding_staging s ON s.job_id = ? AND s.fact_id = f.id WHERE s.fact_id IS NULL OR s.revision != f.revision ORDER BY f.id LIMIT ?`,
        id,
        limit,
      )
      .toArray();
  }

  status(id: string): {
    id: string;
    model: string;
    dimensions: number;
    state: string;
    totalFacts: number;
    pendingFacts: number;
    stagedFacts: number;
  } {
    const job = this.job(id);
    if (!job) throw new AppError("not_found", "no such embedding job");
    const totalFacts = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM facts`)
      .one().count;
    const stagedFacts = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM embedding_staging s JOIN facts f ON s.fact_id = f.id AND s.revision = f.revision WHERE s.job_id = ?`,
        id,
      )
      .one().count;
    return {
      id,
      ...job,
      totalFacts,
      stagedFacts,
      pendingFacts: job.state === "active" ? 0 : totalFacts - stagedFacts,
    };
  }

  saveBatch(
    id: string,
    rows: { id: string; revision: number; vector: number[] }[],
  ): { saved: number; stale: number } {
    if (rows.length > 50)
      throw new AppError("too_large", "embedding batch is too large");
    return this.transaction(() => {
      const job = this.building(id);
      let saved = 0;
      let stale = 0;
      for (const row of rows) {
        if (
          row.vector.length !== job.dimensions ||
          row.vector.some((n) => !Number.isFinite(n)) ||
          row.vector.every((n) => n === 0)
        )
          throw new AppError(
            "invalid",
            "embedding vector has invalid dimensions or values",
          );
        const current = this.sql
          .exec<{ revision: number }>(
            `SELECT revision FROM facts WHERE id = ?`,
            row.id,
          )
          .toArray()[0];
        if (!current || current.revision !== row.revision) {
          stale++;
          continue;
        }
        const vector = Float32Array.from(row.vector);
        if (Array.from(vector).some((n) => !Number.isFinite(n)))
          throw new AppError(
            "invalid",
            "embedding vector exceeds float precision",
          );
        this.sql.exec(
          `INSERT INTO embedding_staging (job_id, fact_id, revision, vector) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, fact_id) DO UPDATE SET revision = excluded.revision, vector = excluded.vector`,
          id,
          row.id,
          row.revision,
          vector.buffer,
        );
        saved++;
      }
      return { saved, stale };
    });
  }

  activate(id: string): { model: string; dimensions: number; facts: number } {
    return this.transaction(() => {
      const job = this.job(id);
      if (!job) throw new AppError("not_found", "no such embedding job");
      if (job.state !== "active" && job.state !== "building")
        throw new AppError("conflict", "embedding job cannot be activated");
      const count = this.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM facts`)
        .one().count;
      if (job.state === "active")
        return { model: job.model, dimensions: job.dimensions, facts: count };
      if (this.nextBatch(id, 1).length)
        throw new AppError(
          "conflict",
          "some facts still need current embeddings",
        );
      this.sql.exec(
        `UPDATE facts SET vector = (SELECT vector FROM embedding_staging WHERE job_id = ? AND fact_id = facts.id AND revision = facts.revision)`,
        id,
      );
      for (const [key, value] of [
        ["embedding_model", job.model],
        ["embedding_dimensions", String(job.dimensions)],
        ["embedding_generation", id],
      ])
        this.sql.exec(
          `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key!,
          value!,
        );
      this.sql.exec(
        `UPDATE embedding_jobs SET state = 'active' WHERE id = ?`,
        id,
      );
      this.sql.exec(`DELETE FROM embedding_staging WHERE job_id = ?`, id);
      return { model: job.model, dimensions: job.dimensions, facts: count };
    });
  }

  cancel(id: string): void {
    this.transaction(() => {
      this.building(id);
      this.sql.exec(
        `UPDATE embedding_jobs SET state = 'cancelled' WHERE id = ?`,
        id,
      );
      this.sql.exec(`DELETE FROM embedding_staging WHERE job_id = ?`, id);
    });
  }
  private job(id: string) {
    return this.sql
      .exec<{ model: string; dimensions: number; state: string }>(
        `SELECT model, dimensions, state FROM embedding_jobs WHERE id = ?`,
        id,
      )
      .toArray()[0];
  }
  private building(id: string) {
    const job = this.job(id);
    if (!job) throw new AppError("not_found", "no such embedding job");
    if (job.state !== "building")
      throw new AppError("conflict", "embedding job is not building");
    return job;
  }
}

function validateManifest(manifest: TransferManifest): void {
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.tables) ||
    manifest.tables.length === 0 ||
    manifest.tables.length > TRANSFER_TABLES.length
  )
    throw new AppError("invalid", "invalid vault transfer manifest");
  identifier(manifest.operationId);
  identifier(manifest.sourceVaultId);
  identifier(manifest.ownerId);
  whole(manifest.schemaVersion);
  whole(manifest.createdAt);
  if (!manifest.embedding)
    throw new AppError("invalid", "embedding generation is missing");
  identifier(manifest.embedding.model);
  identifier(manifest.embedding.generation);
  whole(manifest.embedding.dimensions);
  if (
    manifest.embedding.dimensions < 1 ||
    manifest.embedding.dimensions > 16384
  )
    throw new AppError("invalid", "invalid embedding dimensions");
  let previous = -1;
  for (const table of manifest.tables) {
    tableName(table.name);
    whole(table.count);
    const index = TRANSFER_TABLES.indexOf(table.name);
    if (index <= previous)
      throw new AppError(
        "invalid",
        "manifest tables must be unique and ordered",
      );
    previous = index;
  }
}
function tableName(table: string): asserts table is TransferTable {
  if (!(TRANSFER_TABLES as readonly string[]).includes(table))
    throw new AppError("invalid", "table cannot be transferred");
}
function identifier(id: string): void {
  if (typeof id !== "string" || id.length < 1 || id.length > 300)
    throw new AppError("invalid", "invalid maintenance identifier");
}
function whole(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AppError("invalid", "invalid maintenance counter");
}
function encode(value: Cell): TransferValue {
  if (value instanceof ArrayBuffer) {
    let binary = "";
    for (const byte of new Uint8Array(value))
      binary += String.fromCharCode(byte);
    return { binary: btoa(binary) };
  }
  if (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw new AppError("invalid", "unsupported transfer value");
}
function decode(value: TransferValue): Cell {
  if (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    typeof value.binary === "string"
  ) {
    try {
      const binary = atob(value.binary);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
    } catch {
      throw new AppError("invalid", "invalid binary transfer value");
    }
  }
  throw new AppError("invalid", "unsupported transfer value");
}
