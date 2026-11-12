import type { FactView, ReviewState, RoleView } from "./api";
import { cleanExtractedText } from "./clean";

// How the review queue groups what it shows: the same role or fact read from two files is one
// question, kept with every copy's source. The web app's To check and the Vault's Today count with
// these same functions, so the count in the header is the number of questions the queue asks.

/** The roles and facts a review is worked out from. */
export interface ReviewEntries {
  roles: RoleView[];
  facts: FactView[];
}

export interface Group {
  /** Null for facts that belong to no known role. */
  role: RoleView | null;
  /** Equivalent records retain their own source evidence and review state. */
  duplicates?: RoleView[];
  facts: FactView[];
}

// Keep each decision inside one atomic review request, comfortably below the
// endpoint's body and ID limits even for unusually large vaults.
export const MAX_DUPLICATES = 200;

export function roleKey(role: RoleView): string | null {
  // A missing title or start date cannot safely distinguish two tenures.
  if (!role.sourceId || !role.title || !role.startDate) return null;
  return JSON.stringify([role.kind, role.org.trim(), role.title.trim(), role.startDate,
    role.endDate, role.unknownEndStartDate ?? null, role.state]);
}

export function countByState(entries: ReviewEntries): Record<ReviewState, number> {
  const counts: Record<ReviewState, number> = { proposed: 0, confirmed: 0, rejected: 0 };
  for (const state of ["proposed", "confirmed", "rejected"] as const) {
    for (const group of groupByRole(entries, state)) {
      if (group.role?.state === state) counts[state]++;
      counts[state] += groupFacts(group.facts, equivalentRoles(group)).length;
    }
  }
  return counts;
}

/**
 * What waits in To check, by the file each question is shown under: a role under its group's role,
 * a fact under the first fact of its group. Each question is counted once, so the totals over every
 * source are `countByState(entries).proposed`. The key is null for what came from no file.
 */
export function proposedBySource(entries: ReviewEntries): Map<string | null, { roles: number; facts: number }> {
  const bySource = new Map<string | null, { roles: number; facts: number }>();
  const add = (sourceId: string | null, kind: "roles" | "facts") => {
    const counts = bySource.get(sourceId) ?? { roles: 0, facts: 0 };
    counts[kind]++;
    bySource.set(sourceId, counts);
  };
  for (const group of groupByRole(entries, "proposed")) {
    if (group.role?.state === "proposed") add(group.role.sourceId, "roles");
    for (const facts of groupFacts(group.facts, equivalentRoles(group))) add(facts[0]!.sourceId, "facts");
  }
  return bySource;
}

/** A group's role and the copies of it, whose facts are grouped as one role's. */
function equivalentRoles(group: Group): ReadonlySet<string> | undefined {
  return group.role ? new Set([group.role.id, ...(group.duplicates ?? []).map((role) => role.id)]) : undefined;
}

/** Roles in the given state or holding facts in it, each with those facts; loose facts come last. */
export function groupByRole(entries: ReviewEntries, state: ReviewState): Group[] {
  const byRole = new Map<string, Group>();
  const matching = new Map<string, Group[]>();
  const groups: Group[] = [];
  for (const role of entries.roles) {
    const key = roleKey(role);
    const choices = key ? matching.get(key) : undefined;
    let group = choices?.find((item) => (item.duplicates?.length ?? 0) < MAX_DUPLICATES - 1);
    if (group) {
      (group.duplicates ??= []).push(role);
    } else {
      group = { role, facts: [] };
      groups.push(group);
      if (key) matching.set(key, [...(choices ?? []), group]);
    }
    byRole.set(role.id, group);
  }
  const loose: FactView[] = [];
  for (const fact of entries.facts) {
    if (fact.state !== state) continue;
    const group = fact.roleId === null ? undefined : byRole.get(fact.roleId);
    if (group) group.facts.push(fact);
    else loose.push(fact);
  }
  const visible = groups.filter((group) => group.role?.state === state || group.facts.length > 0);
  if (loose.length > 0) visible.push({ role: null, facts: loose });
  return visible;
}

/** Group exact extracted claims while retaining all records and citations. */
export function groupFacts(facts: FactView[], equivalentRoles: ReadonlySet<string> = new Set()): FactView[][] {
  const groups: FactView[][] = [];
  const matching = new Map<string, FactView[][]>();
  for (const fact of facts) {
    const role = fact.roleId && equivalentRoles.has(fact.roleId) ? "equivalent-role" : fact.roleId;
    const text = cleanExtractedText(fact.text);
    // A marked copy and an unmarked one are shown apart: one control would say both things at once.
    const key = fact.origin === "extracted" && fact.sourceId && fact.quote && text && !fact.levelNeedsReview
      ? JSON.stringify([role, fact.kind, text, fact.level, fact.state,
          fact.evidenceOrigin ?? "upload", fact.reviewReasons ?? [], (fact.confidence ?? 1) < 0.8, fact.sensitive === true])
      : null;
    const choices = key ? matching.get(key) : undefined;
    const group = choices?.find((items) => items.length < MAX_DUPLICATES);
    if (group) group.push(fact);
    else {
      const next = [fact];
      groups.push(next);
      if (key) matching.set(key, [...(choices ?? []), next]);
    }
  }
  return groups;
}
