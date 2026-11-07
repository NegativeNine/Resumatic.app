import { composeBody } from "../pipeline/tailor";
import { AppError } from "../shared/errors";
import type { ResumeBody, ResumeReport } from "../shared/api";
import type { FactRecord, RoleRecord, Selection, VerifiedDraft } from "../shared/types";

/** Compare JSON content without depending on RPC object property order. */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

/** Each run step can persist only the checkpoint it is responsible for. */
export function validateTailorCheckpoint(step: string, patch: unknown): void {
  const fields: Record<string, string[]> = {
    analyze: [], select: ["selection"], write: ["draft"], verify: ["verified"],
    finish: ["state", "body", "report"],
  };
  const expected = Object.hasOwn(fields, step) ? fields[step] : undefined;
  const conflict = () => new AppError("conflict", "resume output does not match its verified checkpoint");
  if (!expected || !patch || typeof patch !== "object" || Array.isArray(patch)) throw conflict();
  const values = patch as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(values, key) || values[key] == null) ||
      keys.some((key) => !expected.includes(key)) || (step === "finish" && values.state !== "ready")) throw conflict();
}

/** A finish checkpoint can publish only the exact saved verification and inputs. */
export function validateTailorPublication(
  body: ResumeBody | undefined,
  report: ResumeReport | undefined,
  verifiedJson: string | null,
  selectionJson: string | null,
  roles: RoleRecord[],
  facts: FactRecord[],
): { body: ResumeBody; report: ResumeReport } {
  const conflict = () => new AppError("conflict", "resume output does not match its verified checkpoint");
  if (!body || !report || !verifiedJson || !selectionJson) throw conflict();
  try {
    const verified = JSON.parse(verifiedJson) as VerifiedDraft;
    const selection = JSON.parse(selectionJson) as Selection;
    if (!verified || !Array.isArray(verified.lines) || !verified.report || !selection ||
        !Array.isArray(selection.factIds) || !Array.isArray(selection.skillIds) || !Array.isArray(selection.gaps)) throw conflict();
    const expected = composeBody(verified, roles, facts, selection);
    if (canonicalJson(body) !== canonicalJson(expected) || canonicalJson(report) !== canonicalJson(verified.report))
      throw conflict();
    return { body: expected, report: verified.report };
  } catch {
    throw conflict();
  }
}
