import { describe, expect, it } from "vitest";
import type { FactView, ReviewState, RoleView } from "../../src/shared/api";
import { countByState, groupByRole, groupFacts, sourceReviewSummaries, type Vault } from "../../src/web/vault";

const role = (id: string, state: ReviewState): RoleView => ({
  id, state, kind: "job", org: id, title: null, startDate: null, endDate: null, quote: null, sourceId: null,
});

describe("duplicate review grouping", () => {
  it("groups matching extracted roles from different sources while preserving distinct dates and states", () => {
    const base: RoleView = { ...role("first", "proposed"), org: "Acme", title: "Engineer", startDate: "2021-01", sourceId: "s1", quote: "Acme Engineer" };
    const copy = { ...base, id: "copy", sourceId: "s2" };
    const otherDates = { ...copy, id: "later", startDate: "2023-01" };
    const otherState = { ...copy, id: "confirmed", state: "confirmed" as const };
    const noDate = { ...copy, id: "unknown", startDate: null };
    const vault: Vault = { sources: [], roles: [base, copy, otherDates, otherState, noDate], facts: [] };
    const groups = groupByRole(vault, "proposed");
    expect(groups.map((g) => [g.role?.id, g.duplicates?.map((r) => r.id)])).toEqual([
      ["first", ["copy"]], ["later", undefined], ["unknown", undefined],
    ]);
    expect(groupByRole(vault, "confirmed").map((g) => g.role?.id)).toEqual(["confirmed"]);
  });

  it("groups exact extracted facts within matching roles, retains every source, and avoids weaker matches", () => {
    const base: FactView = { ...fact("one", "r1", "proposed"), origin: "extracted", text: "• **Led** a team", quote: "• **Led** a team", sourceId: "s1", level: "led" };
    const copy: FactView = { ...base, id: "two", roleId: "r2", sourceId: "s2", text: "Led a team", quote: "Led a team" };
    const differentRole = { ...copy, id: "different-role", roleId: "r3" };
    const differentText = { ...copy, id: "different-text", text: "Led two teams" };
    const edited = { ...copy, id: "edited", origin: "user" as const };
    const otherState = { ...copy, id: "confirmed", state: "confirmed" as const };
    const grouped = groupFacts([base, copy, differentRole, differentText, edited, otherState], new Set(["r1", "r2"]));
    expect(grouped.map((items) => items.map((item) => item.id))).toEqual([
      ["one", "two"], ["different-role"], ["different-text"], ["edited"], ["confirmed"],
    ]);
    expect(grouped[0]?.map((item) => item.sourceId)).toEqual(["s1", "s2"]);
  });

  it("splits unusually large groups into atomic, bounded review requests", () => {
    const base: FactView = { ...fact("one", null, "proposed"), origin: "extracted", text: "TypeScript", kind: "skill", quote: "TypeScript", sourceId: "s1" };
    const groups = groupFacts(Array.from({ length: 401 }, (_, i) => ({ ...base, id: `${i}` })));
    expect(groups.map((g) => g.length)).toEqual([200, 200, 1]);
  });

  it("counts grouped review items while keeping each source's raw review counts", () => {
    const first: RoleView = { ...role("r1", "proposed"), org: "Acme", title: "Engineer", startDate: "2021-01", sourceId: "s1", quote: "Acme Engineer" };
    const second = { ...first, id: "r2", sourceId: "s2" };
    const one: FactView = { ...fact("f1", "r1", "proposed"), origin: "extracted", text: "• Led a team", quote: "• Led a team", sourceId: "s1" };
    const two = { ...one, id: "f2", roleId: "r2", text: "Led a team", sourceId: "s2" };
    const confirmed = { ...fact("f3", "r1", "confirmed"), sourceId: "s1" };
    const vault: Vault = { sources: [], roles: [first, second], facts: [one, two, confirmed] };
    expect(countByState(vault)).toEqual({ proposed: 2, confirmed: 1, rejected: 0 });
    expect(sourceReviewSummaries(vault).get("s1")).toMatchObject({ proposedRoles: 1, proposedFacts: 1, visibleItems: 3 });
    expect(sourceReviewSummaries(vault).get("s2")).toMatchObject({ proposedRoles: 1, proposedFacts: 1, visibleItems: 2 });
  });
});
const fact = (id: string, roleId: string | null, state: ReviewState): FactView => ({
  id, roleId, state, kind: "accomplishment", text: id, level: null, origin: "user", quote: null, sourceId: null,
});

describe("groupByRole", () => {
  it("keeps role and fact order, includes roles with matching facts, and puts orphaned facts last", () => {
    const vault: Vault = {
      sources: [],
      roles: [role("a", "confirmed"), role("b", "proposed"), role("c", "confirmed")],
      facts: [fact("loose", null, "proposed"), fact("a1", "a", "proposed"),
        fact("orphan", "missing", "proposed"), fact("ignored", "a", "confirmed"), fact("a2", "a", "proposed")],
    };
    const groups = groupByRole(vault, "proposed");
    expect(groups.map((group) => [group.role?.id ?? null, group.facts.map((item) => item.id)])).toEqual([
      ["a", ["a1", "a2"]], ["b", []], [null, ["loose", "orphan"]],
    ]);
  });

  it("groups a large review without losing facts or mixing them among roles", () => {
    const size = 5_000;
    const vault: Vault = { sources: [],
      roles: Array.from({ length: size }, (_, i) => role(`r${i}`, "confirmed")),
      facts: Array.from({ length: size }, (_, i) => fact(`f${i}`, `r${size - i - 1}`, "proposed")),
    };
    const groups = groupByRole(vault, "proposed");
    expect(groups).toHaveLength(size);
    expect(groups.every((group, i) => group.role?.id === `r${i}` &&
      group.facts.length === 1 && group.facts[0]?.id === `f${size - i - 1}`)).toBe(true);
  });
});
