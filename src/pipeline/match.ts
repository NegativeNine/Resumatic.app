import { roleKey, wording, type RoleIdentity } from "../shared/record";

// Finding what an upload says again (step 6 of docs/taxonomy-pipelines-design.md, first part).
//
// Every upload proposes all of its roles and facts afresh, so a second resume brings a second copy
// of each job and each line. This finds the copies that are word for word the same. It uses no
// model and decides nothing by likeness: two roles match only when every field that names a role
// is the same, and two facts only when they are of one kind, in roles that match, with the same
// wording. Those are the two findings the record itself will confirm without the owner
// (src/vault/record.ts), and both sides use the same definitions, from src/shared/record.ts.
//
// Anything less than identical is not looked for here. Offering two different wordings as the
// same fact needs the judge, and is a later change.

/** The rules that made a match, stamped on it. Raise the number when what counts as identical changes. */
export const IDENTICAL_ROLE_METHOD = "identical-role/1";
export const IDENTICAL_WORDING_METHOD = "identical-wording/1";

export interface MatchRole extends RoleIdentity {
  id: string;
}

export interface MatchFact {
  id: string;
  roleId: string | null;
  kind: string;
  text: string;
}

/** `from` says again what `to` already said. `to` is always the earliest row that says it. */
export interface IdenticalMatch {
  kind: "role" | "fact";
  from: string;
  to: string;
}

/**
 * Every role and fact that repeats an earlier one word for word. Rows are given oldest first, and
 * each later copy is matched to the earliest, so any number of copies point at one row and no
 * row points at more than one.
 */
export function identicalMatches(roles: readonly MatchRole[], facts: readonly MatchFact[]): IdenticalMatch[] {
  const matches: IdenticalMatch[] = [];
  /** The earliest role with each identity, and for every role the role that stands for it. */
  const firstRole = new Map<string, string>();
  const stands = new Map<string, string>();
  for (const role of roles) {
    const key = roleKey(role);
    const first = key === null ? undefined : firstRole.get(key);
    if (first === undefined) {
      if (key !== null) firstRole.set(key, role.id);
      stands.set(role.id, role.id);
    } else {
      matches.push({ kind: "role", from: role.id, to: first });
      stands.set(role.id, first);
    }
  }
  const firstFact = new Map<string, string>();
  for (const fact of facts) {
    // An accomplishment read without a job has no role that was found to be the same one. A skill
    // or a credential is the same item wherever it is listed.
    if (fact.roleId === null && fact.kind === "accomplishment") continue;
    const words = wording(fact.text);
    if (!words) continue;
    const key = JSON.stringify([fact.roleId === null ? null : (stands.get(fact.roleId) ?? fact.roleId), fact.kind, words]);
    const first = firstFact.get(key);
    if (first === undefined) firstFact.set(key, fact.id);
    else matches.push({ kind: "fact", from: fact.id, to: first });
  }
  return matches;
}
