import { AppError } from "./errors";

/**
 * Content and its retry receipts, and the account's own list of the copies shared with it as a
 * coach. Credentials, grants, jobs and financial ledgers are excluded.
 */
export const TRANSFER_TABLES = [
  "profile",
  // Job preferences: one row, moved as it is, revision included. A new vault has no row until
  // its owner first saves, so the table is empty where an import needs it to be.
  "preferences",
  "sources",
  "source_revisions",
  "evidence",
  "roles",
  // Preserve manual role idempotency across a fenced vault replacement.
  "role_create_requests",
  "facts",
  // Preserve manual fact idempotency across a fenced vault replacement.
  "fact_create_requests",
  "extraction_feedback_sources",
  "extraction_feedback_facts",
  "extraction_feedback_manual",
  "applications",
  // Preserve job submission idempotency across a fenced vault replacement.
  "application_create_requests",
  "resumes",
  "resume_versions",
  "documents",
  "document_versions",
  "interview_answers",
  // Judgements about facts and roles: how a line divides, its concepts, and what was merged.
  // After the facts and roles they are about, so every row finds its fact on arrival.
  "fact_splits",
  "fact_parts",
  "record_tags",
  "record_links",
  // A coach's client list. It is not a grant and opens nothing by itself: a row says only where
  // a copy is kept, and the copy's owner's vault still decides every open from the account and
  // the address, which a replacement leaves as they were.
  "coach_clients",
  // What a coach wrote on a shared copy, and the owner's replies. They are the owner's to keep, so
  // they move. Grants don't, so every thread arrives closed: it can be read and deleted, and
  // nobody can add to it. A row holds no vault ID or storage key. A suggested wording's
  // `document_id` names the owner's check, and documents move with their IDs, so it needs no
  // rewrite; runs don't move, so a check that was running arrives without a verdict.
  "share_comments",
  // Saved answers and application kits: the owner's own words and choices. Resume and document IDs
  // move unchanged, and no row holds a vault ID, storage key or run ID.
  "saved_answers",
  "application_kits",
  "kit_questions",
  // Which email notices are on and when each was last sent. Holds no address and no vault ID, so
  // no row needs rewriting; a notice in retry arrives in retry and the replacement's alarm sends it.
  "email_notices",
] as const;
export type TransferTable = (typeof TRANSFER_TABLES)[number];
export type TransferValue = string | number | null | { binary: string };
export interface TransferManifest {
  format: 1;
  operationId: string;
  sourceVaultId: string;
  ownerId: string;
  schemaVersion: number;
  createdAt: number;
  embedding: { model: string; dimensions: number; generation: string };
  tables: { name: TransferTable; count: number }[];
}
export interface TransferPage {
  operationId: string;
  table: TransferTable;
  after: number;
  lastRowid: number;
  done: boolean;
  columns: string[];
  rows: TransferValue[][];
  sha256: string;
}
export interface ImportStatus {
  operationId: string;
  state: "importing" | "ready";
  completedTables: number;
  totalTables: number;
  rows: number;
}

export async function contentDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** IDs are case-insensitive hex; match whole comma-separated entries only. */
export function isMaintenanceFenced(
  vaultId: string,
  configuredIds: string | undefined,
): boolean {
  if (!vaultId) return false;
  const ids = (configuredIds ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  return ids.includes(vaultId.toLowerCase());
}

/** This deployment configuration is outside the restored database and survives PITR. */
export function requireMaintenanceFence(
  vaultId: string,
  configuredIds: string | undefined,
): void {
  if (!isMaintenanceFenced(vaultId, configuredIds))
    throw new AppError(
      "forbidden",
      "this vault must be fenced before maintenance",
    );
}

/** Older cookies contain plain UUID user IDs and continue routing to the existing global object. */
export function directoryNameForUser(userId: string): string {
  const match =
    /^s(\d{1,2}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(
      userId,
    );
  if (!match) {
    if (userId.includes(":"))
      throw new AppError("invalid", "invalid account home shard");
    return "global";
  }
  const shard = Number(match[1]);
  if (shard < 0 || shard >= 16)
    throw new AppError("invalid", "invalid account home shard");
  return `directory-${shard}`;
}

/** Used only for new-account placement after checking the existing global Directory. */
export async function identityShard(
  provider: string,
  subject: string,
): Promise<number> {
  return (
    Number.parseInt(
      (await contentDigest([provider, subject])).slice(0, 2),
      16,
    ) % 16
  );
}

export function shardedUserId(
  shard: number,
  uuid = crypto.randomUUID(),
): string {
  if (
    !Number.isInteger(shard) ||
    shard < 0 ||
    shard >= 16 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      uuid,
    )
  )
    throw new AppError("invalid", "invalid account home shard");
  return `s${shard}:${uuid}`;
}
