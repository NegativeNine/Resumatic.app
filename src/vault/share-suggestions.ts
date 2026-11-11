import type { ResumeBody } from "../shared/api";
import { presentResumeBullet } from "../shared/resume-presentation";
import type { CoachSuggestionState, OwnerSuggestionState } from "../shared/sharing";

// Suggested wording on a shared copy. A suggestion is a coach's row in the comments' table, on a
// line, with a state: its body is the wording and its quote the copy's line. Nothing reads it but
// the comments' store and the Vault methods that answer for it, so it is never a fact, evidence,
// an index entry or part of a prompt. Its owner accepting it starts their own verified line edit
// with exactly that wording, and the outcome is read from that check each time: nothing settles a
// suggestion from inside the checked path.
//
// What its coach is told depends only on the copy and on what its owner did with it: never on the
// owner's resume as it is now.

export const SHARE_SUGGESTION_MIGRATIONS: readonly string[] = [
  // Null for a comment. 'open' until its owner declines it; accepting is read from the check.
  `ALTER TABLE share_comments ADD COLUMN suggestion_state TEXT CHECK (suggestion_state IS NULL OR suggestion_state IN ('open', 'declined'))`,
  // The latest check an acceptance started: a document's ID, which is its run's. No foreign key or
  // index, so the row outlives the document and both columns stay droppable.
  `ALTER TABLE share_comments ADD COLUMN document_id TEXT`,
];

/** The check an acceptance started, as its document and run stand now. `nextStep` is null without a run row. */
export interface BoundCheck {
  state: string;
  error: string | null;
  nextStep: number | null;
}

/** A document run's steps are plan, write and verify. A refusal is a verdict only while verify is the step under way. */
const VERIFY_STEP = 2;

/**
 * True when the check itself refused the wording: the run failed as `invalid` with plan and write
 * committed and verify not. Any other failure (a changed resume or fact, the budget, a cancel, a
 * move, a missing run row, or `invalid` before the verify step) is no verdict.
 */
export function isVerdict(check: BoundCheck | null): boolean {
  return check !== null && check.state === "failed" && check.error === "invalid" && check.nextStep === VERIFY_STEP;
}

interface Suggested {
  suggestion_state: string | null;
  quote: string;
}

/**
 * Where a suggestion stands for its owner, the first that holds: declined; its check running;
 * applied; refused by the check; the line no longer the one in the copy; otherwise waiting.
 * `lineNow` is the line as a copy would show it now, or null when the resume holds no single line
 * with that ID.
 */
export function ownerStanding(row: Suggested, check: BoundCheck | null, lineNow: string | null): OwnerSuggestionState {
  if (row.suggestion_state === "declined") return "declined";
  if (check?.state === "running") return "checking";
  if (check?.state === "ready") return "applied";
  if (isVerdict(check)) return "not_applied";
  if (lineNow !== row.quote) return "stale";
  return "waiting";
}

/** What its coach is told. It takes no line: the owner's resume as it is now is none of the coach's business. */
export function coachStanding(row: Suggested, check: BoundCheck | null): CoachSuggestionState {
  if (row.suggestion_state === "declined" || isVerdict(check)) return "not_used";
  if (check?.state === "ready") return "used";
  return "waiting";
}

/**
 * The words of one line of a resume as a copy shows them: the summary as it is, a line under a
 * role without a list marker it was imported with (as `targetText` reads a copy). Null when the
 * body doesn't hold exactly one line with this ID.
 */
export function lineAsShown(body: ResumeBody | null | undefined, lineId: string): string | null {
  if (!body || typeof body !== "object" || !Array.isArray(body.sections)) return null;
  const found: string[] = [];
  if (body.summary?.id === lineId && typeof body.summary.text === "string") found.push(body.summary.text);
  for (const section of body.sections)
    for (const line of Array.isArray(section?.lines) ? section.lines : [])
      if (line?.id === lineId && typeof line.text === "string") found.push(presentResumeBullet(line.text));
  return found.length === 1 ? found[0]! : null;
}

/** The check bound to a suggestion, or null when there is none or its document is gone. */
export function boundCheck(sql: SqlStorage, documentId: string | null | undefined): BoundCheck | null {
  if (!documentId) return null;
  const row = sql
    .exec<{ state: string; error: string | null; next_step: number | null }>(
      `SELECT d.state, d.error, r.next_step FROM documents d LEFT JOIN runs r ON r.id = d.id WHERE d.id = ?`,
      documentId,
    )
    .toArray()[0];
  return row ? { state: row.state, error: row.error, nextStep: row.next_step } : null;
}

/** The line as a copy would show it, from the owner's current resume, or null when there is no such line or the resume isn't ready. */
export function currentLine(sql: SqlStorage, resumeId: string | null, lineId: string): string | null {
  if (!resumeId) return null;
  const row = sql.exec<{ state: string; body: string | null }>(`SELECT state, body FROM resumes WHERE id = ?`, resumeId).toArray()[0];
  if (!row || row.state !== "ready" || !row.body) return null;
  try {
    return lineAsShown(JSON.parse(row.body) as ResumeBody, lineId);
  } catch {
    return null;
  }
}

/** The version an accepted check made, from the request it began with. Unknown once a vault has moved without its requests. */
export function appliedVersion(sql: SqlStorage, documentId: string): number | undefined {
  const row = sql.exec<{ options: string }>(`SELECT options FROM document_requests WHERE run_id = ?`, documentId).toArray()[0];
  if (!row) return undefined;
  try {
    const expected = (JSON.parse(row.options) as { expectedVersion?: unknown }).expectedVersion;
    return typeof expected === "number" && Number.isSafeInteger(expected) ? expected + 1 : undefined;
  } catch {
    return undefined;
  }
}
