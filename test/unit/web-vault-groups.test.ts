import { describe, expect, it } from "vitest";
import type { FactView, ReviewState, RoleView } from "../../src/shared/api";
import { groupByRole, type Vault } from "../../src/web/vault";

const role = (id: string, state: ReviewState): RoleView => ({
  id, state, kind: "job", org: id, title: null, startDate: null, endDate: null, quote: null, sourceId: null,
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
