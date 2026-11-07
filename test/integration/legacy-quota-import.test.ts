import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

async function fixture({ existingBucket = false, legacyUsage = 2, legacyRows = 1 } = {}) {
  const stub = vault(env, env.VAULT.newUniqueId().toString());
  const who = { userId: crypto.randomUUID(), gen: 1 };
  await stub.init(who.userId);
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO applications (id, jd_text, created_at) VALUES ('job', 'job description', 1)`);
    sql.exec(`UPDATE meta SET value = ? WHERE key = 'quota_used'`, String(legacyUsage));
    for (let i = 0; i < legacyRows; i++) {
      sql.exec(`INSERT INTO resumes (id, application_id, state, quota_month, run_id, created_at) VALUES (?, 'job', 'running', ?, ?, 1)`, `legacy-${i}`, month, `legacy-run-${i}`);
    }
    if (existingBucket) {
      sql.exec(`INSERT INTO quota_buckets (bucket_key, start_at, end_at, allowance, used, reserved) VALUES (?, ?, ?, 3, 1, 0)`,
        `free:${month}`, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }
  });
  return { stub, who, month };
}

function markFailed(instance: unknown, state: DurableObjectState, id: string) {
  const runId = state.storage.sql.exec<{ run_id: string | null }>(`SELECT run_id FROM resumes WHERE id=?`, id).one().run_id;
  (instance as { markResumeFailed(id: string, error: string, expectedRunId: string | null): void }).markResumeFailed(id, "failed", runId);
}

describe("legacy quota import", () => {
  it("rolls back the bucket and entitlement when marking the imported run fails", async () => {
    const { stub, who } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TRIGGER fail_import_marker BEFORE INSERT ON meta WHEN NEW.key GLOB 'legacy_quota_import:*' BEGIN SELECT RAISE(ABORT, 'marker failed'); END`);
      await expect(instance.setPlan(1, { planId: "free", generationLimit: 3, bucket: "free:unused", validUntil: null, subscriptionId: null, status: "canceled", cancelAtPeriodEnd: false })).rejects.toThrow("marker failed");
      expect(sql.exec(`SELECT * FROM quota_buckets`).toArray()).toEqual([]);
      expect(sql.exec(`SELECT * FROM meta WHERE key = 'entitlement' OR key GLOB 'legacy_quota_import:*'`).toArray()).toEqual([]);
      sql.exec(`DROP TRIGGER fail_import_marker`);
    });
    expect((await stub.me(who)).quota.used).toBe(2);
  });

  it("refunds only the captured legacy run, atomically and once", async () => {
    const { stub, who, month } = await fixture();
    expect((await stub.me(who)).quota.used).toBe(2);
    await runInDurableObject(stub, (instance, state) => {
      const sql = state.storage.sql;
      expect(sql.exec(`SELECT value FROM meta WHERE key = 'legacy_quota_import:legacy-0'`).one().value).toBe(`free:${month}`);
      // An older lookup must not fail or refund a replacement legacy run.
      (instance as unknown as { markResumeFailed(id: string, error: string, expectedRunId: string | null): void })
        .markResumeFailed("legacy-0", "failed", "stale-run");
      expect(sql.exec(`SELECT state FROM resumes WHERE id = 'legacy-0'`).one().state).toBe("running");
      expect(sql.exec(`SELECT value FROM meta WHERE key = 'legacy_quota_import:legacy-0'`).one().value).toBe(`free:${month}`);
      expect(sql.exec(`SELECT used FROM quota_buckets WHERE bucket_key = ?`, `free:${month}`).one().used).toBe(2);
      sql.exec(`CREATE TRIGGER fail_refund BEFORE UPDATE OF used ON quota_buckets BEGIN SELECT RAISE(ABORT, 'refund failed'); END`);
      expect(() => markFailed(instance, state, "legacy-0")).toThrow("refund failed");
      expect(sql.exec(`SELECT state FROM resumes WHERE id = 'legacy-0'`).one().state).toBe("running");
      expect(sql.exec(`SELECT value FROM meta WHERE key = 'quota_used'`).one().value).toBe("2");
      sql.exec(`DROP TRIGGER fail_refund`);
      markFailed(instance, state, "legacy-0");
      markFailed(instance, state, "legacy-0");
      expect(sql.exec(`SELECT value FROM meta WHERE key = 'quota_used'`).one().value).toBe("1");
      expect(sql.exec(`SELECT * FROM meta WHERE key = 'legacy_quota_import:legacy-0'`).toArray()).toEqual([]);
    });
    expect((await stub.me(who)).quota.used).toBe(1);
  });

  it("does not refund an ambiguous existing bucket or guess which inconsistent pending charge was included", async () => {
    for (const options of [{ existingBucket: true }, { legacyUsage: 1, legacyRows: 2 }]) {
      const { stub, who } = await fixture(options);
      const before = (await stub.me(who)).quota.used;
      await runInDurableObject(stub, (instance, state) => {
        expect(state.storage.sql.exec(`SELECT * FROM meta WHERE key GLOB 'legacy_quota_import:*'`).toArray()).toEqual([]);
        markFailed(instance, state, "legacy-0");
      });
      expect((await stub.me(who)).quota.used).toBe(before);
    }
  });

  it("does not infer pending charges after newer ledger-backed tailoring history", async () => {
    const { stub, who } = await fixture();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO runs (id, kind, target_id, request_key, input_digest, state, steps, credit_state, created_at, updated_at) VALUES ('old-ledger', 'tailor', 'other-resume', 'other-key', 'digest', 'failed', '[]', 'released', 1, 1)`);
    });
    expect((await stub.me(who)).quota.used).toBe(2);
    await runInDurableObject(stub, (instance, state) => {
      expect(state.storage.sql.exec(`SELECT * FROM meta WHERE key GLOB 'legacy_quota_import:*'`).toArray()).toEqual([]);
      markFailed(instance, state, "legacy-0");
    });
    expect((await stub.me(who)).quota.used).toBe(2);
  });

  it("does not decrement the legacy counter when a new ledger run fails", async () => {
    const { stub, who, month } = await fixture();
    expect((await stub.me(who)).quota.used).toBe(2);
    await runInDurableObject(stub, (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO runs (id, kind, target_id, request_key, input_digest, state, steps, credit_state, created_at, updated_at) VALUES ('new-run', 'tailor', 'new-resume', 'key', 'digest', 'running', '[]', 'none', 1, 1)`);
      sql.exec(`INSERT INTO resumes (id, application_id, state, quota_month, run_id, created_at) VALUES ('new-resume', 'job', 'running', ?, 'new-run', 1)`, month);
      markFailed(instance, state, "new-resume");
      expect(sql.exec(`SELECT value FROM meta WHERE key = 'quota_used'`).one().value).toBe("2");
    });
    expect((await stub.me(who)).quota.used).toBe(2);
  });

  it("refunds the original bucket even after a new quota month or plan is selected", async () => {
    const { stub, who, month } = await fixture();
    expect((await stub.me(who)).quota.used).toBe(2);
    const now = Math.floor(Date.now() / 1000);
    await stub.setPlan(1, { planId: "pro", generationLimit: 50, bucket: `paid:sub_test:${now - 1}`, validUntil: (now + 3600) * 1000, subscriptionId: "sub_test", status: "active", cancelAtPeriodEnd: false });
    await runInDurableObject(stub, (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE meta SET value = '2099-01' WHERE key = 'quota_month'`);
      sql.exec(`UPDATE meta SET value = '4' WHERE key = 'quota_used'`);
      markFailed(instance, state, "legacy-0");
      expect(sql.exec(`SELECT used FROM quota_buckets WHERE bucket_key = ?`, `free:${month}`).one().used).toBe(1);
      expect(sql.exec(`SELECT value FROM meta WHERE key = 'quota_used'`).one().value).toBe("4");
    });
    expect((await stub.me(who)).quota.used).toBe(0);
  });

  it("reconciles a captured failure written by an older runtime", async () => {
    const { stub, who } = await fixture();
    expect((await stub.me(who)).quota.used).toBe(2);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE resumes SET state = 'failed' WHERE id = 'legacy-0'`);
      state.storage.sql.exec(`UPDATE meta SET value = '1' WHERE key = 'quota_used'`);
    });
    expect((await stub.me(who)).quota.used).toBe(1);
    expect((await stub.me(who)).quota.used).toBe(1);
  });

  it("includes outstanding import markers in the fenced maintenance checkpoint", async () => {
    const { stub, who, month } = await fixture();
    await stub.me(who);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const prior = local.RESTORE_FENCE_IDS;
      local.RESTORE_FENCE_IDS = stub.id.toString();
      try {
        const checkpoint = await instance.controlCheckpoint();
        expect(checkpoint.meta).toContainEqual({ key: "legacy_quota_import:legacy-0", value: `free:${month}` });
      } finally {
        local.RESTORE_FENCE_IDS = prior;
      }
    });
  });
});
