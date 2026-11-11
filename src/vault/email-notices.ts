import { AppError } from "../shared/errors";
import { NOTICE_KINDS, type NoticeKind, type NoticeSettings } from "../shared/email-notices";
import { sha256 } from "../worker/crypto";

// Which email notices a vault's owner has turned on, and where each stands: one row a kind, made
// at the first toggle, so a fenced replacement finds the table empty where it arrives. The row
// holds no address. It holds a one-way check of the address the owner signed in with when they
// turned the kind on, which every later sign-in and every send are compared with.
//
// The store decides whether a notice is due from four columns of the comments' table (author,
// suggestion_state, seen_at, created_at) and two of the facts' (state, updated_at). It reads no
// other column of either, so nothing a coach wrote and nothing a fact says can reach a notice:
// test/unit/email-notices-reach.test.ts holds that.
//
// Timing, all of it rolling and none of it by calendar, because a vault doesn't know its owner's
// time zone: a coach's comment or suggestion marks its kind pending, and the notice goes 15 minutes
// later, so a burst is one notice. Each kind goes at most once in 24 hours, counted from the first
// attempt of the last notice. A reminder goes once facts have waited 3 days for review, never
// sooner than a day after it was turned on, and then at most once a week while they still wait.
// An attempt is recorded before the send is awaited, so one that never returns still counts.

export const NOTIFICATION_MIGRATIONS: readonly string[] = [
  `CREATE TABLE email_notices (
    kind TEXT PRIMARY KEY CHECK (kind IN ('comment', 'suggestion', 'reminder')),
    on_at INTEGER CHECK (on_at IS NULL OR (typeof(on_at) = 'integer' AND on_at > 0)),
    address_check TEXT CHECK (address_check IS NULL OR (length(address_check) = 64 AND address_check NOT GLOB '*[^0-9a-f]*')),
    pending_at INTEGER CHECK (pending_at IS NULL OR typeof(pending_at) = 'integer'),
    last_at INTEGER CHECK (last_at IS NULL OR typeof(last_at) = 'integer'),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 3),
    retry_at INTEGER CHECK (retry_at IS NULL OR typeof(retry_at) = 'integer'),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'failed', 'paused')),
    CHECK ((on_at IS NULL) = (address_check IS NULL)),
    CHECK (on_at IS NOT NULL OR (pending_at IS NULL AND attempts = 0 AND retry_at IS NULL)),
    CHECK (kind <> 'reminder' OR pending_at IS NULL),
    CHECK ((attempts = 0) = (retry_at IS NULL)),
    CHECK (outcome IS NOT 'paused' OR (pending_at IS NULL AND attempts = 0))
  )`,
];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long a comment or suggestion waits before its notice goes, so that a burst is one notice. */
export const NOTICE_DELAY_MS = 15 * MINUTE_MS;
/** The least time between two notices of one kind, from the first attempt of the earlier one. */
export const NOTICE_INTERVAL_MS = DAY_MS;
/** How long a fact waits for review before a reminder is due. */
export const REVIEW_WAIT_MS = 3 * DAY_MS;
/** The least time between two reminders. */
export const REMINDER_INTERVAL_MS = 7 * DAY_MS;
/** The most attempts one notice gets. */
export const MAX_NOTICE_ATTEMPTS = 3;
/**
 * How long after each attempt the next is made. The third is when an attempt that never returned
 * is settled as failed.
 */
export const RETRY_DELAYS_MS: readonly number[] = [5 * MINUTE_MS, 30 * MINUTE_MS, 30 * MINUTE_MS];

/** A notice the alarm is to send now, recorded as attempted. */
export interface Attempt {
  kind: NoticeKind;
  onAt: number;
  addressCheck: string;
  /** Which attempt this is, from 1 to MAX_NOTICE_ATTEMPTS. */
  attempt: number;
  /** When the next attempt is due, if this one doesn't settle. */
  retryAt: number;
}

/** The last attempt of a notice never came back: it has been settled as failed. */
export interface Exhausted {
  exhausted: true;
  kind: NoticeKind;
}

interface Row extends Record<string, SqlStorageValue> {
  kind: NoticeKind;
  on_at: number | null;
  address_check: string | null;
  pending_at: number | null;
  last_at: number | null;
  attempts: number;
  retry_at: number | null;
  outcome: "sent" | "failed" | "paused" | null;
}

const isKind = (value: unknown): value is NoticeKind => typeof value === "string" && (NOTICE_KINDS as readonly string[]).includes(value);

/** The check stored for a sign-in address: lower-case hex SHA-256 of a fixed label and the address. */
export async function noticeAddressCheck(address: string): Promise<string> {
  const digest = await sha256(`resumatic-email-notice-v1\n${address}`);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class EmailNoticeStore {
  constructor(private readonly sql: SqlStorage) {}

  private row(kind: NoticeKind): Row | undefined {
    return this.sql.exec<Row>(`SELECT * FROM email_notices WHERE kind = ?`, kind).toArray()[0];
  }

  /** Which kinds are on, and the worst standing among them: paused, then failing, then ok. */
  view(): NoticeSettings {
    const on = this.sql.exec<Row>(`SELECT * FROM email_notices WHERE on_at IS NOT NULL`).toArray();
    const has = (kind: NoticeKind) => on.some((row) => row.kind === kind);
    const status = on.some((row) => row.outcome === "paused") ? "paused" : on.some((row) => row.outcome === "failed") ? "failing" : "ok";
    return { comment: has("comment"), suggestion: has("suggestion"), reminder: has("reminder"), status };
  }

  /**
   * Turns one kind on or off. Turning on a kind that is off starts it afresh from `now`. Turning
   * on one that is already on changes nothing with the same check; with another, it takes that
   * check and is no longer paused, and keeps what is pending and any retry. Turning off clears
   * everything but when the last notice went, so the day between notices still holds.
   */
  set(kind: NoticeKind, on: boolean, check: string | null, now: number): void {
    if (!isKind(kind) || typeof on !== "boolean") throw new AppError("invalid", "choose a notice to turn on or off");
    const row = this.row(kind);
    if (!on) {
      this.sql.exec(
        `UPDATE email_notices SET on_at = NULL, address_check = NULL, pending_at = NULL, attempts = 0, retry_at = NULL, outcome = NULL WHERE kind = ?`,
        kind,
      );
      return;
    }
    if (typeof check !== "string") throw new AppError("conflict", "sign out and in again to turn on email notices");
    if (!row || row.on_at === null) {
      this.sql.exec(
        `INSERT INTO email_notices (kind, on_at, address_check, pending_at, attempts, retry_at, outcome) VALUES (?, ?, ?, NULL, 0, NULL, NULL)
         ON CONFLICT (kind) DO UPDATE SET on_at = excluded.on_at, address_check = excluded.address_check,
           pending_at = NULL, attempts = 0, retry_at = NULL, outcome = NULL`,
        kind,
        now,
        check,
      );
      return;
    }
    if (row.address_check === check) return;
    this.sql.exec(
      `UPDATE email_notices SET address_check = ?, outcome = CASE WHEN outcome = 'paused' THEN NULL ELSE outcome END WHERE kind = ?`,
      check,
      kind,
    );
  }

  /** True when any kind is on. */
  anyOn(): boolean {
    return this.sql.exec(`SELECT kind FROM email_notices WHERE on_at IS NOT NULL LIMIT 1`).toArray().length > 0;
  }

  /**
   * The owner has signed in with the address that gives `check`, or with none. Every kind turned
   * on with another address, or every kind when there is none, is paused, dropping what it had
   * queued. A paused kind turned on with this address goes back to waiting for something new.
   */
  signedIn(check: string | null): void {
    this.sql.exec(
      `UPDATE email_notices SET outcome = 'paused', pending_at = NULL, attempts = 0, retry_at = NULL
       WHERE on_at IS NOT NULL AND (? IS NULL OR address_check <> ?)`,
      check,
      check,
    );
    if (check !== null)
      this.sql.exec(`UPDATE email_notices SET outcome = NULL WHERE on_at IS NOT NULL AND outcome = 'paused' AND address_check = ?`, check);
  }

  /**
   * A coach has just written a comment or a suggestion. Call it inside that write's transaction.
   * The first unannounced one sets the time the notice is counted from; later ones leave it.
   */
  note(kind: "comment" | "suggestion", now: number): void {
    this.sql.exec(
      `UPDATE email_notices SET pending_at = COALESCE(pending_at, ?) WHERE kind = ? AND on_at IS NOT NULL AND outcome IS NOT 'paused'`,
      now,
      kind,
    );
  }

  /** Whether there is anything to tell the owner about now: an unseen coach's row written since the kind was turned on, or a fact long enough in review. */
  private somethingNew(kind: NoticeKind, onAt: number, now: number): boolean {
    if (kind === "reminder") {
      const oldest = this.sql.exec<{ at: number | null }>(`SELECT MIN(updated_at) AS at FROM facts WHERE state = 'proposed'`).one().at;
      return oldest !== null && oldest <= now - REVIEW_WAIT_MS;
    }
    const unseen =
      kind === "comment"
        ? this.sql.exec(`SELECT 1 FROM share_comments WHERE author = 'coach' AND suggestion_state IS NULL AND seen_at IS NULL AND created_at >= ? LIMIT 1`, onAt)
        : this.sql.exec(`SELECT 1 FROM share_comments WHERE author = 'coach' AND suggestion_state = 'open' AND seen_at IS NULL AND created_at >= ? LIMIT 1`, onAt);
    return unseen.toArray().length > 0;
  }

  /**
   * Decides whether a notice of this kind is to be sent now and, if so, records the attempt. Run
   * it inside a transaction, and send only what it returns. An attempt that comes back with
   * nothing to send still records what it decided: a pending mark with nothing behind it is
   * cleared, a retry with nothing left to say is stood down, and a last attempt that never
   * returned is settled as failed.
   */
  begin(kind: NoticeKind, now: number): Attempt | Exhausted | null {
    const row = this.row(kind);
    if (!row || row.on_at === null || row.address_check === null) return null;
    if (row.outcome === "paused") {
      this.sql.exec(`UPDATE email_notices SET pending_at = NULL WHERE kind = ?`, kind);
      return null;
    }
    const onAt = row.on_at;
    const something = this.somethingNew(kind, onAt, now);
    if (row.attempts > 0) {
      if (row.retry_at !== null && row.retry_at > now) return null;
      if (row.attempts >= MAX_NOTICE_ATTEMPTS) {
        this.sql.exec(`UPDATE email_notices SET attempts = 0, retry_at = NULL, outcome = 'failed' WHERE kind = ?`, kind);
        return { exhausted: true, kind };
      }
      if (!something) {
        this.sql.exec(`UPDATE email_notices SET attempts = 0, retry_at = NULL WHERE kind = ?`, kind);
        return null;
      }
    } else {
      if (kind !== "reminder") {
        if (row.pending_at === null) return null;
        if (!something) {
          this.sql.exec(`UPDATE email_notices SET pending_at = NULL WHERE kind = ?`, kind);
          return null;
        }
        if (row.pending_at > now - NOTICE_DELAY_MS) return null;
      } else {
        if (!something) return null;
        if (onAt > now - NOTICE_INTERVAL_MS) return null;
        if (row.last_at !== null && row.last_at > now - REMINDER_INTERVAL_MS) return null;
      }
      if (row.last_at !== null && row.last_at > now - NOTICE_INTERVAL_MS) return null;
    }
    const attempt = row.attempts + 1;
    const retryAt = now + RETRY_DELAYS_MS[row.attempts]!;
    this.sql.exec(
      `UPDATE email_notices SET attempts = ?, retry_at = ?, last_at = CASE WHEN ? = 1 THEN ? ELSE last_at END, pending_at = NULL WHERE kind = ?`,
      attempt,
      retryAt,
      attempt,
      now,
      kind,
    );
    return { kind, onAt, addressCheck: row.address_check, attempt, retryAt };
  }

  /**
   * How a notice ended. It changes nothing once the kind has been turned off, or off and on again,
   * since the attempt began. A paused kind stays paused whatever a send in flight came back with.
   */
  settle(kind: NoticeKind, onAt: number, outcome: "sent" | "failed" | "paused"): void {
    this.sql.exec(
      `UPDATE email_notices SET attempts = 0, retry_at = NULL, outcome = ?,
         pending_at = CASE WHEN ? = 'paused' THEN NULL ELSE pending_at END
       WHERE kind = ? AND on_at = ? AND (outcome IS NOT 'paused' OR ? = 'paused')`,
      outcome,
      outcome,
      kind,
      onAt,
      outcome,
    );
  }

  /** True while the attempt's kind is still on as it was when the attempt began, and not paused. */
  current(attempt: Attempt): boolean {
    const row = this.row(attempt.kind);
    return !!row && row.on_at === attempt.onAt && row.address_check === attempt.addressCheck && row.outcome !== "paused";
  }

  /** Drops everything queued and every retry, for a deployment that no longer sends notices. */
  dropPending(): void {
    this.sql.exec(`UPDATE email_notices SET pending_at = NULL, attempts = 0, retry_at = NULL`);
  }

  /** When the alarm should next look at notices, or null when nothing is waiting. It may be in the past. */
  nextDue(): number | null {
    const rows = this.sql.exec<Row>(`SELECT * FROM email_notices WHERE on_at IS NOT NULL AND outcome IS NOT 'paused'`).toArray();
    const due: number[] = [];
    for (const row of rows) {
      if (row.retry_at !== null) {
        due.push(row.retry_at);
        continue;
      }
      if (row.kind !== "reminder") {
        if (row.pending_at !== null) due.push(Math.max(row.pending_at + NOTICE_DELAY_MS, row.last_at === null ? 0 : row.last_at + NOTICE_INTERVAL_MS));
        continue;
      }
      const oldest = this.sql.exec<{ at: number | null }>(`SELECT MIN(updated_at) AS at FROM facts WHERE state = 'proposed'`).one().at;
      if (oldest === null || row.on_at === null) continue;
      due.push(Math.max(oldest + REVIEW_WAIT_MS, row.last_at === null ? 0 : row.last_at + REMINDER_INTERVAL_MS, row.on_at + NOTICE_INTERVAL_MS));
    }
    return due.length ? Math.min(...due) : null;
  }

  /** Every row as stored, for the owner's export. It holds no address, only the check. */
  export(): Record<string, string | number | null>[] {
    return this.sql.exec<Record<string, string | number | null>>(`SELECT * FROM email_notices ORDER BY kind`).toArray();
  }
}
