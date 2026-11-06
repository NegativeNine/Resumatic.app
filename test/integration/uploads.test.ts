import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  UploadStore,
  UPLOAD_INTENT_TTL_MS,
  UPLOAD_MIGRATIONS,
  uploadDescriptorDigest,
  type UploadDescriptor,
  type UploadIntent,
} from "../../src/vault/uploads";
import { RUN_MIGRATIONS, RunStore } from "../../src/vault/runs";

async function withStore(
  test: (
    store: UploadStore,
    runs: RunStore,
    sql: SqlStorage,
    clock: { now: number },
    vaultId: string,
  ) => void | Promise<void>,
  maxSources = 50,
): Promise<void> {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  return runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, filename TEXT NOT NULL, r2_key TEXT NOT NULL, state TEXT NOT NULL)`,
    );
    for (const migration of [...UPLOAD_MIGRATIONS, ...RUN_MIGRATIONS])
      sql.exec(migration);
    const clock = { now: Date.UTC(2026, 10, 6) };
    const transaction = <T>(callback: () => T): T =>
      state.storage.transactionSync(callback);
    return test(
      new UploadStore(
        sql,
        transaction,
        { vaultId: stub.id.toString(), maxSources, maxQueued: 3 },
        () => clock.now,
      ),
      new RunStore(sql, transaction, () => clock.now),
      sql,
      clock,
      stub.id.toString(),
    );
  });
}
const descriptor = (
  vaultId: string,
  requestKey = "upload-1",
): UploadDescriptor => ({
  requestKey,
  descriptorDigest: "a".repeat(64),
  filename: "synthetic.pdf",
  byteLength: 4,
  contentType: "application/pdf",
  r2Key: `vaults/${vaultId}/sources/${requestKey}`,
});
function insert(sql: SqlStorage, intent: UploadIntent) {
  sql.exec(
    `INSERT INTO sources (id,filename,r2_key,state) VALUES (?,?,?,'queued')`,
    intent.sourceId,
    intent.filename,
    intent.r2Key,
  );
}

describe("durable upload reservations", () => {
  it("binds a request to one descriptor and preserves its fixed deadline across retries", async () => {
    await withStore((store, _runs, _sql, clock, id) => {
      const input = descriptor(id);
      const first = store.reserve(input);
      expect(first.replay).toBe(false);
      expect(first.intent).toMatchObject({
        state: "pending",
        filename: input.filename,
        expiresAt: clock.now + UPLOAD_INTENT_TTL_MS,
      });
      clock.now += 60_000;
      expect(store.reserve(input)).toEqual({
        intent: first.intent,
        replay: true,
      });
      expect(store.nextAlarm()).toBe(first.intent.expiresAt);
      for (const changed of [
        { filename: "different.pdf" },
        { descriptorDigest: "b".repeat(64) },
        { byteLength: 5 },
        { r2Key: `${input.r2Key}-other` },
        { contentType: "application/zip" },
      ])
        expect(() => store.reserve({ ...input, ...changed })).toThrow(
          "different input",
        );
      expect(() =>
        store.complete({ ...input, filename: "different.pdf" }, () => {}),
      ).toThrow("different input");
      expect(store.get(input.requestKey)).toEqual(first.intent);
    });
  });

  it("atomically publishes its source and run, then replays a lost completion acknowledgement", async () => {
    await withStore((store, runs, sql, _clock, id) => {
      const input = descriptor(id);
      const first = store.reserve(input);
      const publish = (intent: UploadIntent) =>
        runs.begin(
          {
            id: intent.sourceId,
            kind: "distill",
            targetId: intent.sourceId,
            requestKey: `source:${input.requestKey}`,
            inputDigest: input.descriptorDigest,
            steps: ["convert", "extract", "embed"],
          },
          () => insert(sql, intent),
        );
      expect(() =>
        store.complete(input, (intent) => {
          publish(intent);
          throw new Error("synthetic_commit_failure");
        }),
      ).toThrow("synthetic_commit_failure");
      expect(store.get(input.requestKey)?.state).toBe("pending");
      expect(runs.get(first.intent.sourceId)).toBeNull();
      expect(sql.exec(`SELECT id FROM sources`).toArray()).toEqual([]);
      const committed = store.complete(input, (intent) => {
        publish(intent);
      });
      expect(committed).toMatchObject({
        replay: false,
        intent: { sourceId: first.intent.sourceId, state: "complete" },
      });
      const replay = store.complete(input, () => {
        throw new Error("must not publish twice");
      });
      expect(replay).toEqual({ ...committed, replay: true });
      expect(store.reserve(input)).toEqual(replay);
      expect(runs.list()).toHaveLength(1);
      expect(sql.exec(`SELECT id FROM sources`).toArray()).toHaveLength(1);
      expect(store.nextAlarm()).toBeNull();
    });
  });

  it("reserves capacity before any object can be written and counts queued sources only once", async () => {
    await withStore((store, _runs, sql, _clock, id) => {
      const one = descriptor(id, "one");
      const two = descriptor(id, "two");
      const three = descriptor(id, "three");
      store.reserve(one);
      store.reserve(two);
      store.reserve(three);
      expect(() => store.reserve(descriptor(id, "four"))).toThrow(
        "wait for your other uploads",
      );
      store.complete(one, (intent) => insert(sql, intent));
      expect(() => store.reserve(descriptor(id, "four"))).toThrow(
        "wait for your other uploads",
      );
      sql.exec(`UPDATE sources SET state = 'ready'`);
      expect(store.reserve(descriptor(id, "four")).intent.state).toBe(
        "pending",
      );
    });
    await withStore((store, _runs, _sql, _clock, id) => {
      store.reserve(descriptor(id, "one"));
      store.reserve(descriptor(id, "two"));
      expect(() => store.reserve(descriptor(id, "three"))).toThrow(
        "at most 2 uploads",
      );
    }, 2);
  });

  it("retains ambiguous writes until expiry, fences late completion and never revives cleaned keys", async () => {
    await withStore((store, _runs, sql, clock, id) => {
      const input = descriptor(id);
      const first = store.reserve(input);
      // A failed R2 put or lost response performs no state transition.
      clock.now = first.intent.expiresAt - 1;
      expect(store.cleanupCandidates()).toEqual([]);
      expect(store.get(input.requestKey)?.state).toBe("pending");
      clock.now++;
      expect(() =>
        store.complete(input, (intent) => insert(sql, intent)),
      ).toThrow("expired");
      expect(store.get(input.requestKey)?.state).toBe("expired");
      const [candidate] = store.cleanupCandidates();
      expect(candidate?.r2Key).toBe(input.r2Key);
      expect(store.nextAlarm()).toBe(clock.now);
      // A failed delete leaves the same candidate. Only a successful delete is acknowledged.
      expect(store.cleanupCandidates()).toEqual([candidate]);
      store.markCleaned(input.requestKey, input.r2Key);
      store.markCleaned(input.requestKey, input.r2Key);
      expect(store.cleanupCandidates()).toEqual([]);
      expect(store.nextAlarm()).toBeNull();
      expect(() => store.reserve(input)).toThrow("expired");
      expect(() =>
        store.reserve({ ...input, requestKey: "other-request" }),
      ).toThrow("storage key is already reserved");
      expect(sql.exec(`SELECT id FROM sources`).toArray()).toEqual([]);
    });
  });

  it("does not erase accepted bytes when the same request is retried with another filename", async () => {
    await withStore(async (store, _runs, sql, clock, id) => {
      const body = "same synthetic bytes";
      const input = { ...descriptor(id), byteLength: body.length };
      input.descriptorDigest = await uploadDescriptorDigest(input, body);
      store.reserve(input);
      await env.FILES.put(input.r2Key, body);
      store.complete(input, (intent) => insert(sql, intent));
      const changed = { ...input, filename: "different.pdf" };
      changed.descriptorDigest = await uploadDescriptorDigest(changed, body);
      expect(changed.descriptorDigest).not.toBe(input.descriptorDigest);
      expect(() => store.reserve(changed)).toThrow("different input");
      clock.now += UPLOAD_INTENT_TTL_MS * 2;
      expect(store.cleanupCandidates()).toEqual([]);
      expect(() => store.markCleaned(input.requestKey, input.r2Key)).toThrow(
        "not eligible",
      );
      expect(await (await env.FILES.get(input.r2Key))!.text()).toBe(body);
      expect(store.reserve(input).intent.state).toBe("complete");
    });
  });

  it("rejects cross-vault keys, missing parents, invalid sizes and incomplete completion callbacks", async () => {
    await withStore((store, _runs, sql, _clock, id) => {
      const input = descriptor(id);
      expect(() =>
        store.reserve({ ...input, r2Key: "vaults/other/sources/file" }),
      ).toThrow("invalid upload descriptor");
      expect(() => store.reserve({ ...input, byteLength: 0 })).toThrow(
        "invalid upload descriptor",
      );
      expect(() =>
        store.reserve({ ...input, origin: "ocr", parentSourceId: "missing" }),
      ).toThrow("no such original");
      expect(() =>
        store.complete(input, (intent) => insert(sql, intent)),
      ).toThrow("reserve the upload");
      store.reserve(input);
      expect(() => store.complete(input, () => {})).toThrow(
        "must create its reserved source",
      );
      expect(() => store.complete(input, () => Promise.resolve())).toThrow(
        "synchronous",
      );
      expect(store.get(input.requestKey)?.state).toBe("pending");
    });
  });
});
