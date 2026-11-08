import type { FactKind, Level, LineStatus, ResumeState, ReviewState, RoleKind } from "../shared/api";

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
  replaced: "Used your fact",
  edited: "Edited",
};

export const LINE_STATUS_HINT: Record<LineStatus, string> = {
  kept: "Passed every check as written",
  repaired: "Fixed once so that it matches its facts",
  replaced: "The draft wording could not be verified, so this line uses the wording of a confirmed fact",
  edited: "Changed by you",
};
