import { APPLICATION_STATUSES, type ApplicationStatus } from "../shared/api";
import type { DocumentKind } from "../shared/documents";
import {
  emptyStanding,
  MAX_TODAY_LIST,
  MAX_TODAY_RECENT,
  TODAY_RECENT_MS,
  type Today,
  type TodayCoach,
  type TodayEvent,
  type TodayJob,
  type TodayWaiting,
  type TodayWorking,
} from "../shared/today";

// The reads behind Today that no other store owns: file names and states, work in progress, and
// the resume versions made lately. Each reads names, states, times and IDs, never a file's text,
// a stored error or a line's words. The store checks nobody, so the Vault calls it for the owner
// only, and every method that looks back takes the time it looks back from.

/** A copy's coach and how many of their rows wait, as the comments' store counts them. */
export interface CopyCount extends TodayCoach {
  count: number;
  latest: number;
}

/** When a coach last wrote on a copy. */
export interface CopyComment extends TodayCoach {
  at: number;
}

/** When a copy was last opened, and who it was for. */
export interface CopyOpened {
  grantId: string;
  label: string | null;
  coachName: string | null;
  coachEmail: string | null;
  at: number;
}

/** What waits on one job's kit: the questions with no usable answer, and the answers it can't use. */
export interface KitCount {
  applicationId: string;
  unanswered: number;
  sensitive: number;
}

/** Everything Today is made from, each read for the owner inside one transaction. */
export interface TodayParts {
  /** Roles and facts to check, by the file they are shown under, as To check groups them. */
  check: Map<string | null, { roles: number; facts: number }>;
  /** Every file's name, by its ID. */
  sourceNames: ReadonlyMap<string, string>;
  unreadable: { sourceId: string; filename: string; createdAt: number }[];
  comments: CopyCount[];
  suggestions: CopyCount[];
  /** Every job whose kit has something waiting, newest job first. */
  kits: KitCount[];
  /** The names of the jobs the list shows: at least the first MAX_TODAY_LIST of `kits`. */
  jobNames: ReadonlyMap<string, { title: string | null; company: string | null }>;
  working: TodayWorking[];
  resumesReady: Extract<TodayEvent, { kind: "resumeReady" }>[];
  copiesOpened: CopyOpened[];
  coachComments: CopyComment[];
  /** Roles and facts confirmed and left out, each counted once as the review groups them. */
  confirmed: number;
  leftOut: number;
  /** Jobs by tracking status, every status present. */
  jobs: Record<ApplicationStatus, number>;
  /** Shared copies neither revoked nor expired, and those of them naming a coach. */
  copies: { copies: number; coachCopies: number };
  /** Connected apps whose access is active. */
  apps: number;
}

export class TodayStore {
  constructor(private readonly sql: SqlStorage) {}

  /** Each file's ID and name, and nothing else of it. */
  sourceNames(): Map<string, string> {
    return new Map(this.sql.exec<{ id: string; filename: string }>(`SELECT id, filename FROM sources`).toArray().map((row) => [row.id, row.filename]));
  }

  /** The files that couldn't be read, newest first. Why is left where it is kept. */
  unreadable(): TodayParts["unreadable"] {
    return this.sql
      .exec<{ id: string; filename: string; created_at: number }>(`SELECT id, filename, created_at FROM sources WHERE state = 'failed' ORDER BY created_at DESC`)
      .toArray()
      .map((row) => ({ sourceId: row.id, filename: row.filename, createdAt: row.created_at }));
  }

  /** Files being read, resumes being tailored and documents being written: newest first, at most `limit` of each. */
  working(limit: number): TodayWorking[] {
    const reading = this.sql
      .exec<{ id: string; filename: string; created_at: number }>(
        `SELECT id, filename, created_at FROM sources WHERE state = 'queued' ORDER BY created_at DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row): TodayWorking => ({ kind: "reading", sourceId: row.id, filename: row.filename, startedAt: row.created_at }));
    const tailoring = this.sql
      .exec<{ id: string; application_id: string; step: string | null; created_at: number; title: string | null; company: string | null }>(
        `SELECT r.id, r.application_id, r.step, r.created_at, a.title, a.company FROM resumes r JOIN applications a ON a.id = r.application_id WHERE r.state = 'running' ORDER BY r.created_at DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row): TodayWorking => ({ kind: "tailoring", resumeId: row.id, step: row.step, startedAt: row.created_at, ...job(row) }));
    const documents = this.sql
      .exec<{ id: string; kind: DocumentKind; application_id: string; created_at: number; title: string | null; company: string | null }>(
        `SELECT d.id, d.kind, d.application_id, d.created_at, a.title, a.company FROM documents d JOIN applications a ON a.id = d.application_id WHERE d.state = 'running' ORDER BY d.created_at DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row): TodayWorking => ({ kind: "document", documentId: row.id, documentKind: row.kind, startedAt: row.created_at, ...job(row) }));
    return [...reading, ...tailoring, ...documents];
  }

  /** Resume versions made since `since`, newest first, at most `limit`. */
  resumesReady(since: number, limit: number): TodayParts["resumesReady"] {
    return this.sql
      .exec<{ resume_id: string; version: number; at: number; application_id: string; title: string | null; company: string | null }>(
        `SELECT v.resume_id, v.version, v.created_at AS at, r.application_id, a.title, a.company FROM resume_versions v JOIN resumes r ON r.id = v.resume_id JOIN applications a ON a.id = r.application_id WHERE v.created_at >= ? ORDER BY v.created_at DESC, v.version DESC LIMIT ?`,
        since,
        limit,
      )
      .toArray()
      .map((row) => ({ kind: "resumeReady", resumeId: row.resume_id, version: row.version, at: row.at, ...job(row) }));
  }

  /** How many jobs have each tracking status, every status present. It reads the status alone, never a posting. */
  jobsByStatus(): Record<ApplicationStatus, number> {
    const counts = emptyStanding().jobs;
    for (const row of this.sql.exec<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM applications GROUP BY status`).toArray())
      if ((APPLICATION_STATUSES as readonly string[]).includes(row.status)) counts[row.status as ApplicationStatus] = row.n;
    return counts;
  }

  /** The names of these jobs, by ID. A job that has gone is left out. */
  jobNames(ids: readonly string[]): Map<string, { title: string | null; company: string | null }> {
    if (ids.length === 0) return new Map();
    return new Map(
      this.sql
        .exec<{ id: string; title: string | null; company: string | null }>(
          `SELECT id, title, company FROM applications WHERE id IN (SELECT value FROM json_each(?))`,
          JSON.stringify(ids),
        )
        .toArray()
        .map((row) => [row.id, { title: row.title, company: row.company }]),
    );
  }
}

const job = (row: { application_id: string; title: string | null; company: string | null }): TodayJob => ({
  applicationId: row.application_id,
  title: row.title,
  company: row.company,
});

/** Newest first; at the same moment by kind, then by ID, so the order never depends on the reads. */
const byTime = <T extends { kind: string }>(time: (item: T) => number, id: (item: T) => string) => (a: T, b: T) =>
  time(b) - time(a) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);

const eventId = (event: TodayEvent) => (event.kind === "resumeReady" ? `${event.resumeId}/${event.version}` : event.grantId);
const workId = (item: TodayWorking) => (item.kind === "reading" ? item.sourceId : item.kind === "tailoring" ? item.resumeId : item.documentId);

/**
 * Today, from its parts, with recent events from TODAY_RECENT_MS before `now`. Each kind's list keeps at most MAX_TODAY_LIST items, and the counts total
 * every item, listed or not: Facts what To check asks and the files that couldn't be read, Jobs
 * what the kits wait on, Sharing what coaches wait on, and Today the three rooms together.
 * `standing` is where each room stands, as numbers only: files, roles and facts confirmed and left
 * out, jobs by status, open copies and active connected apps.
 */
export function todayView(parts: TodayParts, now: number): Today {
  const since = now - TODAY_RECENT_MS;
  const check: TodayWaiting[] = [...parts.check].map(([sourceId, counts]) => ({
    kind: "check",
    sourceId,
    filename: sourceId === null ? null : (parts.sourceNames.get(sourceId) ?? null),
    roles: counts.roles,
    facts: counts.facts,
  }));
  const unreadable: TodayWaiting[] = parts.unreadable.map((item) => ({ kind: "unreadable", ...item }));
  const comments: TodayWaiting[] = parts.comments.slice(0, MAX_TODAY_LIST).map((copy) => ({ kind: "comments", ...copy }));
  const suggestions: TodayWaiting[] = parts.suggestions.slice(0, MAX_TODAY_LIST).map((copy) => ({ kind: "suggestions", ...copy }));
  const kits: TodayWaiting[] = parts.kits.slice(0, MAX_TODAY_LIST).map((kit) => {
    const name = parts.jobNames.get(kit.applicationId);
    return { kind: "kit", applicationId: kit.applicationId, title: name?.title ?? null, company: name?.company ?? null, unanswered: kit.unanswered, sensitive: kit.sensitive };
  });
  const sum = <T>(items: readonly T[], of: (item: T) => number) => items.reduce((total, item) => total + of(item), 0);
  const facts = sum([...parts.check.values()], (counts) => counts.roles + counts.facts) + parts.unreadable.length;
  const jobs = sum(parts.kits, (kit) => kit.unanswered + kit.sensitive);
  const sharing = sum(parts.comments, (copy) => copy.count) + sum(parts.suggestions, (copy) => copy.count);
  const recent: TodayEvent[] = [
    ...parts.copiesOpened.map((copy): TodayEvent => ({ kind: "copyOpened", ...copy })),
    ...parts.resumesReady,
    ...parts.coachComments.map((copy): TodayEvent => ({ kind: "coachCommented", ...copy })),
  ]
    .filter((event) => event.at >= since)
    .sort(byTime((event) => event.at, eventId))
    .slice(0, MAX_TODAY_RECENT);
  return {
    waiting: [...check, ...unreadable, ...comments, ...suggestions, ...kits],
    working: [...parts.working].sort(byTime((item) => item.startedAt, workId)),
    recent,
    counts: { today: facts + jobs + sharing, facts, jobs, sharing },
    since,
    standing: {
      files: parts.sourceNames.size,
      confirmed: parts.confirmed,
      leftOut: parts.leftOut,
      jobs: parts.jobs,
      copies: parts.copies.copies,
      coachCopies: parts.copies.coachCopies,
      apps: parts.apps,
    },
  };
}
