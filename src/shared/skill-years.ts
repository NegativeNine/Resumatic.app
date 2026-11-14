/** Owner-confirmed use of one exact skill. Role dates never enter this calculation. */
export const SKILL_YEARS_OFF = "Skill periods are not enabled.";
export const SKILL_YEARS_CHANGED = "These skill periods changed. Refresh the page, then try again.";
export const MAX_SKILL_INTERVALS = 128;
export const MAX_SELECTED_SKILL_CLAIMS = 12;
export const SKILL_YEARS_METHOD = "owner-periods/1";
export type SkillSubjectRef = { kind: "fact" | "tag"; id: string };
export interface SkillSubject {
  ref: SkillSubjectRef;
  key: string;
  label: string;
  /** Captures the exact confirmed fact/tag/role revision; not the role's dates. */
  anchor: string;
  private: boolean;
}
export interface SkillIntervalInput { subject: SkillSubjectRef; start: string; end: string | null; ongoing: boolean; private: boolean }
export interface SkillInterval extends Omit<SkillIntervalInput, "subject"> {
  id: string; subject: SkillSubject; revision: number; state: "confirmed" | "withdrawn"; createdAt: number;
}
export interface SkillDurationBounds { lowerMonths: number; upperMonths: number; precision: "year" | "month" }
export interface SkillDurationClaim {
  id: string; factId: string; skillKey: string; label: string; text: string; asOf: string;
  bounds: SkillDurationBounds; inputHash: string; confirmedAt: number; current: boolean; private: boolean;
}
export interface SkillDurationProof {
  claimId: string; inputHash: string; method: typeof SKILL_YEARS_METHOD; text: string; asOf: string;
}
export function validSkillDurationProof(value: unknown, text: string): value is SkillDurationProof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<SkillDurationProof>;
  return typeof proof.claimId === "string" && proof.claimId.length > 0 && proof.claimId.length <= 100 &&
    typeof proof.inputHash === "string" && /^[a-f0-9]{64}$/.test(proof.inputHash) &&
    proof.method === SKILL_YEARS_METHOD && proof.text === text && typeof proof.asOf === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(proof.asOf);
}
export interface SkillDurationPreview { asOf: string; bounds: SkillDurationBounds; text: string; inputHash: string; private: boolean }
export interface SkillYearsView {
  subjects: SkillSubject[]; intervals: SkillInterval[]; claims: SkillDurationClaim[];
  asOf: string;
}

const DATE = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/;
export function utcMonth(now = Date.now()): string { return new Date(now).toISOString().slice(0, 7); }
/** First and last possible month of an endpoint, with the source precision retained. */
function edges(value: string): [number, number] | null {
  if (typeof value !== "string") return null;
  const found = DATE.exec(value);
  if (!found || Number(found[1]) < 1900) return null;
  const first = Number(found[1]) * 12;
  return found[2] ? [first + Number(found[2]) - 1, first + Number(found[2]) - 1] : [first, first + 11];
}
export function intervalProblem(input: SkillIntervalInput, asOf: string): string | null {
  const start = edges(input.start), end = input.end === null ? null : edges(input.end), at = edges(asOf);
  if (!input.subject || !["fact", "tag"].includes(input.subject.kind) || typeof input.subject.id !== "string" || !input.subject.id || input.subject.id.length > 200)
    return "Choose a confirmed skill or concept.";
  if (!start || !at || asOf.length !== 7 || (input.end !== null && !end)) return "Use a year or a year and month for each date.";
  if (input.ongoing !== (input.end === null)) return "Choose an end date or explicitly say you still use this skill.";
  if (start[0] > at[0] || (end && end[0] > at[0])) return "Skill periods cannot begin or end in the future.";
  if (end && end[1] < start[0]) return "The end must not be before the start.";
  return null;
}
function union(parts: [number, number][]): number {
  let end = -Infinity, total = 0;
  for (const [from, to] of parts.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const start = Math.max(end, from);
    if (to > start) total += to - start;
    end = Math.max(end, to);
  }
  return total;
}
/**
 * Endpoints identify a month/year, not an exact day. Inner intervals count only guaranteed
 * complete months; outer intervals bound all possible use. Neither uncertainty nor overlapping
 * uploads creates extra years. Ongoing periods stop before the current incomplete UTC month.
 */
export function skillDurationBounds(intervals: Pick<SkillInterval, "start" | "end" | "ongoing">[], asOf: string): SkillDurationBounds | null {
  if (!intervals.length) return null;
  const at = edges(asOf); if (!at || asOf.length !== 7) return null;
  const inner: [number, number][] = [], outer: [number, number][] = [];
  let precision: "year" | "month" = "month";
  for (const period of intervals) {
    const start = edges(period.start), end = period.end === null ? null : edges(period.end);
    if (!start || (period.end !== null && !end) || period.ongoing !== (period.end === null) || start[0] > at[0] || (end && (end[0] > at[0] || end[1] < start[0]))) return null;
    if (period.start.length === 4 || period.end?.length === 4) precision = "year";
    inner.push([start[1] + 1, end ? Math.min(end[0], at[0]) : at[0]]);
    outer.push([start[0], end ? Math.min(end[1] + 1, at[0]) : at[0]]);
  }
  return { lowerMonths: union(inner), upperMonths: union(outer), precision };
}
/** Only the supported lower bound is an outward claim; zero/unknown never becomes zero years. */
export function skillDurationText(label: string, bounds: SkillDurationBounds, asOf: string): string | null {
  const amount = bounds.precision === "year" ? Math.floor(bounds.lowerMonths / 12) : bounds.lowerMonths;
  if (amount < 1) return null;
  const unit = bounds.precision === "year" ? "year" : "month";
  return `${label} — at least ${amount} ${unit}${amount === 1 ? "" : "s"} of use, confirmed as of ${asOf}`;
}
export function validSkillLabel(text: string): boolean {
  return typeof text === "string" && text.trim() === text && text.length > 0 && text.length <= 200 && !/[\r\n\u0000-\u001f\u007f]/.test(text);
}
