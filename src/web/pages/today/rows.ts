import { APPLICATION_STATUSES, type ApplicationStatus, type Me } from "../../../shared/api";
import type { DocumentKind } from "../../../shared/documents";
import type { Today, TodayEvent, TodayWaiting, TodayWorking } from "../../../shared/today";
import { quotaWords } from "../../components/QuotaMeter";
import { chosenName } from "../../components/ShareComments";
import { STEPS } from "../../components/TailorProgress";
import type { TickState } from "../../components/ui";
import { count } from "../../format";
import { href, type JobTab } from "../../router";

// What Today says about each thing, worked out from the Today the shell loaded. Nothing here
// renders or asks the API. Every name in Today (a file's, a job's, a coach's, a label) is untrusted
// text: these functions put it into sentences that React shows as text, and never into an address.

/**
 * The order the next step is chosen in, first to last: a file that couldn't be read (only the
 * person can fix it), a coach's suggestion (a coach waits for the answer), facts to check (they
 * unlock every resume), a kit's questions (they block one job), then comments (only to read). A
 * Record over every kind, so a new kind can't be added to the API without a place here.
 */
export const NEXT_PRIORITY: Readonly<Record<TodayWaiting["kind"], number>> = {
  unreadable: 0,
  suggestions: 1,
  check: 2,
  kit: 3,
  comments: 4,
};

/** Whether this version knows the item's kind. An unknown kind, from a newer server, is never shown. */
export function isKnown(item: { kind: string }): item is TodayWaiting {
  return Object.hasOwn(NEXT_PRIORITY, item.kind);
}

/** What waits, of the kinds this version knows, in the order the server lists it. */
export function knownWaiting(today: Today): TodayWaiting[] {
  return today.waiting.filter(isKnown);
}

/** Orders items by NEXT_PRIORITY. The sort is stable, so within a kind the server's order stands. */
export function byPriority(a: TodayWaiting, b: TodayWaiting): number {
  return NEXT_PRIORITY[a.kind] - NEXT_PRIORITY[b.kind];
}

/** The one next step: the first known item in priority order, or null when none is known. */
export function nextStep(today: Today): TodayWaiting | null {
  return [...knownWaiting(today)].sort(byPriority)[0] ?? null;
}

/** An item's share of `counts.today`: how many things it stands for in the header's count. */
export function units(item: TodayWaiting | null): number {
  if (!item) return 0;
  switch (item.kind) {
    case "unreadable":
      return 1;
    case "check":
      return item.roles + item.facts;
    case "kit":
      return item.unanswered + item.sensitive;
    case "comments":
    case "suggestions":
      return item.count;
  }
}

/** How many things wait besides the next step, in the header's units. */
export function listCount(today: Today, next: TodayWaiting | null): number {
  return Math.max(0, today.counts.today - units(next));
}

/** How many of the header's things no row shows: past a list's cap, or of a kind this version doesn't know. */
export function hiddenUnits(today: Today): number {
  return Math.max(0, today.counts.today - knownWaiting(today).reduce((sum, item) => sum + units(item), 0));
}

/** A coach as Today names them: by the name they chose, otherwise by their address. */
export function coachLabel(coach: { coachName: string | null; coachEmail: string | null }): string | null {
  return chosenName(coach.coachName) ?? coach.coachEmail;
}

/** A job as Today names it: its title at its company, either alone, or "a job you saved". */
export function jobName(job: { title: string | null; company: string | null }): string {
  const title = job.title?.trim();
  const company = job.company?.trim();
  if (title && company) return `${title} at ${company}`;
  return title || company || "a job you saved";
}

export interface WaitingRow {
  /** The row's title. */
  title: string;
  /** The title when it is the next step. */
  nextTitle: string;
  /** One sentence: why it matters, or what happens. */
  sentence: string;
  /** The words of its one link. */
  action: string;
  /** The page that resolves it. */
  to: string;
  tick: TickState;
  units: number;
}

const RESUMES_USE_THEM = "Your resumes can use them once you say they’re right.";

/** What a waiting item says, and where it leads. */
export function waitingRow(item: TodayWaiting): WaitingRow {
  const n = units(item);
  const them = n === 1 ? "it" : "them";
  switch (item.kind) {
    case "unreadable": {
      const title = `${item.filename} couldn’t be read`;
      return {
        title,
        nextTitle: `See why ${item.filename} couldn’t be read`,
        sentence: "Your files says why, and what you can do about it.",
        action: "See what to do",
        to: href.files,
        tick: "problem",
        units: n,
      };
    }
    case "suggestions": {
      const coach = coachLabel(item);
      const title = n === 1 ? `Read a suggestion from ${coach}` : `Read ${count(n, "suggestion")} from ${coach}`;
      const lines = n === 1 ? "a line" : "lines";
      return {
        title,
        nextTitle: title,
        sentence: `New wording for ${lines} of a copy you shared. Nothing changes unless you accept it.`,
        action: `Read ${them}`,
        to: href.coaches,
        tick: "needs-you",
        units: n,
      };
    }
    case "check": {
      const parts = [item.roles > 0 ? count(item.roles, "role") : "", item.facts > 0 ? count(item.facts, "fact") : ""].filter(Boolean);
      const title = `Check ${parts.join(" and ")}`;
      const from = item.sourceId !== null && item.filename ? `From ${item.filename}.` : "Not from any of your files.";
      return {
        title,
        nextTitle: title,
        sentence: `${from} ${RESUMES_USE_THEM}`,
        action: `Check ${them}`,
        to: href.facts,
        tick: "needs-you",
        units: n,
      };
    }
    case "kit": {
      const title = `Answer ${count(n, "question")} for ${jobName(item)}`;
      const never =
        item.sensitive === 0
          ? ""
          : item.sensitive === 1
            ? " One question asks about something whose answer is never saved."
            : ` ${item.sensitive.toLocaleString()} questions ask about something whose answer is never saved.`;
      return {
        title,
        nextTitle: title,
        sentence: `Its kit stopped there. Resumatic never guesses an answer.${never}`,
        action: "Answer",
        to: href.job(item.applicationId, "application"),
        tick: "needs-you",
        units: n,
      };
    }
    case "comments": {
      const coach = coachLabel(item);
      const title = n === 1 ? `Read a new comment from ${coach}` : `Read ${n.toLocaleString()} new comments from ${coach}`;
      return {
        title,
        nextTitle: title,
        sentence: "On a copy you shared with them.",
        action: `Read ${them}`,
        to: href.coaches,
        tick: "needs-you",
        units: n,
      };
    }
  }
}

/** Each kind of document in progress: what it is called, and the job's page that shows it. */
const DOCUMENT_WORK: Readonly<Record<DocumentKind, { title: (job: string) => string; tab: JobTab }>> = {
  letter: { title: (job) => `A cover letter for ${job}`, tab: "letter" },
  prep: { title: (job) => `Interview preparation for ${job}`, tab: "interview" },
  questions: { title: (job) => `Questions about your experience for ${job}`, tab: "fit" },
  refine: { title: (job) => `New wording for your resume for ${job}`, tab: "resume" },
  fit: { title: (job) => `Fit for ${job}`, tab: "fit" },
};

const WORKING_KINDS: readonly string[] = ["reading", "tailoring", "document"] satisfies TodayWorking["kind"][];

/** Work in progress of the kinds this version knows. */
export function knownWorking(today: Today): TodayWorking[] {
  return today.working.filter(
    (item) => WORKING_KINDS.includes(item.kind) && (item.kind !== "document" || Object.hasOwn(DOCUMENT_WORK, item.documentKind)),
  );
}

/** What a piece of work in progress is called, how far it has got, and where it is shown. */
export function workingRow(item: TodayWorking): { title: string; status: string; to: string } {
  switch (item.kind) {
    case "reading":
      return { title: `Reading ${item.filename}`, status: "What it finds will appear under Facts for you to check.", to: href.files };
    case "tailoring": {
      // As TailorProgress counts: `step` is the last step that finished, and the one under way is next.
      const done = STEPS.findIndex((step) => step.id === item.step) + 1;
      const current = Math.min(done, STEPS.length - 1);
      return {
        title: `A resume for ${jobName(item)}`,
        status: `Step ${current + 1} of ${STEPS.length}: ${STEPS[current]!.label}. You can leave this page. Tailoring carries on.`,
        to: href.jobResume(item.applicationId, item.resumeId),
      };
    }
    case "document": {
      const work = DOCUMENT_WORK[item.documentKind];
      return { title: work.title(jobName(item)), status: "Resumatic is working on it. You can leave this page.", to: href.job(item.applicationId, work.tab) };
    }
  }
}

const EVENT_KINDS: readonly string[] = ["copyOpened", "resumeReady", "coachCommented"] satisfies TodayEvent["kind"][];

/** Recent events of the kinds this version knows, newest first as the server lists them. */
export function knownEvents(today: Today): TodayEvent[] {
  return today.recent.filter((event) => EVENT_KINDS.includes(event.kind));
}

/** A recent event, in one sentence. */
export function eventSentence(event: TodayEvent): string {
  switch (event.kind) {
    case "copyOpened": {
      // Anyone holding the link may have opened it, and the copy promises its reader that the owner
      // can't see who did, so the sentence names the copy, never a reader.
      const coach = coachLabel(event);
      if (coach) return `The copy you shared with ${coach} was opened.`;
      const label = event.label?.trim();
      return label ? `The copy you shared as “${label}” was opened.` : "A copy you shared was opened.";
    }
    case "resumeReady":
      return event.version > 1 ? `A new version of your resume for ${jobName(event)} is ready.` : `A resume for ${jobName(event)} is ready.`;
    case "coachCommented":
      return `${coachLabel(event)} wrote on the copy you shared.`;
  }
}

/** How many roles and facts wait in To check: the figure the To check tab shows. */
export function toCheck(today: Today): number {
  return knownWaiting(today).reduce((sum, item) => (item.kind === "check" ? sum + item.roles + item.facts : sum), 0);
}

/** How each job status is said after its number. */
const JOB_STATUS_WORDS: Readonly<Record<ApplicationStatus, string>> = {
  saved: "saved",
  applied: "applied",
  interview: "at interview",
  offer: "with an offer",
  closed: "closed",
};

export interface StandingLine {
  key: "facts" | "jobs" | "sharing" | "plan";
  label: string;
  to: string;
  text: string;
}

/**
 * Where things stand in each room, one line each. Without `standing` (an older server) only the
 * plan is said, from the session. Recruiters are named only as a private preview, and only where
 * the deployment has the card preview.
 */
export function standingLines(today: Today, me: Me): StandingLine[] {
  const plan: StandingLine = { key: "plan", label: "Plan", to: href.accountSection("plan"), text: `${quotaWords(me.quota).text}.` };
  const standing = today.standing;
  if (!standing) return [plan];
  const n = (value: number) => value.toLocaleString();
  const jobs = APPLICATION_STATUSES.filter((status) => standing.jobs[status] > 0).map((status) => `${n(standing.jobs[status])} ${JOB_STATUS_WORDS[status]}`);
  let sharing =
    standing.copies > 0
      ? `${count(standing.copies, "copy", "copies")} shared${standing.coachCopies > 0 ? `, ${n(standing.coachCopies)} with a coach` : ""}.`
      : "Nothing shared.";
  if (me.capabilities?.connectedApps) sharing += standing.apps > 0 ? ` ${count(standing.apps, "connected app")}.` : " No connected apps.";
  if (me.capabilities?.cardPreview) sharing += " Your anonymous profile has a private preview only you can see.";
  return [
    { key: "facts", label: "Facts", to: href.factsAll, text: `${n(standing.confirmed)} confirmed, ${n(toCheck(today))} to check, ${n(standing.leftOut)} left out` },
    { key: "jobs", label: "Jobs", to: href.jobs, text: jobs.length ? `${jobs.join(", ")}.` : "No jobs yet." },
    { key: "sharing", label: "Sharing", to: href.sharing, text: sharing },
    plan,
  ];
}

/**
 * Whether Today opens with its three first steps: the record holds no file, no role and no fact.
 * Never without `standing`, which an older server doesn't send. countByState totals zero exactly
 * when there are no roles or facts, so this is the Facts page's own first run.
 */
export function isFirstRun(today: Today): boolean {
  const standing = today.standing;
  return !!standing && standing.files === 0 && standing.confirmed === 0 && standing.leftOut === 0 && toCheck(today) === 0;
}
