import type { FactView, RoleView, SourceView } from "../shared/api";
import type { ReviewEntries } from "../shared/review-groups";
import { api } from "./api";

// The grouping lives in the shared module, so the Vault's Today counts what To check shows.
export { countByState, groupByRole, groupFacts, MAX_DUPLICATES, proposedBySource, roleKey, type Group } from "../shared/review-groups";
export { reviewQuestions, type ReviewQuestion } from "../shared/review-groups";

export interface Vault extends ReviewEntries {
  sources: SourceView[];
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

export function sourceLabel(filenames: ReadonlyMap<string, string>, sourceId: string | null): string {
  return (sourceId !== null && filenames.get(sourceId)) || "an uploaded file";
}

export function roleLabel(role: RoleView): string {
  return role.title ? `${role.org}, ${role.title}` : role.org;
}
