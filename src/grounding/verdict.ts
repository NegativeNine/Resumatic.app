import type { FactRecord } from "../shared/types";
import {
  checkClaim,
  levelOfRank,
  rankOf,
  scopeRank,
  type CheckResult,
} from "./claims";

/** Historical upload quotes remain visible in the vault but cannot override a user's correction. */
export function authoritativeFact(fact: FactRecord): FactRecord {
  if (fact.origin !== "user") return fact;
  const explicitScope = scopeRank(fact.text);
  // Historical edits can retain a level from an earlier claim. Only an
  // explicit level selected for this revision may support scope when the
  // wording itself has no recognizable scope verb.
  const supported = explicitScope || (fact.levelExplicit === true ? rankOf(fact.level) : 0);
  return {
    ...fact,
    quote: null,
    level:
      rankOf(fact.level) > supported
        ? (supported ? levelOfRank(supported) : null)
        : fact.level,
  };
}

export interface LineToCheck {
  roleId: string | null;
  text: string;
  factIds: string[];
}

/**
 * Checks a resume line: it must cite at least one fact, every cited fact must be in the
 * selection and belong to the line's role (the summary may cite any role), and its numbers,
 * names and scope must all be supported by the cited facts and their quotes.
 */
export function checkLine(
  line: LineToCheck,
  facts: ReadonlyMap<string, FactRecord>,
  selected: ReadonlySet<string>,
): CheckResult {
  const problems: string[] = [];
  if (line.factIds.length === 0) problems.push("cites no facts");
  const cited: FactRecord[] = [];
  for (const id of line.factIds) {
    const fact = facts.get(id);
    if (!fact || !selected.has(id)) {
      problems.push("cites a fact outside the selection");
      continue;
    }
    if (line.roleId !== null && fact.roleId !== line.roleId) {
      problems.push("cites a fact not assigned to this role");
      continue;
    }
    cited.push(authoritativeFact(fact));
  }
  if (problems.length) return { ok: false, problems, findings: [{ kind: "citation" }] };
  return checkClaim(
    line.text,
    cited.map((f) => ({ text: f.text, quote: f.quote, level: f.level })),
  );
}

/** The fallback for a line that failed twice: the first cited, selected fact of its role, or nothing. */
export function fallbackFact(
  line: LineToCheck,
  facts: ReadonlyMap<string, FactRecord>,
  selected: ReadonlySet<string>,
): FactRecord | null {
  for (const id of line.factIds) {
    const fact = facts.get(id);
    if (!fact || !selected.has(id)) continue;
    if (line.roleId !== null && fact.roleId !== line.roleId)
      continue;
    return authoritativeFact(fact);
  }
  return null;
}
