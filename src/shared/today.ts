import { APPLICATION_STATUSES, type ApplicationStatus } from "./api";
import type { DocumentKind } from "./documents";

// What waits for the owner across their rooms, as GET /api/v2/today gives it. It is derived from the
// owner's own vault on each request and stored nowhere. It carries counts, IDs and the names the
// owner's pages already show (file names, link labels, job titles and companies, coach names and
// addresses), and never the words of a fact, a comment, an employer's question, an answer or a
// stored error. Every name in it is untrusted text, shown as text and never put in a prompt.

/** The most recent events it lists. */
export const MAX_TODAY_RECENT = 10;
/** How far back recent events go: fourteen days. */
export const TODAY_RECENT_MS = 14 * 86_400_000;
/** The most items of each kind of coach, job and work in progress it lists. Its counts total every row. */
export const MAX_TODAY_LIST = 50;

/** A job, as the owner named it or its posting did. */
export interface TodayJob {
  applicationId: string;
  title: string | null;
  company: string | null;
}

/** A coach, as the copy they hold stores them. Shown by the name they chose, else the address. */
export interface TodayCoach {
  grantId: string;
  coachName: string | null;
  coachEmail: string;
}

export type TodayWaiting =
  /** Roles and facts to check, by the file they are shown under; a null source is what came from no file. */
  | { kind: "check"; sourceId: string | null; filename: string | null; roles: number; facts: number }
  /** A file that couldn't be read. Why is shown on Your files, never here. */
  | { kind: "unreadable"; sourceId: string; filename: string; createdAt: number }
  /** A coach's comments on one copy that the owner hasn't seen. */
  | ({ kind: "comments"; count: number; latest: number } & TodayCoach)
  /** A coach's suggested wordings on one copy that wait for the owner's answer. */
  | ({ kind: "suggestions"; count: number; latest: number } & TodayCoach)
  /** A job's application kit with questions not yet answered, and answers it can't use. */
  | ({ kind: "kit"; unanswered: number; sensitive: number } & TodayJob);

export type TodayWorking =
  | { kind: "reading"; sourceId: string; filename: string; startedAt: number }
  | ({ kind: "tailoring"; resumeId: string; step: string | null; startedAt: number } & TodayJob)
  | ({ kind: "document"; documentId: string; documentKind: DocumentKind; startedAt: number } & TodayJob);

export type TodayEvent =
  | { kind: "copyOpened"; grantId: string; label: string | null; coachName: string | null; coachEmail: string | null; at: number }
  | ({ kind: "resumeReady"; resumeId: string; version: number; at: number } & TodayJob)
  | ({ kind: "coachCommented"; at: number } & TodayCoach);

/** One number per room: how many things wait there. Today's is the sum of the rooms'. */
export interface TodayCounts {
  today: number;
  facts: number;
  jobs: number;
  sharing: number;
}

export interface Today {
  waiting: TodayWaiting[];
  working: TodayWorking[];
  /** Newest first, at most MAX_TODAY_RECENT, none before `since`. */
  recent: TodayEvent[];
  counts: TodayCounts;
  /** Where recent events start: TODAY_RECENT_MS before the request. */
  since: number;
  /** Where things stand in each room. Absent from a server that predates it. */
  standing?: TodayStanding;
}

/** Nothing waiting, working or recent. */
export function emptyToday(now: number): Today {
  return { waiting: [], working: [], recent: [], counts: { today: 0, facts: 0, jobs: 0, sharing: 0 }, since: now - TODAY_RECENT_MS, standing: emptyStanding() };
}

/** Where things stand in each room, for the side of Today. Counts only. */
export interface TodayStanding {
  /** Files and pasted text, in any state. */
  files: number;
  /** Roles and facts, each counted once as the review groups them (countByState). To check is `waiting`'s check items. */
  confirmed: number;
  leftOut: number;
  /** Jobs by tracking status; every status present. */
  jobs: Record<ApplicationStatus, number>;
  /** Shared copies neither revoked nor expired, and those naming a coach. */
  copies: number;
  coachCopies: number;
  /** Connected apps whose access is active now. */
  apps: number;
}

/** Nothing anywhere: no file, fact, job, copy or app. */
export function emptyStanding(): TodayStanding {
  const jobs = Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, 0])) as Record<ApplicationStatus, number>;
  return { files: 0, confirmed: 0, leftOut: 0, jobs, copies: 0, coachCopies: 0, apps: 0 };
}
