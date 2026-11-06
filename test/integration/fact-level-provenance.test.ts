import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { checkLine } from "../../src/grounding/verdict";
import { MIGRATIONS, migrate } from "../../src/vault/schema";
import { vault } from "../../src/shared/stubs";
import type { FactRecord } from "../../src/shared/types";
import { fakeModels, signIn, type User } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

function vaultId(user: User): string {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).vid;
}

async function confirmedFact(user: User, id: string): Promise<FactRecord> {
  return runInDurableObject(vault(env, vaultId(user)), (instance) => {
    const facts = (instance as unknown as { usableFacts(): FactRecord[] }).usableFacts();
    return facts.find((fact) => fact.id === id)!;
  });
}

function canClaimLed(fact: FactRecord): boolean {
  return checkLine({ roleId: null, text: "Led the migration project", factIds: [fact.id] }, new Map([[fact.id, fact]]), new Set([fact.id])).ok;
}

describe("fact level provenance", () => {
  it("invalidates a previous level on wording changes and lets the owner reaffirm it", async () => {
    const user = await signIn();
    const added = await user.send("POST", "/api/facts", { roleId: null, kind: "accomplishment", text: "Migration project member", level: "led" });
    expect(added.status).toBe(201);
    const { factId } = await added.json() as { factId: string };
    expect(canClaimLed(await confirmedFact(user, factId))).toBe(true);
    const role = await user.send("POST", "/api/roles", { kind: "job", org: "Example", title: "Engineer", startDate: "2020", endDate: null });
    expect(role.status).toBe(201);
    const { roleId } = await role.json() as { roleId: string };
    expect((await user.send("PATCH", `/api/facts/${factId}`, { roleId })).status).toBe(204);
    expect((await user.json("/api/facts")).facts.find((item: { id: string }) => item.id === factId).level).toBe("led");

    expect((await user.send("PATCH", `/api/facts/${factId}`, { text: "Migration project participant" })).status).toBe(204);
    let fact = (await user.json("/api/facts")).facts.find((item: { id: string }) => item.id === factId);
    expect(fact).toMatchObject({ level: null, levelNeedsReview: true, previousLevel: "led" });
    expect(canClaimLed(await confirmedFact(user, factId))).toBe(false);

    expect((await user.send("PATCH", `/api/facts/${factId}`, { level: "led", expectedRevision: fact.revision })).status).toBe(204);
    fact = (await user.json("/api/facts")).facts.find((item: { id: string }) => item.id === factId);
    expect(fact.level).toBe("led");
    expect(fact.levelNeedsReview).toBeUndefined();
    expect(canClaimLed(await confirmedFact(user, factId))).toBe(true);
    expect((await user.send("POST", "/api/review", { reject: [factId], confirm: [] })).status).toBe(204);
    expect((await user.send("POST", "/api/review", { reject: [], confirm: [factId] })).status).toBe(204);
    expect((await user.json("/api/facts")).facts.find((item: { id: string }) => item.id === factId).level).toBe("led");
  });

  it("keeps historic data while requiring ambiguous older user levels to be reaffirmed", async () => {
    const owner = "historic-level-owner";
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init(owner);
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`DROP TABLE application_create_requests`);
      sql.exec(`DROP TABLE role_create_requests`);
      sql.exec(`DROP TABLE fact_create_requests`);
      sql.exec(`DROP TABLE r2_cache_dispatches`);
      sql.exec(`ALTER TABLE facts DROP COLUMN level_revision`);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("ALTER TABLE facts ADD COLUMN level_revision")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      sql.exec(`INSERT INTO facts (id,role_id,kind,text,level,origin,state,revision,updated_at) VALUES ('new-user',NULL,'accomplishment','Migration member','led','user','confirmed',1,1), ('edited-user',NULL,'accomplishment','Migration participant','led','user','confirmed',2,2)`);
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ level: string; level_revision: number | null }>(`SELECT level, level_revision FROM facts WHERE id='edited-user'`).one()).toEqual({ level: "led", level_revision: null });
      const views = await instance.listFacts({ userId: owner, gen: 1 });
      expect(views.find((fact) => fact.id === "new-user")).toMatchObject({ level: null, levelNeedsReview: true, previousLevel: "led" });
      expect(views.find((fact) => fact.id === "edited-user")).toMatchObject({ level: null, levelNeedsReview: true, previousLevel: "led" });
    });
  });

  it("does not trust revision 1 when migrating a fact from the original schema", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      for (const statement of MIGRATIONS[0]!) sql.exec(statement);
      sql.exec(`INSERT INTO meta (key,value) VALUES ('schema_version','1')`);
      // In schema v1 this could be an already-edited user claim. The later
      // revision migration gives it 1, which is not proof of an explicit level.
      sql.exec(`INSERT INTO facts (id,role_id,kind,text,level,origin,state,updated_at) VALUES ('old',NULL,'accomplishment','Migration participant','led','user','confirmed',1)`);
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ revision: number; level: string; level_revision: number | null }>(`SELECT revision,level,level_revision FROM facts WHERE id='old'`).one())
        .toEqual({ revision: 1, level: "led", level_revision: null });
    });
  });
});
