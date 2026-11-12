import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";
import { app } from "../../src/worker/routes";
import { readSession } from "../../src/worker/session";
import { setModels } from "../../src/ai/models";
import { fakeModels, signIn, waitForSource } from "./support";

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

it.each(["upload", "ocr"] as const)("does not fall back to a Worker put against an old Vault: %s", async (kind) => {
  const user = await signIn();
  const put = vi.fn();
  const oldVault = {
    checkSession: async () => {},
    sourceFile: async () => ({ filename: "resume.pdf", origin: "upload", r2Key: "unused" }),
    reserveUpload: async () => ({ intent: { state: "pending", createdAt: Date.now() } }),
  };
  const bindings = {
    ...env,
    MODEL_TRANSCRIBE: "synthetic",
    VAULT: { idFromString: () => ({}), get: () => oldVault },
    FILES: { put },
  } as unknown as Env;
  let request: Request;
  if (kind === "upload") {
    const form = new FormData();
    form.set("file", new File(["synthetic"], "resume.pdf", { type: "application/pdf" }));
    request = new Request("https://resumatic.test/api/sources", { method: "POST", headers: { cookie: user.cookie }, body: form });
  } else {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set([73, 72, 68, 82], 12);
    new DataView(png.buffer).setUint32(16, 1);
    new DataView(png.buffer).setUint32(20, 1);
    request = new Request("https://resumatic.test/api/sources/source/ocr", {
      method: "POST", headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ images: [{ mimeType: "image/png", base64: btoa(String.fromCharCode(...png)) }] }),
    });
  }
  expect((await app.fetch(request, bindings)).status).toBe(500);
  expect(put).not.toHaveBeenCalled();
});

it("stores OCR input through the Vault using its reservation date", async () => {
  setModels(() => ({ ...fakeModels(), transcribePages: async () => ({ markdown: "Synthetic transcription." }) }));
  try {
    const user = await signIn();
    const original = await user.upload("resume.pdf", "synthetic");
    expect(original.status).toBe(201);
    const { sourceId: originalId } = await original.json() as { sourceId: string };
    await waitForSource(user, originalId);
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set([73, 72, 68, 82], 12);
    new DataView(png.buffer).setUint32(16, 1);
    new DataView(png.buffer).setUint32(20, 1);
    const images = [{ mimeType: "image/png", base64: btoa(String.fromCharCode(...png)) }];
    const response = await app.fetch(new Request(`https://resumatic.test/api/sources/${originalId}/ocr`, {
      method: "POST", headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ images }),
    }), { ...env, MODEL_TRANSCRIBE: "synthetic" });
    expect(response.status, await response.clone().text()).toBe(202);
    const { sourceId } = await response.json() as { sourceId: string };
    await waitForSource(user, sourceId);
    const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
    if (!session) throw new Error("missing session");
    const sourceVault = vault(env, session.vid);
    const info = await sourceVault.sourceFile({ userId: session.uid, gen: session.gen, epoch: session.epoch }, sourceId);
    const metadata = await sourceVault.sourceInfo(sourceId);
    const stored = await env.FILES.get(info.r2Key);
    expect(stored).not.toBeNull();
    expect(await stored!.json()).toEqual({ images, referenceDate: new Date(metadata.createdAt).toISOString().slice(0, 10) });
  } finally {
    setModels(null);
  }
}, 30_000);

it("blocks closure after dispatch authorization, even if the Worker crashes before its put", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: "fence-owner", gen: 1 };
  await stub.init(who.userId);
  const input = descriptor(stub.id.toString());
  await stub.reserveUpload(who, input);
  const attempt = crypto.randomUUID();
  await runInDurableObject(stub, async (instance, state) => {
    expect(instance.beginSourceWrite(who, input, attempt, "b".repeat(64))).toEqual({});
    await expect(instance.close()).rejects.toThrow("source write is unresolved");
    await expect(instance.destroy()).rejects.toThrow("source write is unresolved");
    expect(() => instance.beginSourceWrite(who, input, crypto.randomUUID(), "b".repeat(64))).toThrow(/gone/);
    expect(() => instance.finishCacheWrite("another-user", attempt)).toThrow(/forbidden/);
    expect(() => instance.finishCacheWrite(who.userId, attempt)).toThrow(/original acknowledgement/);
    await expect(instance.close()).rejects.toThrow("source write is unresolved");
    // Stand in for the owning Vault's acknowledged put; a Worker RPC cannot
    // settle this source marker, even after closure.
    state.storage.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, attempt);
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
  await runInDurableObject(stub, async (instance, state) => {
    instance.beginSourceWrite(who, input, first, "b".repeat(64));
    instance.beginSourceWrite(who, input, second, "b".repeat(64));
    state.storage.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, first);
    await expect(instance.close()).rejects.toThrow("source write is unresolved");
    state.storage.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, second);
    await expect(instance.close()).resolves.toEqual({ distill: [], tailor: [] });
  });
});

it("leaves the fence in place when R2 rejects a Vault-owned put", async () => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing session");
  const stub = vault(env, session.vid);
  const form = new FormData();
  form.set("file", new File(["synthetic"], "resume.pdf", { type: "application/pdf" }));
  await runInDurableObject(stub, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const originalFiles = local.FILES;
    local.FILES = { put: async () => { throw new Error("synthetic private provider detail"); } } as unknown as R2Bucket;
    try {
      const response = await app.fetch(new Request("https://resumatic.test/api/sources", {
        method: "POST", headers: { cookie: user.cookie }, body: form,
      }), env);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("synthetic private provider detail");
      const attempts = state.storage.sql.exec<{ attempt_id: string }>(`SELECT attempt_id FROM r2_cache_dispatches WHERE kind='source'`).toArray();
      expect(attempts).toHaveLength(1);
      expect(() => instance.finishCacheWrite(session.uid, attempts[0]!.attempt_id)).toThrow(/original acknowledgement/);
      await expect(instance.close()).rejects.toThrow("source write is unresolved");
    } finally {
      local.FILES = originalFiles;
    }
  });
});

it("waits for a late acknowledged Vault-owned put before allowing the vault to close", async () => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing session");
  const stub = vault(env, session.vid);
  let release!: () => void;
  let notify!: (key: string) => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<string>((resolve) => { notify = resolve; });
  await runInDurableObject(stub, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const originalFiles = local.FILES;
    local.FILES = {
      put: async (key: string, value: ArrayBuffer, options: R2PutOptions) => {
        notify(key);
        await held;
        return originalFiles.put(key, value, options);
      },
      delete: (key: string) => originalFiles.delete(key),
    } as unknown as R2Bucket;
    const form = new FormData();
    form.set("file", new File(["synthetic"], "resume.pdf", { type: "application/pdf" }));
    const request = Promise.resolve(app.fetch(new Request("https://resumatic.test/api/sources", {
      method: "POST", headers: { cookie: user.cookie }, body: form,
    }), env));
    try {
      const key = await started;
      instance.quiesce();
      await expect(instance.close()).rejects.toThrow("source write is unresolved");
      release();
      expect((await request).status).toBe(410);
      expect(await originalFiles.head(key)).toBeNull();
      await expect(instance.close()).resolves.toEqual({ distill: [], tailor: [] });
    } finally {
      release();
      await request.catch(() => {});
      local.FILES = originalFiles;
    }
  });
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
    expect(() => instance.beginSourceWrite(who, input, crypto.randomUUID(), "b".repeat(64))).toThrow("This file wasn't added. Upload it again.");
    // The put starts before expiry, but its acknowledgement arrives afterward.
    await env.FILES.put(input.r2Key, "late");
    state.storage.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, attempt);
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
    state.storage.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, linked);
    expect(state.storage.sql.exec(`SELECT source_id FROM source_write_links WHERE attempt_id=?`, linked).toArray()).toHaveLength(0);
    await instance.alarm();
    expect(await env.FILES.head(first.r2Key)).toBeNull();

    const fourth = { ...first, requestKey: "fourth", r2Key: `vaults/${stub.id}/sources/fourth` };
    await instance.reserveUpload(who, fourth);
    state.storage.sql.exec(`UPDATE upload_intents SET expires_at=0 WHERE request_key=?`, fourth.requestKey);
    await env.FILES.put(fourth.r2Key, "synthetic");
    const old = crypto.randomUUID();
    // A legacy or copy attempt has no trusted source link, even if it has a digest.
    state.storage.sql.exec(`INSERT INTO r2_cache_dispatches (attempt_id,kind,created_at,key_digest) VALUES (?,'source',?,?)`, old, Date.now(), "c".repeat(64));
    await instance.alarm();
    expect(await env.FILES.head(fourth.r2Key)).not.toBeNull();
    state.storage.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, old);
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
