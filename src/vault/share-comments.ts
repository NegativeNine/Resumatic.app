import { AppError } from "../shared/errors";
import {
  MAX_COMMENT_CHARS,
  targetText,
  type CommentThread,
  type NewShareComment,
  type OwnerCommentThread,
  type ShareComment,
  type ShareSuggestion,
  type ShareTarget,
  type SharedJob,
} from "../shared/sharing";
import type { Who } from "../shared/types";
import type { CoachAccount, ShareStore } from "./shares";

// Comments on a shared copy, kept in the vault of the person who shared it. The coach a copy names
// writes them on a line or a fact of the copy, and the owner answers. A comment is another person's
// words: it is shown to the owner and to the account that wrote it, and it is in the owner's export.
// It is never evidence, and nothing but this store reads the table, so it reaches no prompt, check,
// copy or connected app. The one exception is a coach's suggested wording (`share-suggestions.ts`):
// the Vault reads that row when its owner accepts it, and the wording becomes the line their own
// verified edit checks.
//
// A row outlives its copy. Revoking a link clears the snapshot, expiry deletes the grant and a
// replacement vault arrives without grants, and through all of it the owner keeps what was said. So
// a row carries the words it was about and who wrote it, and names its grant without depending on
// the grant still being there.

export const SHARE_COMMENT_MIGRATIONS: readonly string[] = [
  // coach_user_id is the account that wrote a coach's row, or the account an owner's reply was
  // written to. request_key is how a retried request is known.
  `CREATE TABLE share_comments (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    resume_id TEXT,
    resume_version INTEGER,
    quote TEXT NOT NULL,
    coach_user_id TEXT NOT NULL,
    coach_email TEXT NOT NULL,
    coach_name TEXT,
    author TEXT NOT NULL CHECK (author IN ('coach','owner')),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seen_at INTEGER,
    request_key TEXT NOT NULL UNIQUE,
    CHECK ((target_kind = 'line' AND resume_id IS NOT NULL AND resume_version IS NOT NULL)
        OR (target_kind <> 'line' AND resume_id IS NULL AND resume_version IS NULL))
  )`,
  `CREATE INDEX share_comments_by_copy ON share_comments (grant_id, created_at)`,
];

// Each limit counts the rows that exist, of every kind, so deleting comments makes room again.
/** The most comments one copy holds, its owner's replies included. */
export const MAX_COMMENTS_PER_COPY = 200;
/** The most one coach account writes on one copy within an hour. */
export const MAX_COACH_COMMENTS_PER_HOUR = 60;
/** The most comments a vault holds, across every copy it has shared. */
export const MAX_VAULT_COMMENTS = 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * A comment's words as they are kept: line breaks as "\n", a tab as a space, no other control
 * character, and no space at either end. Anything that isn't text is no comment at all.
 */
export function cleanComment(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim();
}

interface Stored {
  id: string;
  grant_id: string;
  target_kind: string;
  target_id: string;
  resume_id: string | null;
  resume_version: number | null;
  quote: string;
  coach_user_id: string;
  coach_email: string;
  coach_name: string | null;
  author: "coach" | "owner";
  body: string;
  created_at: number;
  seen_at: number | null;
  request_key: string;
}
type Row = Stored & Record<string, SqlStorageValue>;

/** A target as a request named it, once it has the shape of one. Whether the copy holds it is asked separately. */
function readTarget(value: unknown): ShareTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, resumeId, version, lineId, factId } = value as Record<string, unknown>;
  if (kind === "fact") return typeof factId === "string" && factId ? { kind, factId } : null;
  if (kind !== "line" || typeof resumeId !== "string" || !resumeId || typeof lineId !== "string" || !lineId) return null;
  return typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? { kind, resumeId, version, lineId } : null;
}

const targetOf = (row: Stored): ShareTarget =>
  row.target_kind === "line"
    ? { kind: "line", resumeId: row.resume_id ?? "", version: row.resume_version ?? 0, lineId: row.target_id }
    : { kind: "fact", factId: row.target_id };

/** One line or fact, as a key. Two targets are the same exactly when their keys are. */
const targetKey = (target: ShareTarget): string =>
  JSON.stringify(target.kind === "line" ? ["line", target.resumeId, target.version, target.lineId] : ["fact", target.factId]);

/** A thread is one coach account's comments on one target of one copy, with the replies to them. */
const threadKey = (row: Stored): string => JSON.stringify([row.grant_id, row.coach_user_id, targetKey(targetOf(row))]);

/** A comment as the account that wrote on the copy reads it, with where a suggestion stands when the row is one. */
const comment = (row: Stored, suggestion?: ShareSuggestion): ShareComment => ({
  id: row.id,
  author: row.author === "owner" ? "owner" : "coach",
  body: row.body,
  createdAt: row.created_at,
  ...(suggestion ? { suggestion } : {}),
});

/** The same for the owner, who is also told the name a coach's comment came under and whether they have seen it. */
const ownerComment = (row: Stored, suggestion?: ShareSuggestion): ShareComment =>
  row.author === "coach" ? { ...comment(row, suggestion), name: row.coach_name ?? null, seen: row.seen_at !== null } : comment(row);

/** Where a suggestion stands, as one side may be told it. The Vault answers, from the check its owner started. */
export type SuggestionFor = (row: Record<string, SqlStorageValue>, side: "coach" | "owner") => ShareSuggestion;

function requireKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new AppError("invalid", "invalid request key");
}

/** The cleaned words, refused in a fixed sentence that states MAX_COMMENT_CHARS. A test holds the two together. */
function requireBody(value: unknown): string {
  const body = cleanComment(value);
  if (body.length < 1 || body.length > MAX_COMMENT_CHARS) throw new AppError("invalid", "write a comment of up to 1,000 characters");
  return body;
}

const reused = () => new AppError("conflict", "the request key was already used with different input");

export class ShareCommentStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly shares: ShareStore,
    private readonly authorizeOwner: (who: Who) => void,
    private readonly suggestionFor?: SuggestionFor,
  ) {}

  /** A suggested wording's standing for one side, or nothing for a comment. */
  private suggestion(row: Row, side: "coach" | "owner"): ShareSuggestion | undefined {
    return row.author === "coach" && row.suggestion_state != null ? this.suggestionFor?.(row, side) : undefined;
  }

  /**
   * A coach's comment on a line or a fact of a copy that is open to them now. The words it is
   * about are taken from the copy as it is delivered, never from the request and never from the
   * owner's facts. The address and name are the grant's, from when this account took the copy up.
   * A suggested wording is written here too, under a request key of its own kind, so a key used for
   * a comment is never taken as the same request as one used for a suggestion.
   */
  addAsCoach(grantId: string, coach: CoachAccount, input: NewShareComment, key: string, now = Date.now(), kind: "coach" | "suggest" = "coach"): ShareComment {
    const { view, coach: named } = this.shares.copyForCoach(grantId, coach, now);
    requireKey(key);
    const given: { target?: unknown; body?: unknown } = typeof input === "object" && input !== null ? input : {};
    const body = requireBody(given.body);
    const target = readTarget(given.target);
    const requestKey = `${kind}_${view.grantId}_${key}`;
    const prior = this.byKey(requestKey);
    if (prior) {
      // A retry of the request that made the comment gets the comment. The key under any other
      // account, target or words is a different request.
      if (prior.author === "coach" && prior.coach_user_id === coach.userId && target !== null &&
          targetKey(targetOf(prior)) === targetKey(target) && prior.body === body)
        return comment(prior, this.suggestion(prior, "coach"));
      throw reused();
    }
    const quote = target === null ? null : targetText(view.snapshot, target);
    if (target === null || quote === null) throw new AppError("invalid", "choose a line or a fact from this copy");
    if (this.inCopy(view.grantId) >= MAX_COMMENTS_PER_COPY)
      throw new AppError("quota", "this copy has as many comments as it can hold");
    if (this.byCoachSince(view.grantId, coach.userId, now - HOUR_MS) >= MAX_COACH_COMMENTS_PER_HOUR)
      throw new AppError("quota", "you've written a lot of comments on this copy in the last hour; carry on later");
    if (this.inVault() >= MAX_VAULT_COMMENTS)
      throw new AppError("quota", "this person's account can't hold more comments until they delete some");
    return comment(
      this.insert({
        grant_id: view.grantId,
        target_kind: target.kind,
        target_id: target.kind === "line" ? target.lineId : target.factId,
        resume_id: target.kind === "line" ? target.resumeId : null,
        resume_version: target.kind === "line" ? target.version : null,
        quote,
        coach_user_id: coach.userId,
        coach_email: named.email,
        coach_name: named.name,
        author: "coach",
        body,
        created_at: now,
        request_key: requestKey,
      }),
    );
  }

  /**
   * The owner's answer to a coach's comment. It is taken only while the copy is open to the
   * account that wrote the comment, because a reply nobody can read helps nobody. The owner starts
   * no thread: a reply joins the thread of the comment it answers.
   */
  replyAsOwner(who: Who, commentId: string, body: string, key: string, now = Date.now()): ShareComment {
    this.authorizeOwner(who);
    requireKey(key);
    const text = requireBody(body);
    const answered = typeof commentId === "string" ? this.byId(commentId) : undefined;
    const requestKey = `owner_${key}`;
    const prior = this.byKey(requestKey);
    if (prior) {
      // A retry gets the reply it made, even after the comment it answered has been deleted.
      if (prior.author === "owner" && prior.body === text && (!answered || threadKey(answered) === threadKey(prior))) return ownerComment(prior);
      throw reused();
    }
    if (!answered || answered.author !== "coach")
      throw new AppError("not_found", "that comment has been deleted; reload to see the thread as it stands");
    const standing = this.shares.standing(who, answered.grant_id, now);
    if (!standing?.open || standing.coachUserId !== answered.coach_user_id)
      throw new AppError("conflict", "this copy isn't open to your coach any more, so they can't read a reply; share a new copy to carry on");
    if (this.inCopy(answered.grant_id) >= MAX_COMMENTS_PER_COPY || this.inVault() >= MAX_VAULT_COMMENTS)
      throw new AppError("quota", "delete some comments to make room for more");
    return ownerComment(
      this.insert({
        grant_id: answered.grant_id,
        target_kind: answered.target_kind,
        target_id: answered.target_id,
        resume_id: answered.resume_id,
        resume_version: answered.resume_version,
        quote: answered.quote,
        coach_user_id: answered.coach_user_id,
        coach_email: answered.coach_email,
        coach_name: answered.coach_name,
        author: "owner",
        body: text,
        created_at: now,
        request_key: requestKey,
      }),
    );
  }

  /**
   * What this account wrote on a copy that is open to it now, and the replies to it: threads and
   * comments oldest first. Another account's rows are never read, the same address or not.
   */
  listForCoach(grantId: string, coach: CoachAccount, now = Date.now()): CommentThread[] {
    const { view } = this.shares.copyForCoach(grantId, coach, now);
    const rows = this.sql
      .exec<Row>(`SELECT * FROM share_comments WHERE grant_id = ? AND coach_user_id = ? ORDER BY created_at, rowid`, view.grantId, coach.userId)
      .toArray();
    const threads = new Map<string, CommentThread>();
    for (const row of rows) {
      const target = targetOf(row);
      // A thread about something the copy doesn't deliver isn't shown to its reader.
      if (targetText(view.snapshot, target) === null) continue;
      const key = targetKey(target);
      const thread = threads.get(key) ?? { target, quote: row.quote, comments: [] };
      thread.comments.push(comment(row, this.suggestion(row, "coach")));
      threads.set(key, thread);
    }
    return [...threads.values()];
  }

  /**
   * Every thread the vault holds, for its owner: the thread with the latest comment first, each
   * thread's comments oldest first. A thread is open while its copy can be delivered to the
   * account that wrote in it. A line's job is named as the owner has it now.
   */
  listForOwner(who: Who, now = Date.now()): OwnerCommentThread[] {
    this.authorizeOwner(who);
    const rows = this.sql.exec<Row>(`SELECT * FROM share_comments ORDER BY created_at, rowid`).toArray();
    // Whether a copy can be delivered takes rebuilding it, so each copy is asked once.
    const standings = new Map<string, ReturnType<ShareStore["standing"]>>();
    const standing = (grantId: string) => {
      if (!standings.has(grantId)) standings.set(grantId, this.shares.standing(who, grantId, now));
      return standings.get(grantId) ?? null;
    };
    const jobs = new Map<string, SharedJob | null>();
    const jobOf = (resumeId: string) => {
      if (!jobs.has(resumeId)) {
        const job = this.sql
          .exec<{ title: string | null; company: string | null }>(
            `SELECT a.title, a.company FROM resumes r JOIN applications a ON a.id = r.application_id WHERE r.id = ?`,
            resumeId,
          )
          .toArray()[0];
        jobs.set(resumeId, job && (job.title || job.company) ? { title: job.title, company: job.company } : null);
      }
      return jobs.get(resumeId) ?? null;
    };
    const threads = new Map<string, { thread: OwnerCommentThread; latest: number; order: number }>();
    for (const row of rows) {
      const key = threadKey(row);
      let entry = threads.get(key);
      if (!entry) {
        const target = targetOf(row);
        const copy = standing(row.grant_id);
        entry = {
          thread: {
            target,
            quote: row.quote,
            comments: [],
            grantId: row.grant_id,
            coachEmail: row.coach_email,
            open: copy !== null && copy.open && copy.coachUserId === row.coach_user_id,
            ...(target.kind === "line" ? { job: jobOf(target.resumeId) } : {}),
          },
          latest: row.created_at,
          order: threads.size,
        };
        threads.set(key, entry);
      }
      entry.thread.comments.push(ownerComment(row, this.suggestion(row, "owner")));
      entry.latest = row.created_at;
    }
    return [...threads.values()].sort((a, b) => b.latest - a.latest || b.order - a.order).map((entry) => entry.thread);
  }

  /**
   * Notes that the owner has now seen these comments of a coach's: the ones the page showed as
   * new. A comment written after the page read its list isn't among them, so it stays new and is
   * counted until it has been shown. An ID that names no unseen coach's comment changes nothing.
   */
  markSeen(who: Who, ids: readonly string[], now = Date.now()): void {
    this.authorizeOwner(who);
    if (!Array.isArray(ids) || ids.length > MAX_VAULT_COMMENTS || ids.some((id) => typeof id !== "string"))
      throw new AppError("invalid", "name the comments that were shown");
    for (const id of new Set(ids))
      this.sql.exec(`UPDATE share_comments SET seen_at = ? WHERE id = ? AND author = 'coach' AND seen_at IS NULL`, now, id);
  }

  /**
   * Notes that the owner has seen every comment a coach wrote. Only a page from before pages named
   * what they showed asks for this, and it keeps the race `markSeen` closes until it is reloaded.
   */
  markAllSeen(who: Who, now = Date.now()): void {
    this.authorizeOwner(who);
    this.sql.exec(`UPDATE share_comments SET seen_at = ? WHERE author = 'coach' AND seen_at IS NULL`, now);
  }

  /** How many of a coach's comments the owner hasn't seen. It checks nobody: call it only for the owner. */
  unseen(): number {
    return this.one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM share_comments WHERE author = 'coach' AND seen_at IS NULL`));
  }

  /** A coach deletes only what their own account wrote, and only while the copy is open to them. */
  removeAsCoach(grantId: string, coach: CoachAccount, id: string, now = Date.now()): void {
    const { view } = this.shares.copyForCoach(grantId, coach, now);
    if (typeof id !== "string") return;
    this.sql.exec(`DELETE FROM share_comments WHERE id = ? AND grant_id = ? AND author = 'coach' AND coach_user_id = ?`, id, view.grantId, coach.userId);
  }

  /**
   * The owner deletes any comment, a coach's or their own, whether or not its copy is still open,
   * except a suggestion whose check is running: the check finishes first.
   */
  removeAsOwner(who: Who, id: string): void {
    this.authorizeOwner(who);
    if (typeof id !== "string") return;
    const row = this.byId(id);
    if (row && this.suggestion(row, "owner")?.state === "checking")
      throw new AppError("conflict", "This suggestion is being checked. Wait for the check to finish, then try again.");
    this.sql.exec(`DELETE FROM share_comments WHERE id = ?`, id);
  }

  /**
   * Every comment as stored, oldest first, for the owner's export. The request key is a retry
   * receipt and the coach's account ID stays on the server, as it does on a share link.
   */
  export(who: Who): Record<string, string | number | null>[] {
    this.authorizeOwner(who);
    return this.sql
      .exec<Record<string, string | number | null>>(`SELECT * FROM share_comments ORDER BY created_at, rowid`)
      .toArray()
      .map(({ request_key: _key, coach_user_id: _account, ...rest }) => rest);
  }

  private byId(id: string): Row | undefined {
    return this.sql.exec<Row>(`SELECT * FROM share_comments WHERE id = ?`, id).toArray()[0];
  }

  private byKey(requestKey: string): Row | undefined {
    return this.sql.exec<Row>(`SELECT * FROM share_comments WHERE request_key = ?`, requestKey).toArray()[0];
  }

  // The three counts behind the limits. Each counts every row it matches, whatever kind of row a
  // later feature keeps in this table.

  private inCopy(grantId: string): number {
    return this.one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM share_comments WHERE grant_id = ?`, grantId));
  }

  private byCoachSince(grantId: string, coachUserId: string, since: number): number {
    return this.one(
      this.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM share_comments WHERE grant_id = ? AND author = 'coach' AND coach_user_id = ? AND created_at > ?`,
        grantId, coachUserId, since,
      ),
    );
  }

  private inVault(): number {
    return this.one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM share_comments`));
  }

  private one(counted: SqlStorageCursor<{ n: number }>): number {
    return counted.toArray()[0]?.n ?? 0;
  }

  private insert(row: Omit<Stored, "id" | "seen_at">): Stored {
    const stored: Stored = { ...row, id: crypto.randomUUID(), seen_at: null };
    this.sql.exec(
      `INSERT INTO share_comments (id, grant_id, target_kind, target_id, resume_id, resume_version, quote, coach_user_id, coach_email, coach_name, author, body, created_at, seen_at, request_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      stored.id, stored.grant_id, stored.target_kind, stored.target_id, stored.resume_id, stored.resume_version, stored.quote,
      stored.coach_user_id, stored.coach_email, stored.coach_name, stored.author, stored.body, stored.created_at, stored.request_key,
    );
    return stored;
  }
}
