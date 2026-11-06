import type { FactKind, Level, LineStatus, ResumeState, ReviewState, RoleKind } from "../shared/api";

const monthYear = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const dayUtc = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const YEAR_MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?$/;

/** "2026-11" (or "2026-11-05") as "Nov 2026". Dates in any other form are shown as written. */
export function formatMonth(value: string): string {
  const match = YEAR_MONTH.exec(value);
  return match ? monthYear.format(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)) : value;
}

/** The first day of the month after a "YYYY-MM" month, such as "1 Dec 2026". */
export function formatMonthAfter(value: string): string | null {
  const match = YEAR_MONTH.exec(value);
  return match ? dayUtc.format(Date.UTC(Number(match[1]), Number(match[2]), 1)) : null;
}

export function formatDateRange(start: string | null, end: string | null, unknownEndStart?: string | null): string {
  if (unknownEndStart) return `Start: ${formatMonth(unknownEndStart)} (end unknown)`;
  if (!start) return end ? formatMonth(end) : "";
  return `${formatMonth(start)} – ${end ? formatMonth(end) : "present"}`;
}

// Timestamps are expected in milliseconds; values small enough to be seconds are scaled.
const toMillis = (time: number) => (time < 1e12 ? time * 1000 : time);
export const formatDate = (time: number) => day.format(toMillis(time));
export const formatDateTime = (time: number) => dayAndTime.format(toMillis(time));

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

export const STATE_LABEL: Record<ReviewState, string> = {
  proposed: "Proposed",
  confirmed: "Confirmed",
  rejected: "Rejected",
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
  accomplishment: "Accomplishment",
  skill: "Skill",
  credential: "Credential",
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
  kept: "Kept",
  repaired: "Repaired",
  replaced: "Replaced",
  edited: "Edited",
};

export const LINE_STATUS_HINT: Record<LineStatus, string> = {
  kept: "Passed every check as written",
  repaired: "Fixed once so that it matches its facts",
  replaced: "Swapped for the wording of a fact it cites",
  edited: "Changed by you",
};
