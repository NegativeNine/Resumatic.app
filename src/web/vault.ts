import type { FactView, ReviewState, RoleView, SourceView } from "../shared/api";
import { cleanExtractedText } from "../shared/clean";
import { api } from "./api";

export interface Vault {
  sources: SourceView[];
  roles: RoleView[];
  facts: FactView[];
}

export async function loadVault(): Promise<Vault> {
  return api.reviewView();
}

export const isReading = (vault: Vault) => vault.sources.some((s) => s.state === "queued");

export interface SourceReviewSummary {
  proposedIds: string[];
  proposedRoles: number;
  proposedFacts: number;
  visibleItems: number;
}

/** Summarize the roles and facts currently displayed, without rescanning them per source. */
export function sourceReviewSummaries(vault: Vault): Map<string, SourceReviewSummary> {
  const summaries = new Map<string, SourceReviewSummary>();
  const add = (item: RoleView | FactView, kind: "role" | "fact") => {
    if (!item.sourceId) return;
    const summary: SourceReviewSummary = summaries.get(item.sourceId) ?? {
      proposedIds: [], proposedRoles: 0, proposedFacts: 0, visibleItems: 0,
    };
    summary.visibleItems++;
    if (item.state === "proposed") {
      summary.proposedIds.push(item.id);
      if (kind === "role") summary.proposedRoles++;
      else summary.proposedFacts++;
    }
    summaries.set(item.sourceId, summary);
  };
  for (const role of vault.roles) add(role, "role");
  for (const fact of vault.facts) add(fact, "fact");
  return summaries;
}

export function countByState(vault: Vault): Record<ReviewState, number> {
  const counts: Record<ReviewState, number> = { proposed: 0, confirmed: 0, rejected: 0 };
  for (const state of ["proposed", "confirmed", "rejected"] as const) {
    for (const group of groupByRole(vault, state)) {
      if (group.role?.state === state) counts[state]++;
      const roles = group.role ? new Set([group.role.id, ...(group.duplicates ?? []).map((role) => role.id)]) : undefined;
      counts[state] += groupFacts(group.facts, roles).length;
    }
  }
  return counts;
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
const MAX_DUPLICATES = 200;

function roleKey(role: RoleView): string | null {
  // A missing title or start date cannot safely distinguish two tenures.
  if (!role.sourceId || !role.title || !role.startDate) return null;
  return JSON.stringify([role.kind, role.org.trim(), role.title.trim(), role.startDate,
    role.endDate, role.unknownEndStartDate ?? null, role.state]);
}

/** Roles in the given state or holding facts in it, each with those facts; loose facts come last. */
export function groupByRole(vault: Vault, state: ReviewState): Group[] {
  const byRole = new Map<string, Group>();
  const matching = new Map<string, Group[]>();
  const groups: Group[] = [];
  for (const role of vault.roles) {
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
  for (const fact of vault.facts) {
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
    const key = fact.origin === "extracted" && fact.sourceId && fact.quote && text && !fact.levelNeedsReview
      ? JSON.stringify([role, fact.kind, text, fact.level, fact.state,
          fact.evidenceOrigin ?? "upload", fact.reviewReasons ?? [], (fact.confidence ?? 1) < 0.8])
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

export function sourceLabel(filenames: ReadonlyMap<string, string>, sourceId: string | null): string {
  return (sourceId !== null && filenames.get(sourceId)) || "an uploaded file";
}

export function roleLabel(role: RoleView): string {
  return role.title ? `${role.org}, ${role.title}` : role.org;
}
