import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { sourceKey } from "../../src/shared/r2";
import { vault } from "../../src/shared/stubs";
import { uploadDescriptorDigest, type UploadDescriptor } from "../../src/vault/uploads";
import { app } from "../../src/worker/routes";
import { readSession } from "../../src/worker/session";
import { signIn } from "./support";

const png = () => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, 1);
  new DataView(bytes.buffer).setUint32(20, 1);
  return btoa(String.fromCharCode(...bytes));
};
const arrayBuffer = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

async function setup() {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: crypto.randomUUID(), gen: 1 };
  await stub.init(who.userId);
  const originalFilename = "synthetic.pdf";
  const contentType = "application/pdf";
  const bytes = arrayBuffer("synthetic source bytes");
  const requestKey = "source-write";
  const descriptorDigest = await uploadDescriptorDigest({ filename: originalFilename, contentType }, bytes);
  const input: UploadDescriptor = {
    requestKey, descriptorDigest, filename: originalFilename, contentType, byteLength: bytes.byteLength,
    r2Key: sourceKey(stub.id.toString(), `${requestKey}-${descriptorDigest}`),
  };
  await stub.reserveUpload(who, input);
  return { stub, who, input, bytes, originalFilename };
}

describe("Vault-owned source writes", () => {
  it("stores the reserved bytes and clears only the acknowledged attempt", async () => {
    const { stub, who, input, bytes, originalFilename } = await setup();
    expect(await stub.writeReservedSource(who, input, bytes, originalFilename)).toEqual({});
    expect(await (await env.FILES.get(input.r2Key))!.text()).toBe("synthetic source bytes");
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT * FROM source_write_links`).toArray()).toEqual([]);
    });
  });

  it("rejects altered bytes, identity, key and size before any R2 put", async () => {
    const { stub, who, input, bytes, originalFilename } = await setup();
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      const put = vi.fn(async () => { throw new Error("unexpected put"); });
      local.FILES = { put } as unknown as R2Bucket;
      try {
        const changed = new Uint8Array(bytes.slice(0));
        changed[0] ^= 1;
        await expect(instance.writeReservedSource(who, input, changed.buffer, originalFilename)).rejects.toThrow(/contents do not match/);
        await expect(instance.writeReservedSource(who, input, bytes, "other.pdf")).rejects.toThrow(/contents do not match/);
        await expect(instance.writeReservedSource(who, { ...input, r2Key: input.r2Key + "-other" }, bytes, originalFilename)).rejects.toThrow(/already used with different input/);
        const noncanonical = { ...input, requestKey: "noncanonical", r2Key: sourceKey(stub.id.toString(), "not-the-canonical-key") };
        await instance.reserveUpload(who, noncanonical);
        await expect(instance.writeReservedSource(who, noncanonical, bytes, originalFilename)).rejects.toThrow(/invalid upload path/);
        await expect(instance.writeReservedSource(who, input, new ArrayBuffer(0), originalFilename)).rejects.toThrow(/invalid upload contents/);
        await expect(instance.writeReservedSource(who, input, new ArrayBuffer(10 * 1024 * 1024 + 1), originalFilename)).rejects.toThrow(/invalid upload contents/);
        await expect(instance.writeReservedSource(who, input, bytes, "x".repeat(8193))).rejects.toThrow(/invalid upload contents/);
        await expect(instance.writeReservedSource({ ...who, userId: "not-owner" }, input, bytes, originalFilename)).rejects.toThrow();
        expect(put).not.toHaveBeenCalled();
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches`).toArray()).toEqual([]);
      } finally { local.FILES = previous; }
    });
  });

  it("rejects missing reservations and oversized descriptor metadata before hashing", async () => {
    const { stub, who, input, bytes, originalFilename } = await setup();
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      const put = vi.fn(async () => { throw new Error("unexpected put"); });
      const digest = vi.spyOn(crypto.subtle, "digest");
      local.FILES = { put } as unknown as R2Bucket;
      try {
        const missing = { ...input, requestKey: "unreserved", r2Key: sourceKey(stub.id.toString(), `unreserved-${input.descriptorDigest}`) };
        await expect(instance.writeReservedSource(who, missing, bytes, originalFilename)).rejects.toThrow("reserve the upload before storing its file");
        await expect(instance.writeReservedSource(who, { ...input, filename: "x".repeat(201) }, bytes, originalFilename)).rejects.toThrow("invalid upload descriptor");
        await expect(instance.writeReservedSource(who, { ...input, contentType: "x".repeat(101) }, bytes, originalFilename)).rejects.toThrow("invalid upload descriptor");
        expect(digest).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
        expect(state.storage.sql.exec(`SELECT * FROM upload_intents WHERE request_key='unreserved'`).toArray()).toEqual([]);
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches`).toArray()).toEqual([]);
      } finally { digest.mockRestore(); local.FILES = previous; }
    });
  });

  it("does not overwrite a completed reservation", async () => {
    const { stub, who, input, bytes, originalFilename } = await setup();
    await env.FILES.put(input.r2Key, bytes);
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      const { source_id: sourceId } = sql.exec<{ source_id: string }>(`SELECT source_id FROM upload_intents WHERE request_key=?`, input.requestKey).one();
      sql.exec(`INSERT INTO sources (id,filename,r2_key,state,created_at) VALUES (?, ?, ?, 'ready', 1)`, sourceId, input.filename, input.r2Key);
      sql.exec(`UPDATE upload_intents SET state='complete' WHERE request_key=?`, input.requestKey);
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      const put = vi.fn(async () => { throw new Error("unexpected put"); });
      local.FILES = { put } as unknown as R2Bucket;
      try {
        expect(await instance.writeReservedSource(who, input, bytes, originalFilename)).toEqual({ sourceId });
        const altered = new Uint8Array(bytes.slice(0));
        altered[0] ^= 1;
        await expect(instance.writeReservedSource(who, input, altered.buffer, originalFilename)).rejects.toThrow(/contents do not match/);
        expect(put).not.toHaveBeenCalled();
        expect(sql.exec(`SELECT * FROM r2_cache_dispatches`).toArray()).toEqual([]);
      } finally { local.FILES = previous; }
    });
    expect(await (await env.FILES.get(input.r2Key))!.text()).toBe("synthetic source bytes");
  });

  it("rechecks the owner after hashing and does not dispatch after closure", async () => {
    const { stub, who, input, bytes, originalFilename } = await setup();
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      const put = vi.fn(async () => { throw new Error("unexpected put"); });
      const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let first = true;
      const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
        if (first) { first = false; entered(); await held; }
        return originalDigest(...args);
      });
      local.FILES = { put } as unknown as R2Bucket;
      const pending = instance.writeReservedSource(who, input, bytes, originalFilename).then(() => null, (error: Error) => error);
      try {
        await started;
        await expect(instance.close()).resolves.toEqual({ distill: [], tailor: [] });
        release();
        expect((await pending)?.message).toMatch(/account is being deleted|vault no longer exists/);
        expect(put).not.toHaveBeenCalled();
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches`).toArray()).toEqual([]);
      } finally {
        release();
        await pending;
        digest.mockRestore();
        local.FILES = previous;
      }
    });
  });

  it("retains an uncertain R2 put and blocks close and destruction", async () => {
    const { stub, who, input, bytes, originalFilename } = await setup();
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      const sensitive = "synthetic provider message containing career text";
      const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
      local.FILES = { put: async () => { throw new Error(sensitive); } } as unknown as R2Bucket;
      try {
        await expect(instance.writeReservedSource(who, input, bytes, originalFilename)).rejects.toThrow("unavailable: the upload outcome is unresolved");
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow("source write is unresolved");
        await expect(instance.destroy()).rejects.toThrow("source write is unresolved");
        expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(sensitive);
      } finally { for (const log of logs) log.mockRestore(); local.FILES = previous; }
    });
  });

  it.each(["null", "wrong-key", "wrong-size", "throwing-key"] as const)("retains the fence for an unexpected %s R2 acknowledgement", async (kind) => {
    const { stub, who, input, bytes, originalFilename } = await setup();
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      local.FILES = { put: async () => {
        if (kind === "null") return null;
        if (kind === "throwing-key") return { get key() { throw new Error("synthetic sensitive acknowledgement"); }, size: bytes.byteLength };
        return { key: kind === "wrong-key" ? "wrong-object" : input.r2Key, size: kind === "wrong-size" ? bytes.byteLength - 1 : bytes.byteLength };
      } } as unknown as R2Bucket;
      try {
        await expect(instance.writeReservedSource(who, input, bytes, originalFilename)).rejects.toThrow("upload outcome is unresolved");
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow("source write is unresolved");
      } finally { local.FILES = previous; }
    });
  });

  it("tracks concurrent retries separately and settles after a caller discards the result", async () => {
    const { stub, who, input, bytes, originalFilename } = await setup();
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      const waitUntil = vi.spyOn(state, "waitUntil");
      const releases: (() => void)[] = [];
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      local.FILES = {
        put: async (key: string, data: ArrayBuffer, options: R2PutOptions) => {
          await new Promise<void>((resolve) => { releases.push(resolve); if (releases.length === 2) entered(); });
          return previous.put(key, data, options);
        },
      } as unknown as R2Bucket;
      const first = instance.writeReservedSource(who, input, bytes, originalFilename);
      // Simulates a caller that loses the RPC response; this local test does not
      // prove production behavior after an actual client disconnect or reset.
      void first.catch(() => {});
      const second = instance.writeReservedSource(who, input, bytes, originalFilename);
      try {
        await started;
        expect(waitUntil).toHaveBeenCalledTimes(2);
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(2);
        await expect(instance.close()).rejects.toThrow("source write is unresolved");
        releases[0]!();
        // The first caller never consumes the result. Wait for its durable
        // settlement rather than awaiting the RPC promise.
        for (let i = 0; i < 100 && state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches WHERE kind='source'`).toArray().length !== 1; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(1);
        await expect(instance.destroy()).rejects.toThrow("source write is unresolved");
        releases[1]!();
        await second;
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toEqual([]);
        await expect(instance.close()).resolves.toEqual({ distill: [], tailor: [] });
      } finally {
        for (const release of releases) release();
        await Promise.allSettled([first, second]);
        waitUntil.mockRestore();
        local.FILES = previous;
      }
    });
  }, 30_000);

  it("validates OCR body and its reservation date before R2", async () => {
    const { stub, who } = await setup();
    const parent = "parent-ocr";
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO sources (id,filename,r2_key,state,created_at) VALUES (?, 'original.pdf', ?, 'ready', 1)`, parent, sourceKey(stub.id.toString(), "original"));
    });
    const metadata = { filename: "original.pdf (image transcription)", contentType: "application/json", origin: "ocr" as const, parentSourceId: parent };
    const images = { images: [{ mimeType: "image/png", base64: png() }] };
    const stable = JSON.stringify(images);
    const descriptorDigest = await uploadDescriptorDigest(metadata, stable);
    const requestKey = "ocr-write";
    const input: UploadDescriptor = { ...metadata, requestKey, descriptorDigest, byteLength: new TextEncoder().encode(stable).byteLength, r2Key: sourceKey(stub.id.toString(), `${requestKey}-${descriptorDigest}.ocr.json`) };
    const reservation = await stub.reserveUpload(who, input);
    const date = new Date(reservation.intent.createdAt).toISOString().slice(0, 10);
    const correct = arrayBuffer(JSON.stringify({ ...images, referenceDate: date }));
    const wrongDate = arrayBuffer(JSON.stringify({ ...images, referenceDate: "1900-01-01" }));
    const badImage = arrayBuffer(JSON.stringify({ images: [{ mimeType: "image/png", base64: "AAAA" }], referenceDate: date }));
    const bom = arrayBuffer(`\ufeff${JSON.stringify({ ...images, referenceDate: date })}`);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.FILES;
      const put = vi.fn((key: string, data: ArrayBuffer, options: R2PutOptions) => previous.put(key, data, options));
      local.FILES = { put } as unknown as R2Bucket;
      try {
        await expect(instance.writeReservedSource(who, input, wrongDate, metadata.filename)).rejects.toThrow(/invalid image transcription input/);
        await expect(instance.writeReservedSource(who, input, badImage, metadata.filename)).rejects.toThrow(/invalid image transcription input/);
        await expect(instance.writeReservedSource(who, input, bom, metadata.filename)).rejects.toThrow(/invalid image transcription input/);
        await expect(instance.writeReservedSource(who, input, new ArrayBuffer(12 * 1024 * 1024 + 1025), metadata.filename)).rejects.toThrow(/invalid upload contents/);
        expect(put).not.toHaveBeenCalled();
        await expect(instance.writeReservedSource(who, input, correct, metadata.filename)).resolves.toEqual({});
        expect(put).toHaveBeenCalledOnce();
        expect(state.storage.sql.exec(`SELECT * FROM r2_cache_dispatches`).toArray()).toEqual([]);
      } finally { local.FILES = previous; }
    });
  });

  it("does not fall back to a Worker R2 write when an old Vault lacks the RPC", async () => {
    const user = await signIn();
    const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
    if (!session) throw new Error("missing session");
    const real = vault(env, session.vid);
    const put = vi.fn(async () => { throw new Error("unsafe fallback"); });
    const bindings = {
      ...env,
      VAULT: {
        idFromString: (id: string) => env.VAULT.idFromString(id),
        get: () => ({
          checkSession: (who: Parameters<typeof real.checkSession>[0]) => real.checkSession(who),
          reserveUpload: (who: Parameters<typeof real.reserveUpload>[0], input: Parameters<typeof real.reserveUpload>[1]) => real.reserveUpload(who, input),
          // An old runtime has no writeReservedSource method.
        }),
      },
      FILES: { put },
    } as unknown as Env;
    const form = new FormData();
    form.set("file", new File(["synthetic"], "resume.pdf", { type: "application/pdf" }));
    const response = await app.fetch(new Request("https://resumatic.test/api/sources", { method: "POST", headers: { cookie: user.cookie }, body: form }), bindings);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(put).not.toHaveBeenCalled();
  });
});
