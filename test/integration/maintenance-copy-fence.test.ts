import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Vault } from "../../src/vault/vault";

async function withImport(check: (instance: Vault, state: DurableObjectState, files: R2Bucket, operationId: string, sourceId: string) => Promise<void>) {
  const source = env.VAULT.get(env.VAULT.newUniqueId());
  const target = env.VAULT.get(env.VAULT.newUniqueId());
  await source.init("copy-owner");
  await target.init("copy-owner");
  const sourceId = source.id.toString();
  const ids = `${source.id},${target.id}`;
  const previous = await runInDurableObject(source, (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const before = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = ids;
    state.storage.sql.exec(`INSERT INTO sources (id,filename,r2_key,state,created_at) VALUES ('s','resume.pdf',?,'ready',1)`, `vaults/${sourceId}/sources/s`);
    return before;
  });
  try {
    await env.FILES.put(`vaults/${sourceId}/sources/s`, "synthetic source");
    const { manifest, pages } = await runInDurableObject(source, async (instance) => {
      const manifest = await instance.transferManifest("copy-fence");
      const pages = [];
      for (const table of manifest.tables) {
        let after = 0;
        for (;;) {
          const page = await instance.transferPage(manifest.operationId, table.name, after, 50);
          pages.push(page);
          if (page.done) break;
          after = page.lastRowid;
        }
      }
      return { manifest, pages };
    });
    await runInDurableObject(target, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const oldFence = local.RESTORE_FENCE_IDS;
      const files = local.FILES;
      local.RESTORE_FENCE_IDS = ids;
      try {
        await instance.importManifest(manifest);
        for (const page of pages) await instance.importPage(page);
        await check(instance, state, files, manifest.operationId, sourceId);
      } finally {
        local.FILES = files;
        local.RESTORE_FENCE_IDS = oldFence;
      }
    });
  } finally {
    await runInDurableObject(source, (instance) => {
      (instance as unknown as { env: Env }).env.RESTORE_FENCE_IDS = previous;
    });
  }
}

it("blocks target deletion until an in-flight copy acknowledges, then rejects continuation after closure", async () => {
  await withImport(async (instance, state, files, operationId, sourceId) => {
    const local = (instance as unknown as { env: Env }).env;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    local.FILES = {
      get: (key: string) => files.get(key),
      put: async (key: string, bytes: ArrayBuffer, options: R2PutOptions) => {
        entered(); await held; return files.put(key, bytes, options);
      },
      head: (key: string) => files.head(key),
    } as unknown as R2Bucket;
    const pending = instance.finishImport(operationId, sourceId).then(() => null, (error: Error) => error);
    try {
      await started;
      expect(state.storage.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(1);
      await expect(instance.close()).rejects.toThrow("source write is unresolved");
      await expect(instance.destroy()).rejects.toThrow("source write is unresolved");
      release();
      expect((await pending)?.message).toMatch(/account is being deleted/);
      expect(state.storage.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(0);
      await expect(instance.close()).resolves.toEqual({ distill: [], tailor: [] });
    } finally { release(); await pending; }
  });
}, 30_000);

it("keeps a lost copy acknowledgement fenced even if a later copy succeeds", async () => {
  await withImport(async (instance, state, files, operationId, sourceId) => {
    const local = (instance as unknown as { env: Env }).env;
    let calls = 0;
    local.FILES = {
      get: (key: string) => files.get(key),
      put: async (key: string, bytes: ArrayBuffer, options: R2PutOptions) => {
        const result = await files.put(key, bytes, options);
        if (++calls === 1) throw new Error("synthetic lost copy acknowledgement");
        return result;
      },
      head: (key: string) => files.head(key),
    } as unknown as R2Bucket;
    await expect(instance.finishImport(operationId, sourceId)).rejects.toThrow("synthetic lost copy acknowledgement");
    await expect(instance.finishImport(operationId, sourceId)).rejects.toThrow("source write is unresolved");
    expect(calls).toBe(2);
    expect(state.storage.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(1);
    await expect(instance.close()).rejects.toThrow("source write is unresolved");
  });
}, 30_000);

it("allows a concurrent retry to complete only after every copy settles", async () => {
  await withImport(async (instance, state, files, operationId, sourceId) => {
    const local = (instance as unknown as { env: Env }).env;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    local.FILES = {
      get: (key: string) => files.get(key),
      put: async (key: string, bytes: ArrayBuffer, options: R2PutOptions) => {
        if (++calls === 1) { entered(); await held; }
        return files.put(key, bytes, options);
      },
      head: (key: string) => files.head(key),
    } as unknown as R2Bucket;
    const first = instance.finishImport(operationId, sourceId);
    try {
      await started;
      await expect(instance.finishImport(operationId, sourceId)).rejects.toThrow("source write is unresolved");
      expect(state.storage.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(1);
      release();
      expect(await first).toMatchObject({ state: "ready" });
      expect(await instance.finishImport(operationId, sourceId)).toMatchObject({ state: "ready" });
      expect(calls).toBe(2);
      expect(state.storage.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE kind='source'`).toArray()).toHaveLength(0);
    } finally { release(); await first.catch(() => {}); }
  });
}, 30_000);
