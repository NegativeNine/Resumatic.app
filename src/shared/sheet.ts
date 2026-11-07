import type { Profile, ResumeBody, ResumeLine, ResumeSection } from "./api";
import { presentResumeBullet } from "./resume-presentation";

// The resume sheet as data: what the PDF prints and the in-app preview shows, in the same order
// and with the same words. src/render/template.ts and src/web/components/ResumePaper.tsx both
// render this model, so the two can't drift apart.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2021-03" becomes "Mar 2021"; other values print as given. */
export function formatSheetDate(value: string | null): string {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})/.exec(value);
  if (m) return `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`.trim();
  return value;
}

/** "Mar 2021 – Present", "Jun 2018 – Feb 2021", or "Start: 2020 (end unknown)". */
export function formatRoleDates(startDate: string | null, endDate: string | null, unknownEndStartDate?: string | null): string {
  if (unknownEndStartDate) return `Start: ${formatSheetDate(unknownEndStartDate)} (end unknown)`;
  const start = formatSheetDate(startDate);
  const end = endDate ? formatSheetDate(endDate) : start ? "Present" : "";
  return [start, end].filter(Boolean).join(" – ");
}

export interface SheetLine {
  /** The line as stored, for its note and its evidence. */
  line: ResumeLine;
  /** The words that print. */
  text: string;
}

export interface SheetRole {
  /** The section's position in ResumeBody.sections. */
  index: number;
  section: ResumeSection;
  /** "Title, Organization", as the PDF prints it. */
  heading: string;
  dates: string;
  lines: SheetLine[];
}

export interface SheetModel {
  name: string;
  /** Email, phone, location and links, in that order. They print joined with " · ". */
  contact: string[];
  /** The summary prints with no heading of its own. */
  summary: SheetLine | null;
  sections: { heading: "Experience" | "Education"; roles: SheetRole[] }[];
  skills: string[];
}

function role(section: ResumeSection, index: number): SheetRole {
  return {
    index,
    section,
    heading: [section.title, section.org].filter(Boolean).join(", "),
    dates: formatRoleDates(section.startDate, section.endDate, section.unknownEndStartDate),
    lines: section.lines.map((line) => ({ line, text: presentResumeBullet(line.text) })),
  };
}

/**
 * The sheet for a resume body and a profile. Experience holds every role that isn't education
 * (jobs, projects and volunteering, as the ATS-safe template prints them), then Education.
 */
export function sheetModel(profile: Profile, body: ResumeBody): SheetModel {
  const roles = body.sections.map(role);
  const experience = roles.filter((r) => r.section.kind !== "education");
  const education = roles.filter((r) => r.section.kind === "education");
  return {
    name: profile.name,
    contact: [profile.email, profile.phone, profile.location, ...profile.links].filter(Boolean),
    summary: body.summary ? { line: body.summary, text: body.summary.text } : null,
    sections: [
      ...(experience.length ? [{ heading: "Experience" as const, roles: experience }] : []),
      ...(education.length ? [{ heading: "Education" as const, roles: education }] : []),
    ],
    skills: body.skills,
  };
}

/** Every line on the sheet, top to bottom. */
export function sheetLines(model: SheetModel): SheetLine[] {
  return [...(model.summary ? [model.summary] : []), ...model.sections.flatMap((s) => s.roles.flatMap((r) => r.lines))];
}
