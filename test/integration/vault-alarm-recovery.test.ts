import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";

it("rearms before cleanup and keeps processing when an upload delete fails", async () => {
  const id = env.VAULT.newUniqueId().toString();
  const stub = vault(env, id);
  const who = { userId: "vault-alarm-recovery", gen: 1 };
  await stub.init(who.userId);
  await runInDurableObject(stub, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const previousFiles = local.FILES;
    const previousTailor = local.TAILOR;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const status = vi.fn(async () => ({ status: "errored" }));
    const remove = vi.fn(async (key: string) => {
      expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
      if (key.endsWith("/first")) throw new Error("sensitive provider error");
    });
    local.FILES = { delete: remove } as unknown as R2Bucket;
    local.TAILOR = { async create() { return {}; }, async get() { return { status }; } } as unknown as Workflow;
    try {
      const { applicationId } = await instance.addApplication(who, "A detailed engineering job description for an application.");
      const { runId } = await instance.tailor(who, applicationId);
      for (const name of ["first", "second"]) {
        await instance.reserveUpload(who, {
          requestKey: name,
          descriptorDigest: "a".repeat(64),
          filename: `${name}.pdf`,
          r2Key: `vaults/${id}/sources/${name}`,
          byteLength: 1,
          contentType: "application/pdf",
        });
      }
      state.storage.sql.exec(`UPDATE upload_intents SET expires_at = 0`);
      await state.storage.deleteAlarm(); // Simulate delivery consuming the scheduled alarm.
      await instance.alarm();
      expect(remove).toHaveBeenCalledTimes(2);
      expect(status).toHaveBeenCalledOnce();
      expect((await instance.runInfo(who, runId)).state).toBe("failed");
      expect(state.storage.sql.exec<{ request_key: string; cleaned_at: number | null }>(
        `SELECT request_key, cleaned_at FROM upload_intents ORDER BY request_key`,
      ).toArray()).toEqual([
        { request_key: "first", cleaned_at: null },
        { request_key: "second", cleaned_at: expect.any(Number) },
      ]);
      expect(log).toHaveBeenCalledWith("upload cleanup pending", { code: "upload_cleanup_pending" });
      expect(await state.storage.getAlarm()).toEqual(expect.any(Number));

      remove.mockImplementation(async () => {});
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(state.storage.sql.exec(`SELECT request_key FROM upload_intents WHERE cleaned_at IS NULL`).toArray()).toHaveLength(0);
      expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    } finally {
      log.mockRestore();
      local.FILES = previousFiles;
      local.TAILOR = previousTailor;
    }
  });
});

it("does not recreate an alarm or touch erased state after a held status call returns", async () => {
  const id = env.VAULT.newUniqueId().toString();
  const stub = vault(env, id);
  const who = { userId: "vault-alarm-close", gen: 1 };
  await stub.init(who.userId);
  await runInDurableObject(stub, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.TAILOR;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    local.TAILOR = {
      async create() { return {}; },
      async get() { return { async status() { enter(); await held; return { status: "errored" }; } }; },
    } as unknown as Workflow;
    let running: Promise<void> | undefined;
    try {
      const { applicationId } = await instance.addApplication(who, "A detailed engineering job description for an application.");
      await instance.tailor(who, applicationId);
      await state.storage.deleteAlarm();
      running = instance.alarm();
      await entered;
      expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
      await instance.destroy();
      expect(await state.storage.getAlarm()).toBeNull();
      release();
      await expect(running).resolves.toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    } finally {
      release();
      await running?.catch(() => {});
      local.TAILOR = previous;
    }
  });
});

it("stops a held redispatch before reading storage after closing begins", async () => {
  const id = env.VAULT.newUniqueId().toString();
  const stub = vault(env, id);
  const who = { userId: "vault-redispatch-close", gen: 1 };
  await stub.init(who.userId);
  await runInDurableObject(stub, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.TAILOR;
    local.TAILOR = { async create() { return {}; } } as unknown as Workflow;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const internal = instance as unknown as {
      redispatchUncertain(id: string): Promise<void>;
      scheduleRunAlarm(at: number): Promise<void>;
    };
    let running: Promise<void> | undefined;
    try {
      const { applicationId } = await instance.addApplication(who, "A detailed engineering job description for an application.");
      const { runId } = await instance.tailor(who, applicationId);
      state.storage.sql.exec(`UPDATE runs SET state='starting' WHERE id=?`, runId);
      state.storage.sql.exec(`INSERT OR IGNORE INTO workflow_dispatches (run_id) VALUES (?)`, runId);
      const schedule = vi.spyOn(internal, "scheduleRunAlarm").mockImplementation(async () => { enter(); await held; });
      running = internal.redispatchUncertain(runId);
      await entered;
      // The sticky dispatch correctly prevents destruction, but close has
      // already quiesced the vault. Removing the table makes any stale read
      // after that lifecycle check observable in this isolated test.
      await expect(instance.close()).rejects.toThrow("workflow creation is unresolved");
      state.storage.sql.exec(`DROP TABLE workflow_redispatches`);
      release();
      await expect(running).resolves.toBeUndefined();
      schedule.mockRestore();
    } finally {
      release();
      await running?.catch(() => {});
      local.TAILOR = previous;
    }
  });
});
