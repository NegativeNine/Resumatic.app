import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";

it("reconciles another cancellation while one Workflow status is stalled", async () => {
  const id = env.VAULT.newUniqueId().toString();
  const stub = vault(env, id);
  const who = { userId: "vault-alarm-independent-runs", gen: 1 };
  await stub.init(who.userId);
  await runInDurableObject(stub, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const original = local.DISTILL;
    let enter!: () => void, release!: () => void, observeSecond!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const secondObserved = new Promise<void>((resolve) => { observeSecond = resolve; });
    let stalledId = "";
    local.DISTILL = {
      async create() { return {}; },
      async get(runId: string) {
        return { async status() {
          if (runId === stalledId) { enter(); await held; return { status: "running" }; }
          observeSecond();
          return { status: "terminated" };
        } };
      },
    } as unknown as Workflow;
    let alarm: Promise<void> | undefined;
    try {
      const first = await instance.addSource(who, { filename: "first.pdf", r2Key: `vaults/${id}/sources/first` });
      const second = await instance.addSource(who, { filename: "second.pdf", r2Key: `vaults/${id}/sources/second` });
      stalledId = first.sourceId;
      state.storage.sql.exec(`UPDATE runs SET created_at=1 WHERE id=?`, first.sourceId);
      state.storage.sql.exec(`UPDATE runs SET created_at=2 WHERE id=?`, second.sourceId);
      await instance.cancelRun(who, second.sourceId);
      await state.storage.deleteAlarm();
      alarm = instance.alarm();
      await entered;
      // The first lookup remains held, but another lane can reconcile the
      // independently cancelled run and release its associated state.
      await Promise.race([
        secondObserved,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second run did not make progress")), 2_000)),
      ]);
      await vi.waitFor(() => {
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM runs WHERE id=?`, second.sourceId).one().state).toBe("cancelled");
      });
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM runs WHERE id=?`, first.sourceId).one().state).toBe("starting");
      expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
      release();
      await alarm;
    } finally {
      release();
      await alarm?.catch(() => {});
      local.DISTILL = original;
    }
  });
}, 30_000);

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
