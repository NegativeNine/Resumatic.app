import { expect, it } from "vitest";
import type { ResumeBody } from "../../src/shared/api";
import { SnapshotStore } from "../../src/vault/snapshots";

function cursor<T>(rows: T[]) {
  return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
}

it.each(["fact", "role"] as const)("propagates a database error while checking a candidate's %s", (failure) => {
  const fact = { id: "fact", revision: 1, roleId: "role", kind: "skill", text: "Go", origin: "user", level: null, quote: null, levelExplicit: false };
  const role = { id: "role", revision: 1, kind: "job", org: "Example", title: null, startDate: null, endDate: null };
  const sql = {
    exec(query: string) {
      if (query.includes("entity_incarnation_guard")) return cursor([]);
      if (query.includes("FROM entity_incarnations")) return cursor([{ value: 1 }]);
      if (query.includes("generation_input_items") && query.includes("kind = 'fact'")) return cursor([{ item_id: fact.id, data: JSON.stringify(fact), incarnation: 1 }]);
      if (query.includes("generation_input_items") && query.includes("kind = 'role'")) return cursor([{ item_id: role.id, data: JSON.stringify(role), incarnation: 1 }]);
      // No fact is marked sensitive, so nothing the run captured is withheld.
      if (query.includes("f.sensitive = 1")) return cursor([]);
      if (query.includes("FROM facts f LEFT JOIN evidence")) {
        if (failure === "fact") throw new Error("fact database unavailable");
        return cursor([{ id: fact.id, revision: 1, state: "confirmed", role_id: "role", kind: "skill", text: "Go", origin: "user", level: null, level_revision: null, quote: null }]);
      }
      if (query.includes("FROM roles WHERE")) throw new Error("role database unavailable");
      throw new Error("unexpected query");
    },
  } as unknown as SqlStorage;
  const body: ResumeBody = { summary: null, sections: [], skills: ["Go"] };
  expect(() => new SnapshotStore(sql).assertCurrent("run", body)).toThrow(`${failure} database unavailable`);
});
