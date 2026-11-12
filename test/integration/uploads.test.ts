import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  UploadStore,
  UPLOAD_INTENT_TTL_MS,
  UPLOAD_MIGRATIONS,
  uploadDescriptorDigest,
  type UploadDescriptor,
  type UploadIntent,
} from "../../src/vault/uploads";
import { RUN_MIGRATIONS, RunStore } from "../../src/vault/runs";
import { completeReservedUpload } from "../../src/worker/upload-cleanup";
import { readSession } from "../../src/worker/session";
import { vault } from "../../src/shared/stubs";
import { signIn } from "./support";

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
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
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
        "Resumatic is still reading your other files. Wait for one to finish, then upload this file.",
      );
      store.complete(one, (intent) => insert(sql, intent));
      expect(() => store.reserve(descriptor(id, "four"))).toThrow(
        "Resumatic is still reading your other files. Wait for one to finish, then upload this file.",
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
        "You can keep up to 2 files during the beta. Email support@resumatic.app if you need more.",
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
      ).toThrow("This file wasn't added. Upload it again.");
      expect(store.get(input.requestKey)?.state).toBe("expired");
      expect(store.isExpired(input)).toBe(true);
      expect(store.isExpired({ ...input, descriptorDigest: "b".repeat(64) })).toBe(false);
      expect(store.isExpired({ ...input, requestKey: "other-request" })).toBe(false);
      const [candidate] = store.cleanupCandidates();
      expect(candidate?.r2Key).toBe(input.r2Key);
      expect(store.nextAlarm()).toBe(clock.now);
      // A failed delete leaves the same candidate. Only a successful delete is acknowledged.
      expect(store.cleanupCandidates()).toEqual([candidate]);
      store.markCleaned(input.requestKey, input.r2Key);
      store.markCleaned(input.requestKey, input.r2Key);
      expect(store.cleanupCandidates()).toEqual([]);
      expect(store.nextAlarm()).toBeNull();
      expect(() => store.reserve(input)).toThrow("This file wasn't added. Upload it again.");
      expect(() =>
        store.reserve({ ...input, requestKey: "other-request" }),
      ).toThrow("storage key is already reserved");
      expect(sql.exec(`SELECT id FROM sources`).toArray()).toEqual([]);
    });
  });

  it("persists a wrapping cleanup cursor so failed and interrupted pages are revisited", async () => {
    await withStore((store, _runs, sql, clock, id) => {
      for (let i = 0; i < 201; i++) {
        const key = `upload-${String(i).padStart(3, "0")}`;
        sql.exec(`INSERT INTO upload_intents
          (request_key,descriptor_digest,source_id,filename,r2_key,byte_length,content_type,origin,state,created_at,expires_at)
          VALUES (?,?,?,?,?,1,'application/pdf','upload','expired',0,0)`,
          key, "a".repeat(64), `source-${i}`, "resume.pdf", `vaults/${id}/sources/${key}`);
      }
      const first = store.cleanupCandidates();
      expect(first.map((item) => item.requestKey)).toEqual(Array.from({ length: 100 }, (_, i) => `upload-${String(i).padStart(3, "0")}`));
      // Recreate the store to simulate interruption after reserving a page but
      // before any R2 acknowledgement. Those rows must still be revisited.
      const reopened = new UploadStore(sql, (fn) => fn(), { vaultId: id, maxSources: 50, maxQueued: 3 }, () => clock.now);
      expect(reopened.cleanupCandidates().map((item) => item.requestKey)).toEqual(
        Array.from({ length: 100 }, (_, i) => `upload-${String(i + 100).padStart(3, "0")}`),
      );
      const wrapped = reopened.cleanupCandidates();
      expect(wrapped[0]?.requestKey).toBe("upload-200");
      expect(wrapped[1]?.requestKey).toBe("upload-000");
      reopened.markCleaned(wrapped[0]!.requestKey, wrapped[0]!.r2Key);
      expect(reopened.nextAlarm()).toBe(clock.now);
      expect(reopened.cleanupCandidates().some((item) => item.requestKey === "upload-200")).toBe(false);
    });
  });

  it("wraps negative and full-width rowids even when the stored cursor is malformed", async () => {
    await withStore((store, _runs, sql, _clock, id) => {
      for (const [rowid, key] of [["-7", "negative"], ["9007199254740992", "large-a"], ["9007199254740993", "large-b"]]) {
        // rowids are fixed literals here: using JS numbers would lose precision.
        sql.exec(`INSERT INTO upload_intents
          (rowid,request_key,descriptor_digest,source_id,filename,r2_key,byte_length,content_type,origin,state,created_at,expires_at)
          VALUES (${rowid},?,?,?,?,?,1,'application/pdf','upload','expired',0,0)`,
          key, "a".repeat(64), `source-${key}`, "resume.pdf", `vaults/${id}/sources/${key}`);
      }
      sql.exec(`INSERT INTO meta(key,value) VALUES ('upload_cleanup_cursor','broken')`);
      expect(store.cleanupCandidates(1)[0]?.requestKey).toBe("large-a");
      expect(store.cleanupCandidates(1)[0]?.requestKey).toBe("large-b");
      expect(store.cleanupCandidates(1)[0]?.requestKey).toBe("negative");
      expect(store.cleanupCandidates(1)[0]?.requestKey).toBe("large-a");
    });
  });

  it("retries an alarm past a page of failed deletes while retaining an unresolved source-write fence", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    await stub.init("upload-rotation");
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      const remove = vi.fn(async (key: string) => {
        if (!key.endsWith("/upload-100")) throw new Error("synthetic failure");
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      local.FILES = { delete: remove } as unknown as R2Bucket;
      try {
        for (let i = 0; i < 101; i++) {
          const key = `upload-${String(i).padStart(3, "0")}`;
          state.storage.sql.exec(`INSERT INTO upload_intents
            (request_key,descriptor_digest,source_id,filename,r2_key,byte_length,content_type,origin,state,created_at,expires_at)
            VALUES (?,?,?,?,?,1,'application/pdf','upload','expired',0,0)`,
            key, "a".repeat(64), `source-${i}`, "resume.pdf", `vaults/${id}/sources/${key}`);
        }
        const attempt = crypto.randomUUID();
        state.storage.sql.exec(`INSERT INTO r2_cache_dispatches(attempt_id,kind,created_at) VALUES (?,'source',0)`, attempt);
        state.storage.sql.exec(`INSERT INTO source_write_links(attempt_id,source_id) VALUES (?,'source-0')`, attempt);
        await state.storage.deleteAlarm();
        await instance.alarm();
        expect(remove).not.toHaveBeenCalledWith(`vaults/${id}/sources/upload-100`);
        expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
        await instance.alarm();
        expect(remove).toHaveBeenCalledWith(`vaults/${id}/sources/upload-100`);
        expect(remove).not.toHaveBeenCalledWith(`vaults/${id}/sources/upload-000`);
        expect(state.storage.sql.exec<{ cleaned_at: number | null }>(`SELECT cleaned_at FROM upload_intents WHERE request_key='upload-100'`).one().cleaned_at).toEqual(expect.any(Number));
        expect(state.storage.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE attempt_id=?`, attempt).toArray()).toHaveLength(1);
        expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
      } finally {
        local.FILES = previous;
        log.mockRestore();
      }
    });
  });

  it("cleans a late acknowledged write even after the expiry sweep, without touching a committed retry", async () => {
    await withStore(async (store, _runs, sql, clock, id) => {
      const expired = descriptor(id, "expired");
      const first = store.reserve(expired);
      clock.now = first.intent.expiresAt;
      expect(store.cleanupCandidates()).toHaveLength(1);
      await env.FILES.delete(expired.r2Key);
      store.markCleaned(expired.requestKey, expired.r2Key);
      // An earlier put can acknowledge after that delete; completion must
      // recheck the durable terminal intent, then remove this acknowledged put.
      await env.FILES.put(expired.r2Key, "late");
      await expect(completeReservedUpload(env.FILES, expired.r2Key, async () =>
        store.complete(expired, (intent) => insert(sql, intent)), {
          expired: async () => store.isExpired(expired),
        })).rejects.toThrow("This file wasn't added. Upload it again.");
      expect(await env.FILES.get(expired.r2Key)).toBeNull();
      expect(() => store.reserve(expired)).toThrow("This file wasn't added. Upload it again.");
      expect(() => store.reserve({ ...expired, requestKey: "new-request" })).toThrow("already reserved");

      const committed = descriptor(id, "committed");
      store.reserve(committed);
      await env.FILES.put(committed.r2Key, "accepted");
      store.complete(committed, (intent) => insert(sql, intent));
      expect(store.isExpired(committed)).toBe(false);
      // A descriptor mismatch may report a conflict, but must never delete
      // bytes already accepted for the original request.
      const changed = { ...committed, filename: "another.pdf" };
      await expect(completeReservedUpload(env.FILES, changed.r2Key, async () =>
        store.complete(changed, () => {}), { expired: async () => store.isExpired(changed) })).rejects.toThrow("different input");
      expect(await (await env.FILES.get(committed.r2Key))!.text()).toBe("accepted");
    });
  });

  it("requires the current owner's session to confirm an expired reservation across RPC", async () => {
    const user = await signIn();
    const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
    expect(session).not.toBeNull();
    const { uid, vid, gen, epoch } = session!;
    const who = { userId: uid, gen, epoch };
    const stub = vault(env, vid);
    const input = descriptor(vid, crypto.randomUUID());
    await stub.reserveUpload(who, input);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE upload_intents SET state='expired' WHERE request_key=?`, input.requestKey);
    });
    await env.FILES.put(input.r2Key, "late");
    const complete = () => stub.completeUpload(who, input);
    await expect(completeReservedUpload(env.FILES, input.r2Key, complete, {
      expired: () => stub.expiredUploadForCleanup({ ...who, gen: gen + 1 }, input),
    })).rejects.toThrow("This file wasn't added. Upload it again.");
    expect(await (await env.FILES.get(input.r2Key))!.text()).toBe("late");
    await expect(completeReservedUpload(env.FILES, input.r2Key, complete, {
      expired: () => stub.expiredUploadForCleanup(who, input),
    })).rejects.toThrow("This file wasn't added. Upload it again.");
    expect(await env.FILES.get(input.r2Key)).toBeNull();
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
      ).toThrow("The original file can't be found. It may have been deleted.");
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
