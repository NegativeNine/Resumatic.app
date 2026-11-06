import type { FactView, ReviewState, RoleView, SourceView } from "../shared/api";
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
  for (const item of [...vault.roles, ...vault.facts]) counts[item.state]++;
  return counts;
}

export interface Group {
  /** Null for facts that belong to no known role. */
  role: RoleView | null;
  facts: FactView[];
}

/** Roles in the given state or holding facts in it, each with those facts; loose facts come last. */
export function groupByRole(vault: Vault, state: ReviewState): Group[] {
  const facts = vault.facts.filter((f) => f.state === state);
  const roleIds = new Set(vault.roles.map((r) => r.id));
  const groups: Group[] = vault.roles
    .map((role) => ({ role, facts: facts.filter((f) => f.roleId === role.id) }))
    .filter((group) => group.role.state === state || group.facts.length > 0);
  const loose = facts.filter((f) => f.roleId === null || !roleIds.has(f.roleId));
  if (loose.length > 0) groups.push({ role: null, facts: loose });
  return groups;
}

export function sourceLabel(filenames: ReadonlyMap<string, string>, sourceId: string | null): string {
  return (sourceId !== null && filenames.get(sourceId)) || "an uploaded file";
}

export function roleLabel(role: RoleView): string {
  return role.title ? `${role.org}, ${role.title}` : role.org;
}
