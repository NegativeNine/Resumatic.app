import type { FactKind, Level, LineFinding, LineStatus, ResumeState, ReviewState, RoleKind } from "../shared/api";

// Dates follow the voice guide whatever the browser's locale: "Nov 2026", "7 Nov 2026",
// "7 Nov 2026, 9:42 AM". The app is written in English, and the PDF template uses the same
// month names (src/render/template.ts).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const YEAR_MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?$/;

/** "2026-11" (or "2026-11-05") as "Nov 2026". Dates in any other form are shown as written. */
export function formatMonth(value: string): string {
  const match = YEAR_MONTH.exec(value);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : value;
}

/** The first day of the month after a "YYYY-MM" month, such as "1 Dec 2026". */
export function formatMonthAfter(value: string): string | null {
  const next = monthAfter(value);
  return next ? `1 ${MONTHS[next.getUTCMonth()]} ${next.getUTCFullYear()}` : null;
}

/** The same day without its year, such as "1 Dec", for tight spaces like the quota meter. */
export function formatDayMonthAfter(value: string): string | null {
  const next = monthAfter(value);
  return next ? `1 ${MONTHS[next.getUTCMonth()]}` : null;
}

function monthAfter(value: string): Date | null {
  const match = YEAR_MONTH.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
}

export function formatDateRange(start: string | null, end: string | null, unknownEndStart?: string | null): string {
  if (unknownEndStart) return `Start: ${formatMonth(unknownEndStart)} (end unknown)`;
  if (!start) return end ? formatMonth(end) : "";
  return `${formatMonth(start)} – ${end ? formatMonth(end) : "present"}`;
}

// Timestamps are expected in milliseconds; values small enough to be seconds are scaled.
// They are shown in the person's own time zone.
const toMillis = (time: number) => (time < 1e12 ? time * 1000 : time);

/** "7 Nov 2026". */
export function formatDate(time: number): string {
  const d = new Date(toMillis(time));
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "7 Nov", for a date this year in a tight space. */
export function formatDayMonth(time: number): string {
  const d = new Date(toMillis(time));
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "7 Nov 2026, 9:42 AM". */
export function formatDateTime(time: number): string {
  const d = new Date(toMillis(time));
  const hour = d.getHours() % 12 || 12;
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${formatDate(time)}, ${hour}:${minutes} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

export const STATE_LABEL: Record<ReviewState, string> = {
  proposed: "To check",
  confirmed: "Confirmed",
  rejected: "Left out",
};

export const ROLE_KIND_LABEL: Record<RoleKind, string> = {
  job: "Job",
  education: "Education",
  project: "Project",
  volunteer: "Volunteering",
};

export const SECTION_HEADING: Record<RoleKind, string> = {
  job: "Experience",
  education: "Education",
  project: "Projects",
  volunteer: "Volunteering",
};

export const FACT_KIND_LABEL: Record<FactKind, string> = {
  accomplishment: "Something you did",
  skill: "A skill",
  credential: "A credential",
};

export const LEVEL_LABEL: Record<Level, string> = {
  contributed: "Contributed",
  implemented: "Implemented",
  led: "Led",
  owned: "Owned",
  founded: "Founded",
};

export const RESUME_STATE_LABEL: Record<ResumeState, string> = {
  running: "Tailoring…",
  ready: "Ready",
  failed: "Failed",
};

export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  kept: "Backed",
  repaired: "Corrected",
  replaced: "Your wording",
  edited: "Edited by you",
};

export const LINE_STATUS_HINT: Record<LineStatus, string> = {
  kept: "Backed by your record as written",
  repaired: "Rewritten once to match its facts",
  replaced: "The draft’s wording couldn’t be backed, so this line uses your fact’s own words",
  edited: "Changed by you",
};

/** What a level of ownership says about the work, as the end of "The draft said you …". */
const LEVEL_CLAIM: Record<Level, string> = {
  contributed: "contributed to it",
  implemented: "implemented it",
  led: "led it",
  owned: "owned it",
  founded: "founded it",
};

/** "40%", "40% and 3x", "Kafka, Flink and Spark". */
function listOf(values: string[]): string {
  return values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/**
 * Why the checks changed a repaired or replaced line, in the interface's own words. The values are
 * the numbers or names the rejected draft used, which is the only part that comes from the draft.
 */
export function findingSentence(finding: LineFinding, status: LineStatus): string {
  const values = "values" in finding && Array.isArray(finding.values) && finding.values.length > 0 &&
    finding.values.every((value) => typeof value === "string") ? finding.values : null;
  let reason: string;
  switch (finding.kind) {
    case "numbers":
      reason = values
        ? `The draft said ${listOf(values)}. Your record doesn’t include ${values.length === 1 ? "that number" : "those numbers"}.`
        : "The draft used a number your record doesn’t include.";
      break;
    case "names":
      reason = values
        ? `The draft named ${listOf(values)}. Your record doesn’t mention ${values.length === 1 ? "it" : "them"}.`
        : "The draft named something your record doesn’t mention.";
      break;
    case "scope":
      reason = `The draft said you ${LEVEL_CLAIM[finding.claimed] ?? "led it"}, which is more than your record shows.`;
      break;
    case "citation":
      reason = "The draft leaned on a fact it couldn’t use for this line.";
      break;
    default:
      reason = "The check found wording your record doesn’t back.";
  }
  if (status === "repaired") return `${reason} Resumatic rewrote the line to match.`;
  if (status === "replaced") return `${reason} This line uses your fact’s own words instead.`;
  return reason;
}

/**
 * Typographic quotation marks for text that arrives with straight ones, such as a server message:
 * it’s, not it's, and “file.pdf”, not "file.pdf". The interface’s own copy is written this way already.
 */
export function typeset(text: string): string {
  return text
    .replace(/(?<=\p{L})'(?=\p{L})/gu, "’")
    .replace(/(?<=\p{L})'(?=\s|$|[.,;:!?)])/gu, "’")
    .replace(/(^|[\s(])"(?=\S)/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s(“])'(?=\S)/g, "$1‘")
    .replace(/'/g, "’");
}
