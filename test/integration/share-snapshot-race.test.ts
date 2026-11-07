import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

it.each(["edit", "reject"] as const)("does not commit stale role data when a share races a role %s", async (operation) => {
  const stub = vault(env, env.VAULT.newUniqueId().toString());
  const who = { userId: crypto.randomUUID(), gen: 1 };
  await stub.init(who.userId);
  await runInDurableObject(stub, async (instance, state) => {
    const { roleId } = await instance.addRole(who, { kind: "job", org: "Original employer", title: "Engineer", startDate: null, endDate: null });
    const factId = crypto.randomUUID();
    state.storage.sql.exec(
      `INSERT INTO facts(id,role_id,kind,text,level,origin,state,updated_at) VALUES (?,?, 'accomplishment', 'Built the API',NULL,'user','confirmed',?)`,
      factId, roleId, Date.now(),
    );
    const creating = instance.createShare(who, { factIds: [factId], resumes: [] });
    // Let a share's first resolved async read advance. A committed grant is
    // the linearization point: subsequent role changes cannot alter it.
    await Promise.resolve();
    const committed = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM share_grants`).one().n;
    if (operation === "edit") await instance.editRole(who, roleId, { org: "Corrected employer" });
    else await instance.review(who, { confirm: [], reject: [roleId] });
    if (committed === 0 && operation === "reject") {
      await expect(creating).rejects.toThrow();
      expect(state.storage.sql.exec(`SELECT id FROM share_grants`).toArray()).toHaveLength(0);
      return;
    }
    const grant = await creating;
    const snapshot = await instance.readShare({ grantId: grant.id, epoch: grant.epoch });
    expect(snapshot.snapshot.facts[0]?.role?.org).toBe(committed ? "Original employer" : "Corrected employer");
  });
});

it("refuses a selected fact if its role was already rejected", async () => {
  const stub = vault(env, env.VAULT.newUniqueId().toString());
  const who = { userId: crypto.randomUUID(), gen: 1 };
  await stub.init(who.userId);
  await runInDurableObject(stub, async (instance, state) => {
    const { roleId } = await instance.addRole(who, { kind: "job", org: "Employer", title: null, startDate: null, endDate: null });
    const factId = crypto.randomUUID();
    state.storage.sql.exec(
      `INSERT INTO facts(id,role_id,kind,text,level,origin,state,updated_at) VALUES (?,?, 'accomplishment', 'Built the API',NULL,'user','confirmed',?)`,
      factId, roleId, Date.now(),
    );
    await instance.review(who, { confirm: [], reject: [roleId] });
    await expect(instance.createShare(who, { factIds: [factId], resumes: [] })).rejects.toThrow("confirm the selected facts' roles before sharing");
    expect(state.storage.sql.exec(`SELECT id FROM share_grants`).toArray()).toHaveLength(0);
  });
});
