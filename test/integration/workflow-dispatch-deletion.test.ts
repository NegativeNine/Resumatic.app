import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { directory, vault } from "../../src/shared/stubs";
import { MIGRATIONS } from "../../src/vault/schema";
import { uniqueEmail } from "./support";

describe("deletion and Workflow dispatch", () => {
  it("waits for an acknowledged in-flight create and prevents new dispatches after close", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "dispatch-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DISTILL;
      let release!: () => void;
      let started!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      let calls = 0;
      local.DISTILL = { create: async () => { calls++; started(); await held; return {}; } } as unknown as Workflow;
      const add = instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${id}/sources/file` });
      try {
        await entered;
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(1);
        const runId = state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM workflow_dispatches`).one().run_id;
        const internal = instance as unknown as { runs: { get(id: string): Record<string, unknown> }; dispatchRun(run: Record<string, unknown>): Promise<void> };
        const previousFence = local.RESTORE_FENCE_IDS;
        local.RESTORE_FENCE_IDS = id.toUpperCase();
        try {
          await expect(instance.prepareMaintenance()).rejects.toThrow(/workflow creation is unresolved/);
          await expect(instance.controlCheckpoint()).rejects.toThrow(/workflow creation is unresolved/);
          await internal.dispatchRun({ ...internal.runs.get(runId), id: crypto.randomUUID() });
          expect(calls).toBe(1);
        } finally {
          local.RESTORE_FENCE_IDS = previousFence;
        }
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
        await expect(instance.destroy()).rejects.toThrow(/workflow creation is unresolved/);
        await expect(instance.addSource(who, { filename: "another.pdf", r2Key: `vaults/${id}/sources/another` })).rejects.toThrow(/gone/);
        // A resumed alarm must not start a different create after closing.
        await internal.dispatchRun({ ...internal.runs.get(runId), id: crypto.randomUUID() });
        expect(calls).toBe(1);
        release();
        const { sourceId } = await add;
        expect(await instance.close()).toEqual({ distill: [sourceId], tailor: [] });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(0);
      } finally {
        release();
        await add.catch(() => {});
        local.DISTILL = original;
      }
    });
  });

  it("keeps deletion pending after an uncertain create and eviction", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "uncertain-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DISTILL;
      local.DISTILL = { create: async () => { throw new Error("synthetic unknown outcome"); } } as unknown as Workflow;
      try {
        await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${id}/sources/file` });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
      } finally {
        local.DISTILL = original;
      }
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
      await expect(instance.destroy()).rejects.toThrow(/workflow creation is unresolved/);
    });
  });

  it("fences terminal and legacy run IDs created before the dispatch-marker migration", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "migration-owner", gen: 1 };
    await stub.init(who.userId);
    const seeded = await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DISTILL;
      local.DISTILL = { create: async () => ({}) } as unknown as Workflow;
      try {
        const created = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${id}/sources/file` });
        const oldSource = crypto.randomUUID();
        const oldResume = crypto.randomUUID();
        const appId = crypto.randomUUID();
        state.storage.sql.exec(`UPDATE runs SET state='succeeded' WHERE id=?`, created.sourceId);
        state.storage.sql.exec(`INSERT INTO sources (id, filename, r2_key, state, run_id, created_at) VALUES (?, 'old.pdf', ?, 'ready', ?, 1)`, oldSource, `vaults/${id}/sources/old`, oldSource);
        state.storage.sql.exec(`INSERT INTO applications (id, jd_text, created_at) VALUES (?, 'old job', 1)`, appId);
        state.storage.sql.exec(`INSERT INTO resumes (id, application_id, state, run_id, created_at) VALUES (?, ?, 'ready', ?, 1)`, oldResume, appId, oldResume);
        // This fixture rewinds to the era before Workflow dispatch markers.
        state.storage.sql.exec(`DROP TRIGGER clear_source_write_link`);
        state.storage.sql.exec(`DROP TABLE source_write_links`);
        state.storage.sql.exec(`DROP TABLE export_cache_chunks`);
        state.storage.sql.exec(`DROP TABLE export_cache`);
        state.storage.sql.exec(`DROP TABLE application_create_requests`);
        state.storage.sql.exec(`DROP TABLE role_create_requests`);
        state.storage.sql.exec(`DROP TABLE fact_create_requests`);
        state.storage.sql.exec(`DROP TABLE workflow_dispatches`);
        state.storage.sql.exec(`DROP TABLE workflow_redispatches`);
        state.storage.sql.exec(`DROP TABLE r2_cache_dispatches`);
        state.storage.sql.exec(`DROP TRIGGER clear_unknown_end_start`);
        state.storage.sql.exec(`ALTER TABLE roles DROP COLUMN unknown_end_start_date`);
        state.storage.sql.exec(`ALTER TABLE facts DROP COLUMN level_revision`);
        const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("CREATE TABLE workflow_dispatches")));
        expect(previous).toBeGreaterThan(0);
        state.storage.sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
        return [created.sourceId, oldSource, oldResume].sort();
      } finally {
        local.DISTILL = original;
      }
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      expect(state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM workflow_dispatches`).toArray().map((row) => row.run_id).sort()).toEqual(seeded);
      await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
    });
  });

  it("keeps the Directory deletion pending until the dispatch marker is settled", async () => {
    const email = uniqueEmail();
    const d = directory(env);
    const { vaultId, userId } = await d.signIn({ provider: "test", subject: email, email, hint: "enam" });
    const stub = vault(env, vaultId);
    const runId = crypto.randomUUID();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workflow_dispatches (run_id) VALUES (?)`, runId);
    });
    await d.deleteAccount(userId, vaultId);
    await runDurableObjectAlarm(d);
    expect(await d.hasVault(vaultId)).toBe(true);
    // The first test exercises real acknowledgement clearing. Model that
    // persisted outcome here before invoking the Directory alarm again.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM workflow_dispatches WHERE run_id=?`, runId);
    });
    await runDurableObjectAlarm(d);
    await runDurableObjectAlarm(d);
    expect(await d.hasVault(vaultId)).toBe(false);
  });
});
