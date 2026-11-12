import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  EmailNoticeStore,
  MAX_NOTICE_ATTEMPTS,
  NOTICE_DELAY_MS,
  NOTICE_INTERVAL_MS,
  NOTIFICATION_MIGRATIONS,
  REMINDER_INTERVAL_MS,
  RETRY_DELAYS_MS,
  REVIEW_WAIT_MS,
  noticeAddressCheck,
  type Attempt,
} from "../../src/vault/email-notices";

// The store that decides when an email notice is due, on node:sqlite. The comments' and facts'
// tables are cut down to the columns the store may read, and one more that it must not.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = 1_800_000_000_000;
const A = "a".repeat(64);
const B = "b".repeat(64);

type Value = string | number | null;

function harness() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: Value[]) {
      const values = db.prepare(statement).all(...bindings);
      return {
        toArray: () => values,
        one: () => {
          if (values.length !== 1) throw new Error("expected exactly one row");
          return values[0];
        },
      };
    },
  } as unknown as SqlStorage;
  db.exec(`CREATE TABLE share_comments (
    id TEXT PRIMARY KEY, author TEXT NOT NULL, body TEXT NOT NULL DEFAULT 'words',
    created_at INTEGER NOT NULL, seen_at INTEGER, suggestion_state TEXT
  )`);
  db.exec(`CREATE TABLE facts (id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT 'words', state TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  for (const statement of NOTIFICATION_MIGRATIONS) db.exec(statement);
  const notices = new EmailNoticeStore(sql);
  let ids = 0;
  /** A row of the comments' table: a coach's comment unless told otherwise. */
  const comment = (at: number, fields: { author?: "coach" | "owner"; suggestion?: "open" | "declined"; seenAt?: number } = {}) => {
    const id = `c${++ids}`;
    db.prepare(`INSERT INTO share_comments (id, author, created_at, seen_at, suggestion_state) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      fields.author ?? "coach",
      at,
      fields.seenAt ?? null,
      fields.suggestion ?? null,
    );
    return id;
  };
  const fact = (at: number, state = "proposed") => {
    const id = `f${++ids}`;
    db.prepare(`INSERT INTO facts (id, state, updated_at) VALUES (?, ?, ?)`).run(id, state, at);
    return id;
  };
  const rows = () => db.prepare(`SELECT * FROM email_notices ORDER BY kind`).all() as Record<string, Value>[];
  const row = (kind: string) => rows().find((r) => r.kind === kind);
  const write = (statement: string, ...bindings: Value[]) => db.prepare(statement).run(...bindings);
  return { db, notices, comment, fact, rows, row, write };
}

/** The attempt `begin` made, which the test expects to be one. */
function attempted(value: ReturnType<EmailNoticeStore["begin"]>): Attempt {
  if (!value || "exhausted" in value) throw new Error(`expected an attempt, got ${JSON.stringify(value)}`);
  return value;
}

describe("email notices in a vault", () => {
  it("starts with every notice off and no row", () => {
    const { notices, rows } = harness();
    expect(notices.view()).toEqual({ comment: false, suggestion: false, reminder: false, status: "ok" });
    expect(rows()).toEqual([]);
    expect(notices.anyOn()).toBe(false);
    expect(notices.nextDue()).toBeNull();
    for (const kind of ["comment", "suggestion", "reminder"] as const) expect(notices.begin(kind, T)).toBeNull();
    notices.note("comment", T);
    notices.dropPending();
    notices.signedIn(null);
    // Turning off what was never on makes no row either.
    notices.set("comment", false, null, T);
    expect(rows()).toEqual([]);
    expect(notices.export()).toEqual([]);
  });

  it("turning on doesn't announce a comment from before", () => {
    const { notices, comment, row, write } = harness();
    comment(T - HOUR);
    comment(T - HOUR, { suggestion: "open" });
    notices.set("comment", true, A, T);
    notices.set("suggestion", true, A, T);
    expect(row("comment")).toEqual({ kind: "comment", on_at: T, address_check: A, pending_at: null, last_at: null, attempts: 0, retry_at: null, outcome: null });
    // Nothing is pending, so nothing is due.
    expect(notices.nextDue()).toBeNull();
    expect(notices.begin("comment", T + DAY)).toBeNull();
    // Even with a mark, the only unseen comment is from before the kind was on.
    write(`UPDATE email_notices SET pending_at = ? WHERE kind IN ('comment', 'suggestion')`, T + MINUTE);
    expect(notices.begin("comment", T + DAY)).toBeNull();
    expect(notices.begin("suggestion", T + DAY)).toBeNull();
    expect(row("comment")!.pending_at).toBeNull();
    expect(row("suggestion")!.pending_at).toBeNull();
    // One written once it was on is announced.
    comment(T + 2 * MINUTE);
    notices.note("comment", T + 2 * MINUTE);
    expect(attempted(notices.begin("comment", T + 2 * MINUTE + NOTICE_DELAY_MS))).toMatchObject({ kind: "comment", attempt: 1 });
  });

  it("turning on a kind that is already on keeps what is pending, its retry and its status", () => {
    const { notices, comment, rows, write } = harness();
    notices.set("comment", true, A, T);
    comment(T + MINUTE);
    notices.note("comment", T + MINUTE);
    attempted(notices.begin("comment", T + MINUTE + NOTICE_DELAY_MS));
    comment(T + 20 * MINUTE);
    notices.note("comment", T + 20 * MINUTE);
    write(`UPDATE email_notices SET outcome = 'failed'`);
    const before = rows();
    expect(before[0]).toMatchObject({ attempts: 1, pending_at: T + 20 * MINUTE, outcome: "failed" });
    notices.set("comment", true, A, T + HOUR);
    expect(rows()).toEqual(before);
    expect(notices.view()).toEqual({ comment: true, suggestion: false, reminder: false, status: "failing" });
  });

  it("turning on again with a different check clears paused and keeps what is pending", () => {
    const { notices, comment, row } = harness();
    notices.set("comment", true, A, T);
    comment(T + MINUTE);
    notices.note("comment", T + MINUTE);
    notices.set("comment", true, B, T + 2 * MINUTE);
    expect(row("comment")).toMatchObject({ on_at: T, address_check: B, pending_at: T + MINUTE, outcome: null });
    // Paused by a sign-in with another address, then turned on with that address.
    notices.signedIn(A);
    expect(row("comment")).toMatchObject({ address_check: B, outcome: "paused", pending_at: null });
    notices.set("comment", true, A, T + 3 * MINUTE);
    expect(row("comment")).toEqual({ kind: "comment", on_at: T, address_check: A, pending_at: null, last_at: null, attempts: 0, retry_at: null, outcome: null });
    expect(notices.view().status).toBe("ok");
  });

  it("a burst of comments is one notice, 15 minutes after the first", () => {
    const { notices, comment, row } = harness();
    notices.set("comment", true, A, T);
    const first = T + HOUR;
    for (const offset of [0, 20_000, 40_000]) {
      comment(first + offset);
      notices.note("comment", first + offset);
    }
    expect(row("comment")!.pending_at).toBe(first);
    expect(notices.nextDue()).toBe(first + NOTICE_DELAY_MS);
    expect(notices.begin("comment", first + NOTICE_DELAY_MS - 1)).toBeNull();
    const made = attempted(notices.begin("comment", first + NOTICE_DELAY_MS));
    expect(made).toEqual({ kind: "comment", onAt: T, addressCheck: A, attempt: 1, retryAt: first + NOTICE_DELAY_MS + RETRY_DELAYS_MS[0]! });
    notices.settle("comment", T, "sent");
    expect(row("comment")).toMatchObject({ pending_at: null, attempts: 0, retry_at: null, last_at: first + NOTICE_DELAY_MS, outcome: "sent" });
    expect(notices.begin("comment", first + NOTICE_DELAY_MS + MINUTE)).toBeNull();
    expect(notices.nextDue()).toBeNull();
  });

  it("a second notice of a kind waits 24 hours from the first attempt", () => {
    const { notices, comment, row } = harness();
    notices.set("comment", true, A, T);
    comment(T);
    notices.note("comment", T);
    const first = T + NOTICE_DELAY_MS;
    attempted(notices.begin("comment", first));
    // A retry doesn't move the day: it is counted from the first attempt.
    expect(attempted(notices.begin("comment", first + RETRY_DELAYS_MS[0]!)).attempt).toBe(2);
    expect(row("comment")!.last_at).toBe(first);
    notices.settle("comment", T, "sent");
    comment(first + HOUR);
    notices.note("comment", first + HOUR);
    expect(notices.begin("comment", first + 2 * HOUR)).toBeNull();
    expect(row("comment")!.pending_at).toBe(first + HOUR);
    expect(notices.nextDue()).toBe(first + NOTICE_INTERVAL_MS);
    expect(notices.begin("comment", first + NOTICE_INTERVAL_MS - 1)).toBeNull();
    expect(attempted(notices.begin("comment", first + NOTICE_INTERVAL_MS)).attempt).toBe(1);
    expect(row("comment")!.last_at).toBe(first + NOTICE_INTERVAL_MS);
  });

  it("turning a kind off and on again doesn't reset the day", () => {
    const { notices, comment, row } = harness();
    notices.set("comment", true, A, T);
    comment(T);
    notices.note("comment", T);
    const sent = T + NOTICE_DELAY_MS;
    attempted(notices.begin("comment", sent));
    notices.settle("comment", T, "sent");
    notices.set("comment", false, null, sent + HOUR);
    expect(row("comment")).toEqual({ kind: "comment", on_at: null, address_check: null, pending_at: null, last_at: sent, attempts: 0, retry_at: null, outcome: null });
    notices.set("comment", true, A, sent + 2 * HOUR);
    comment(sent + 3 * HOUR);
    notices.note("comment", sent + 3 * HOUR);
    expect(notices.begin("comment", sent + 4 * HOUR)).toBeNull();
    expect(notices.nextDue()).toBe(sent + NOTICE_INTERVAL_MS);
    expect(attempted(notices.begin("comment", sent + NOTICE_INTERVAL_MS)).onAt).toBe(sent + 2 * HOUR);
  });

  it("a comment seen or deleted before sending sends nothing and clears pending", () => {
    const { notices, comment, row, write } = harness();
    notices.set("comment", true, A, T);
    const seen = comment(T + MINUTE);
    notices.note("comment", T + MINUTE);
    write(`UPDATE share_comments SET seen_at = ? WHERE id = ?`, T + 2 * MINUTE, seen);
    expect(notices.begin("comment", T + MINUTE + NOTICE_DELAY_MS)).toBeNull();
    expect(row("comment")).toMatchObject({ pending_at: null, attempts: 0, last_at: null });
    const deleted = comment(T + HOUR);
    notices.note("comment", T + HOUR);
    write(`DELETE FROM share_comments WHERE id = ?`, deleted);
    expect(notices.begin("comment", T + HOUR + NOTICE_DELAY_MS)).toBeNull();
    expect(row("comment")).toMatchObject({ pending_at: null, attempts: 0, last_at: null });
    // The owner's own replies are nothing to tell them about.
    comment(T + 2 * HOUR, { author: "owner" });
    notices.note("comment", T + 2 * HOUR);
    expect(notices.begin("comment", T + 3 * HOUR)).toBeNull();
    expect(notices.nextDue()).toBeNull();
  });

  it("a reminder is not due at 2 days 23 hours, due at 3 days, then not again for 7 days", () => {
    const { notices, fact, row } = harness();
    notices.set("reminder", true, A, T - DAY);
    fact(T);
    expect(notices.nextDue()).toBe(T + REVIEW_WAIT_MS);
    expect(notices.begin("reminder", T + 2 * DAY + 23 * HOUR)).toBeNull();
    const first = attempted(notices.begin("reminder", T + REVIEW_WAIT_MS));
    expect(first).toMatchObject({ kind: "reminder", attempt: 1 });
    notices.settle("reminder", first.onAt, "sent");
    expect(row("reminder")).toMatchObject({ last_at: T + REVIEW_WAIT_MS, pending_at: null, outcome: "sent" });
    expect(notices.nextDue()).toBe(T + REVIEW_WAIT_MS + REMINDER_INTERVAL_MS);
    expect(notices.begin("reminder", T + REVIEW_WAIT_MS + NOTICE_INTERVAL_MS)).toBeNull();
    expect(notices.begin("reminder", T + REVIEW_WAIT_MS + REMINDER_INTERVAL_MS - 1)).toBeNull();
    expect(attempted(notices.begin("reminder", T + REVIEW_WAIT_MS + REMINDER_INTERVAL_MS)).attempt).toBe(1);
  });

  it("turning reminders on with facts waiting 4 days sends one 24 hours later, not at the next alarm", () => {
    const { notices, fact } = harness();
    fact(T - 4 * DAY);
    notices.set("reminder", true, A, T);
    expect(notices.begin("reminder", T + MINUTE)).toBeNull();
    expect(notices.nextDue()).toBe(T + NOTICE_INTERVAL_MS);
    expect(notices.begin("reminder", T + NOTICE_INTERVAL_MS - 1)).toBeNull();
    expect(attempted(notices.begin("reminder", T + NOTICE_INTERVAL_MS)).attempt).toBe(1);
  });

  it("a reminder stops when nothing is proposed", () => {
    const { notices, fact, row, write } = harness();
    notices.set("reminder", true, A, T);
    const waiting = fact(T);
    const first = attempted(notices.begin("reminder", T + REVIEW_WAIT_MS));
    // The fact is reviewed while the notice is in retry: the retry is stood down.
    write(`UPDATE facts SET state = 'confirmed' WHERE id = ?`, waiting);
    expect(notices.begin("reminder", first.retryAt)).toBeNull();
    expect(row("reminder")).toMatchObject({ attempts: 0, retry_at: null });
    expect(notices.nextDue()).toBeNull();
    expect(notices.begin("reminder", T + 30 * DAY)).toBeNull();
    // A rejected or confirmed fact is no reason, however old.
    fact(T - 9 * DAY, "rejected");
    expect(notices.nextDue()).toBeNull();
  });

  it("comments don't count as suggestions, nor suggestions as comments", () => {
    const both = () => {
      const made = harness();
      made.notices.set("comment", true, A, T);
      made.notices.set("suggestion", true, A, T);
      return made;
    };
    // Only a comment: a suggestion's mark comes to nothing, and the comment's is due.
    const first = both();
    first.comment(T + MINUTE);
    first.notices.note("suggestion", T + MINUTE);
    first.notices.note("comment", T + MINUTE);
    expect(first.notices.begin("suggestion", T + HOUR)).toBeNull();
    expect(first.row("suggestion")!.pending_at).toBeNull();
    expect(attempted(first.notices.begin("comment", T + HOUR)).kind).toBe("comment");
    // Only a suggestion: the other way round.
    const second = both();
    second.comment(T + MINUTE, { suggestion: "open" });
    second.notices.note("comment", T + MINUTE);
    second.notices.note("suggestion", T + MINUTE);
    expect(second.notices.begin("comment", T + HOUR)).toBeNull();
    expect(second.row("comment")!.pending_at).toBeNull();
    expect(attempted(second.notices.begin("suggestion", T + HOUR)).kind).toBe("suggestion");
    // A declined suggestion is neither.
    const third = both();
    third.comment(T + MINUTE, { suggestion: "declined" });
    third.notices.note("comment", T + MINUTE);
    third.notices.note("suggestion", T + MINUTE);
    expect(third.notices.begin("comment", T + HOUR)).toBeNull();
    expect(third.notices.begin("suggestion", T + HOUR)).toBeNull();
  });

  it("signedIn pauses kinds with another check or no address, and resumes on a match", () => {
    const { notices, comment, row } = harness();
    notices.set("comment", true, A, T);
    notices.set("suggestion", true, B, T);
    comment(T + MINUTE);
    notices.note("comment", T + MINUTE);
    notices.note("suggestion", T + MINUTE);
    attempted(notices.begin("comment", T + MINUTE + NOTICE_DELAY_MS));
    notices.signedIn(A);
    expect(row("comment")).toMatchObject({ outcome: null, attempts: 1 });
    expect(row("suggestion")).toMatchObject({ outcome: "paused", pending_at: null, attempts: 0, retry_at: null });
    expect(notices.view()).toEqual({ comment: true, suggestion: true, reminder: false, status: "paused" });
    notices.signedIn(null);
    expect(row("comment")).toMatchObject({ outcome: "paused", pending_at: null, attempts: 0, retry_at: null });
    expect(row("suggestion")!.outcome).toBe("paused");
    notices.signedIn(A);
    expect(row("comment")!.outcome).toBeNull();
    expect(row("suggestion")!.outcome).toBe("paused");
    notices.signedIn(B);
    expect(row("comment")!.outcome).toBe("paused");
    expect(row("suggestion")!.outcome).toBeNull();
    // A kind that is off is never paused.
    notices.set("reminder", false, null, T);
    notices.signedIn(null);
    expect(row("reminder")).toBeUndefined();
  });

  it("a paused kind queues nothing and is never due", () => {
    const { notices, comment, fact, row } = harness();
    notices.set("comment", true, A, T);
    notices.set("reminder", true, A, T);
    fact(T - 9 * DAY);
    notices.signedIn(B);
    comment(T + MINUTE);
    notices.note("comment", T + MINUTE);
    expect(row("comment")).toMatchObject({ outcome: "paused", pending_at: null });
    expect(notices.nextDue()).toBeNull();
    expect(notices.begin("comment", T + DAY)).toBeNull();
    expect(notices.begin("reminder", T + 30 * DAY)).toBeNull();
    // A send that was in flight when it paused leaves it paused, whatever it came back with.
    notices.settle("comment", T, "sent");
    notices.settle("reminder", T, "failed");
    expect(row("comment")!.outcome).toBe("paused");
    expect(row("reminder")!.outcome).toBe("paused");
  });

  it("retry times are 5 and 30 minutes, and a fourth attempt is never made", () => {
    const { notices, comment, row } = harness();
    expect(RETRY_DELAYS_MS).toEqual([5 * MINUTE, 30 * MINUTE, 30 * MINUTE]);
    expect(MAX_NOTICE_ATTEMPTS).toBe(3);
    notices.set("comment", true, A, T);
    comment(T);
    notices.note("comment", T);
    const start = T + NOTICE_DELAY_MS;
    expect(attempted(notices.begin("comment", start))).toMatchObject({ attempt: 1, retryAt: start + 5 * MINUTE });
    expect(notices.nextDue()).toBe(start + 5 * MINUTE);
    expect(notices.begin("comment", start + 5 * MINUTE - 1)).toBeNull();
    expect(attempted(notices.begin("comment", start + 5 * MINUTE))).toMatchObject({ attempt: 2, retryAt: start + 35 * MINUTE });
    expect(notices.begin("comment", start + 35 * MINUTE - 1)).toBeNull();
    expect(attempted(notices.begin("comment", start + 35 * MINUTE))).toMatchObject({ attempt: 3, retryAt: start + 65 * MINUTE });
    expect(row("comment")).toMatchObject({ attempts: 3, retry_at: start + 65 * MINUTE, last_at: start });
    expect(notices.begin("comment", start + 65 * MINUTE)).toEqual({ exhausted: true, kind: "comment" });
    expect(row("comment")).toMatchObject({ attempts: 0, retry_at: null, outcome: "failed" });
    for (const later of [start + 66 * MINUTE, start + 2 * DAY]) expect(notices.begin("comment", later)).toBeNull();
  });

  it("an attempt left unanswered settles as failed", () => {
    const { notices, fact, row } = harness();
    notices.set("reminder", true, A, T - DAY);
    fact(T - REVIEW_WAIT_MS);
    // Three attempts that never came back: no settle is ever called.
    let at = T;
    for (let attempt = 1; attempt <= MAX_NOTICE_ATTEMPTS; attempt++) at = attempted(notices.begin("reminder", at)).retryAt;
    expect(notices.nextDue()).toBe(at);
    expect(notices.view().status).toBe("ok");
    expect(notices.begin("reminder", at)).toEqual({ exhausted: true, kind: "reminder" });
    expect(row("reminder")).toMatchObject({ attempts: 0, retry_at: null, outcome: "failed", last_at: T });
    expect(notices.view().status).toBe("failing");
    // The next reminder is a week from the first attempt.
    expect(notices.nextDue()).toBe(T + REMINDER_INTERVAL_MS);
  });

  it("dropPending clears everything queued", () => {
    const { notices, comment, row } = harness();
    notices.set("comment", true, A, T);
    notices.set("suggestion", true, A, T);
    comment(T);
    comment(T, { suggestion: "open" });
    notices.note("comment", T);
    notices.note("suggestion", T);
    attempted(notices.begin("comment", T + NOTICE_DELAY_MS));
    notices.dropPending();
    for (const kind of ["comment", "suggestion"]) expect(row(kind)).toMatchObject({ on_at: T, pending_at: null, attempts: 0, retry_at: null });
    expect(notices.nextDue()).toBeNull();
    expect(notices.view()).toMatchObject({ comment: true, suggestion: true });
  });

  it("settle after turning off changes nothing", () => {
    const { notices, comment, row, rows } = harness();
    notices.set("comment", true, A, T);
    comment(T);
    notices.note("comment", T);
    const made = attempted(notices.begin("comment", T + NOTICE_DELAY_MS));
    notices.set("comment", false, null, T + NOTICE_DELAY_MS + 1);
    const off = rows();
    for (const outcome of ["sent", "failed", "paused"] as const) notices.settle("comment", made.onAt, outcome);
    expect(rows()).toEqual(off);
    // Nor once it is on again: that is another turning on.
    notices.set("comment", true, A, T + NOTICE_DELAY_MS + 2);
    const again = row("comment");
    for (const outcome of ["sent", "failed", "paused"] as const) notices.settle("comment", made.onAt, outcome);
    expect(row("comment")).toEqual(again);
    expect(notices.current(made)).toBe(false);
  });

  it("nextDue for each state", () => {
    const { notices, comment, fact, write } = harness();
    expect(notices.nextDue()).toBeNull();
    notices.set("comment", true, A, T);
    notices.set("suggestion", true, A, T);
    notices.set("reminder", true, A, T);
    // On, with nothing pending and no fact waiting.
    expect(notices.nextDue()).toBeNull();
    comment(T + HOUR);
    notices.note("comment", T + HOUR);
    expect(notices.nextDue()).toBe(T + HOUR + NOTICE_DELAY_MS);
    // A day not yet over since the last notice holds it back.
    write(`UPDATE email_notices SET last_at = ? WHERE kind = 'comment'`, T + 30 * MINUTE);
    expect(notices.nextDue()).toBe(T + 30 * MINUTE + NOTICE_INTERVAL_MS);
    // A suggestion due sooner is the earliest.
    comment(T + 2 * HOUR, { suggestion: "open" });
    notices.note("suggestion", T + 2 * HOUR);
    expect(notices.nextDue()).toBe(T + 2 * HOUR + NOTICE_DELAY_MS);
    // A retry is due at its time, whatever else holds.
    const retry = attempted(notices.begin("suggestion", T + 2 * HOUR + NOTICE_DELAY_MS));
    expect(notices.nextDue()).toBe(retry.retryAt);
    notices.settle("suggestion", T, "sent");
    expect(notices.nextDue()).toBe(T + 30 * MINUTE + NOTICE_INTERVAL_MS);
    // A reminder: three days after the oldest fact waiting, and a day after it was turned on.
    notices.set("comment", false, null, T);
    fact(T - 10 * DAY);
    expect(notices.nextDue()).toBe(T + NOTICE_INTERVAL_MS);
    write(`UPDATE facts SET updated_at = ?`, T + DAY);
    expect(notices.nextDue()).toBe(T + DAY + REVIEW_WAIT_MS);
    write(`UPDATE email_notices SET last_at = ? WHERE kind = 'reminder'`, T + 2 * DAY);
    expect(notices.nextDue()).toBe(T + 2 * DAY + REMINDER_INTERVAL_MS);
    // Paused, nothing is due.
    notices.signedIn(B);
    expect(notices.nextDue()).toBeNull();
  });

  it("every CHECK refuses a bad row", () => {
    const { db, rows } = harness();
    const insert = (values: Record<string, Value>) => {
      const row: Record<string, Value> = { kind: "comment", on_at: T, address_check: A, pending_at: null, last_at: null, attempts: 0, retry_at: null, outcome: null, ...values };
      const columns = Object.keys(row);
      return () => db.prepare(`INSERT INTO email_notices (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
    };
    const refused: Record<string, Value>[] = [
      { kind: "digest" },
      { on_at: 0 },
      { on_at: 1.5 },
      { on_at: "soon" },
      { address_check: "a".repeat(63) },
      { address_check: "A".repeat(64) },
      { address_check: `${"a".repeat(63)}g` },
      { pending_at: "now" },
      { last_at: 1.5 },
      { attempts: 4, retry_at: T },
      { attempts: -1, retry_at: T },
      { attempts: 1.5, retry_at: T },
      { attempts: null },
      { retry_at: "later", attempts: 1 },
      { outcome: "bounced" },
      // An address check without its turning on, and the other way round.
      { on_at: null },
      { address_check: null },
      // Something queued for a kind that is off.
      { on_at: null, address_check: null, pending_at: T },
      { on_at: null, address_check: null, attempts: 1, retry_at: T },
      // A reminder is never pending.
      { kind: "reminder", pending_at: T },
      // Attempts and their retry go together.
      { attempts: 1 },
      { retry_at: T },
      // Paused holds nothing queued.
      { outcome: "paused", pending_at: T },
      { outcome: "paused", attempts: 1, retry_at: T },
    ];
    for (const values of refused) expect(insert(values), JSON.stringify(values)).toThrow(/CHECK|NOT NULL/);
    expect(rows()).toEqual([]);
    // Each of those is one change from rows the table takes.
    for (const values of [{}, { kind: "reminder" }, { kind: "suggestion", on_at: null, address_check: null, last_at: T }] as Record<string, Value>[]) insert(values)();
    expect(rows()).toHaveLength(3);
    db.prepare(`DELETE FROM email_notices WHERE kind = 'suggestion'`).run();
    insert({ kind: "suggestion", attempts: 3, retry_at: T, pending_at: T, outcome: "failed" })();
    expect(rows()).toHaveLength(3);
    // One row a kind: the primary key is the cap.
    expect(insert({ kind: "comment", on_at: T + 1 })).toThrow(/UNIQUE|PRIMARY/);
  });

  it("the address check is lower-case hex of the labelled address", async () => {
    const check = await noticeAddressCheck("owner@example.test");
    expect(check).toMatch(/^[0-9a-f]{64}$/);
    expect(await noticeAddressCheck("owner@example.test")).toBe(check);
    expect(await noticeAddressCheck("other@example.test")).not.toBe(check);
    const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("resumatic-email-notice-v1\nowner@example.test"))).toString("hex");
    expect(check).toBe(expected);
  });
});
