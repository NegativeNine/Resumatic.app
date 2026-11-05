import type { FactView, ReviewState, RoleView, SourceView } from "../shared/api";
import { api } from "./api";

export interface Vault {
  sources: SourceView[];
  roles: RoleView[];
  facts: FactView[];
}

export async function loadVault(): Promise<Vault> {
  const [{ sources }, { roles }, { facts }] = await Promise.all([api.sources(), api.roles(), api.facts()]);
  return { sources, roles, facts };
}

export const isReading = (vault: Vault) => vault.sources.some((s) => s.state === "queued");

/** IDs of the roles and facts from one source that are still waiting for review. */
export function proposedFrom(vault: Vault, sourceId: string): string[] {
  return [...vault.roles, ...vault.facts]
    .filter((item) => item.sourceId === sourceId && item.state === "proposed")
    .map((item) => item.id);
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
