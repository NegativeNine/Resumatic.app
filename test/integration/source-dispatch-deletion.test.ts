import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { app } from "../../src/worker/routes";
import { readSession } from "../../src/worker/session";
import { signIn } from "./support";

function descriptor(id: string) {
  return {
    requestKey: "source-fence",
    descriptorDigest: "a".repeat(64),
    filename: "synthetic.pdf",
    r2Key: `vaults/${id}/sources/source-fence`,
    byteLength: 4,
    contentType: "application/pdf",
  };
}

it("blocks closure after dispatch authorization, even if the Worker crashes before its put", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: "fence-owner", gen: 1 };
  await stub.init(who.userId);
  const input = descriptor(stub.id.toString());
  await stub.reserveUpload(who, input);
  const attempt = crypto.randomUUID();
  await runInDurableObject(stub, async (instance) => {
    expect(instance.beginSourceWrite(who, input, attempt, "b".repeat(64))).toEqual({});
    await expect(instance.close()).rejects.toThrow("source write is unresolved");
    await expect(instance.destroy()).rejects.toThrow("source write is unresolved");
    expect(() => instance.beginSourceWrite(who, input, crypto.randomUUID(), "b".repeat(64))).toThrow(/gone/);
    expect(() => instance.finishCacheWrite("another-user", attempt)).toThrow(/forbidden/);
    // This is a stand-in for the original Worker's acknowledged put, not a
    // timeout or an inferred acknowledgement after a crash.
    instance.finishCacheWrite(who.userId, attempt);
    await expect(instance.close()).resolves.toEqual({ distill: [], tailor: [] });
  });
});

it("retains each concurrent put's fence until that put is acknowledged", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: "fence-owner", gen: 1 };
  await stub.init(who.userId);
  const input = descriptor(stub.id.toString());
  await stub.reserveUpload(who, input);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await runInDurableObject(stub, async (instance) => {
    instance.beginSourceWrite(who, input, first, "b".repeat(64));
    instance.beginSourceWrite(who, input, second, "b".repeat(64));
    instance.finishCacheWrite(who.userId, first);
    await expect(instance.close()).rejects.toThrow("source write is unresolved");
    instance.finishCacheWrite(who.userId, second);
    await expect(instance.close()).resolves.toEqual({ distill: [], tailor: [] });
  });
});

it("leaves the fence in place when R2 rejects a Worker put", async () => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing session");
  const stub = vault(env, session.vid);
  const form = new FormData();
  form.set("file", new File(["synthetic"], "resume.pdf", { type: "application/pdf" }));
  const response = await app.fetch(new Request("https://resumatic.test/api/sources", {
    method: "POST", headers: { cookie: user.cookie }, body: form,
  }), { ...env, FILES: { put: async () => { throw new Error("synthetic put failure"); } } } as unknown as Env);
  expect(response.status).toBe(500);
  await runInDurableObject(stub, async (instance, state) => {
    expect(state.storage.sql.exec(`SELECT kind FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(1);
    await expect(instance.close()).rejects.toThrow("source write is unresolved");
  });
});

it("waits for a late acknowledged Worker put before allowing the vault to close", async () => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing session");
  const stub = vault(env, session.vid);
  let release!: () => void;
  let notify!: (key: string) => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<string>((resolve) => { notify = resolve; });
  const files = {
    put: async (key: string, value: ArrayBuffer, options: R2PutOptions) => {
      notify(key);
      await held;
      return env.FILES.put(key, value, options);
    },
    delete: (key: string) => env.FILES.delete(key),
  };
  const form = new FormData();
  form.set("file", new File(["synthetic"], "resume.pdf", { type: "application/pdf" }));
  const request = Promise.resolve(app.fetch(new Request("https://resumatic.test/api/sources", {
    method: "POST", headers: { cookie: user.cookie }, body: form,
  }), { ...env, FILES: files } as unknown as Env));
  try {
    const key = await started;
    await runInDurableObject(stub, async (instance) => {
      instance.quiesce();
      await expect(instance.close()).rejects.toThrow("source write is unresolved");
    });
    release();
    expect((await request).status).toBe(410);
    expect(await env.FILES.head(key)).toBeNull();
    await expect(stub.close()).resolves.toEqual({ distill: [], tailor: [] });
  } finally {
    release();
    await request.catch(() => {});
  }
}, 20_000);

it("defers expiry cleanup until a late put settles, including if its Worker then crashes", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: "expiry-owner", gen: 1 };
  await stub.init(who.userId);
  const input = descriptor(stub.id.toString());
  await stub.reserveUpload(who, input);
  await runInDurableObject(stub, async (instance, state) => {
    const attempt = crypto.randomUUID();
    instance.beginSourceWrite(who, input, attempt, "b".repeat(64));
    state.storage.sql.exec(`UPDATE upload_intents SET expires_at=0 WHERE request_key=?`, input.requestKey);
    await instance.alarm();
    expect(state.storage.sql.exec<{ state: string; cleaned_at: number | null }>(`SELECT state,cleaned_at FROM upload_intents WHERE request_key=?`, input.requestKey).one()).toEqual({ state: "expired", cleaned_at: null });
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 30_000);
    expect(() => instance.beginSourceWrite(who, input, crypto.randomUUID(), "b".repeat(64))).toThrow(/expired/);
    // The put starts before expiry, but its acknowledgement arrives afterward.
    await env.FILES.put(input.r2Key, "late");
    instance.finishCacheWrite(who.userId, attempt);
    // No completeUpload: the Worker has crashed after settling the marker.
    await instance.alarm();
    expect(await env.FILES.head(input.r2Key)).toBeNull();
    expect(state.storage.sql.exec<{ cleaned_at: number | null }>(`SELECT cleaned_at FROM upload_intents WHERE request_key=?`, input.requestKey).one().cleaned_at).not.toBeNull();
  });
});

it("cleans unrelated expired uploads while preserving linked and unattributed write fences", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: "expiry-isolation-owner", gen: 1 };
  await stub.init(who.userId);
  const first = descriptor(stub.id.toString());
  const second = { ...first, requestKey: "second", r2Key: `vaults/${stub.id}/sources/second` };
  const third = { ...first, requestKey: "third", r2Key: `vaults/${stub.id}/sources/third` };
  for (const input of [first, second, third]) await stub.reserveUpload(who, input);
  await runInDurableObject(stub, async (instance, state) => {
    const linked = crypto.randomUUID();
    instance.beginSourceWrite(who, first, linked, "b".repeat(64));
    for (const input of [first, second, third]) {
      state.storage.sql.exec(`UPDATE upload_intents SET expires_at=0 WHERE request_key=?`, input.requestKey);
      await env.FILES.put(input.r2Key, "synthetic");
    }
    await instance.alarm();
    expect(await env.FILES.head(first.r2Key)).not.toBeNull();
    expect(await env.FILES.head(second.r2Key)).toBeNull();
    expect(await env.FILES.head(third.r2Key)).toBeNull();
    expect(state.storage.sql.exec(`SELECT source_id FROM source_write_links WHERE attempt_id=?`, linked).toArray()).toHaveLength(1);
    instance.finishCacheWrite(who.userId, linked);
    expect(state.storage.sql.exec(`SELECT source_id FROM source_write_links WHERE attempt_id=?`, linked).toArray()).toHaveLength(0);
    await instance.alarm();
    expect(await env.FILES.head(first.r2Key)).toBeNull();

    const fourth = { ...first, requestKey: "fourth", r2Key: `vaults/${stub.id}/sources/fourth` };
    await instance.reserveUpload(who, fourth);
    state.storage.sql.exec(`UPDATE upload_intents SET expires_at=0 WHERE request_key=?`, fourth.requestKey);
    await env.FILES.put(fourth.r2Key, "synthetic");
    const old = crypto.randomUUID();
    // A legacy or copy attempt has no trusted source link, even if it has a digest.
    instance.beginCacheWrite(who, old, "source", "c".repeat(64));
    await instance.alarm();
    expect(await env.FILES.head(fourth.r2Key)).not.toBeNull();
    instance.finishCacheWrite(who.userId, old);
    await instance.alarm();
    expect(await env.FILES.head(fourth.r2Key)).toBeNull();
  });
});

it("does not authorize a put if recording its reservation link fails", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: "link-rollback-owner", gen: 1 };
  await stub.init(who.userId);
  const input = descriptor(stub.id.toString());
  await stub.reserveUpload(who, input);
  await runInDurableObject(stub, (instance, state) => {
    state.storage.sql.exec(`CREATE TRIGGER fail_source_link BEFORE INSERT ON source_write_links BEGIN SELECT RAISE(ABORT, 'synthetic link failure'); END`);
    expect(() => instance.beginSourceWrite(who, input, crypto.randomUUID(), "b".repeat(64))).toThrow("synthetic link failure");
    expect(state.storage.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches`).toArray()).toHaveLength(0);
    expect(state.storage.sql.exec(`SELECT attempt_id FROM source_write_links`).toArray()).toHaveLength(0);
  });
});
