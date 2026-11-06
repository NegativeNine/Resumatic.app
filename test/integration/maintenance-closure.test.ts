import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";

it("stops an export when its Vault closes while the page digest is in flight", async () => {
  const vault = env.VAULT.get(env.VAULT.newUniqueId());
  await vault.init("owner");
  await runInDurableObject(vault, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = vault.id.toString();
    try {
      const manifest = await instance.transferManifest("move-closure");
      const pending = instance.transferPage(manifest.operationId, "profile");
      instance.quiesce();
      await expect(pending).rejects.toThrow(/account is being deleted/);
      await expect(instance.transferPage(manifest.operationId, "profile")).rejects.toThrow(/account is being deleted/);
      await expect(instance.controlCheckpoint()).rejects.toThrow(/account is being deleted/);
      await expect(instance.prepareMaintenance()).rejects.toThrow(/account is being deleted/);
    } finally { local.RESTORE_FENCE_IDS = previous; }
  });
});

it("does not commit an import page after its Vault closes during checksum verification", async () => {
  const source = env.VAULT.get(env.VAULT.newUniqueId());
  const target = env.VAULT.get(env.VAULT.newUniqueId());
  await source.init("owner");
  await target.init("owner");
  const { manifest, page } = await runInDurableObject(source, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = source.id.toString();
    try {
      const manifest = await instance.transferManifest("move-import-closure");
      const page = await instance.transferPage(manifest.operationId, "profile");
      return { manifest, page };
    } finally { local.RESTORE_FENCE_IDS = previous; }
  });
  await runInDurableObject(target, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = target.id.toString();
    try {
      await instance.importManifest(manifest);
      const pending = instance.importPage(page);
      instance.quiesce();
      await expect(pending).rejects.toThrow(/account is being deleted/);
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM profile").one().n).toBe(0);
    } finally { local.RESTORE_FENCE_IDS = previous; }
  });
});

it("cancels an original's body when the target closes while R2 get is in flight", async () => {
  const source = env.VAULT.get(env.VAULT.newUniqueId());
  const target = env.VAULT.get(env.VAULT.newUniqueId());
  await source.init("owner");
  await target.init("owner");
  const ids = `${source.id},${target.id}`;
  const sourceEnv = await runInDurableObject(source, (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = ids;
    state.storage.sql.exec(
      `INSERT INTO sources (id,filename,r2_key,state,created_at) VALUES ('s','resume.pdf',?,'ready',1)`,
      `vaults/${source.id}/sources/s`,
    );
    return previous;
  });
  try {
    const { manifest, pages } = await runInDurableObject(source, async (instance) => {
      const manifest = await instance.transferManifest("move-fetch-closure");
      const pages = [];
      for (const { name } of manifest.tables) pages.push(await instance.transferPage(manifest.operationId, name));
      return { manifest, pages };
    });
    await runInDurableObject(target, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const previousFence = local.RESTORE_FENCE_IDS;
      const previousFiles = local.FILES;
      local.RESTORE_FENCE_IDS = ids;
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const cancel = vi.fn();
      const put = vi.fn();
      local.FILES = {
        get: async () => {
          entered();
          await waiting;
          return { body: new ReadableStream({ cancel }) };
        },
        put,
      } as unknown as R2Bucket;
      try {
        await instance.importManifest(manifest);
        for (const page of pages) await instance.importPage(page);
        const pending = instance.finishImport(manifest.operationId, source.id.toString());
        const outcome = pending.then(() => null, (error: Error) => error);
        await started;
        instance.quiesce();
        release();
        expect((await outcome)?.message).toMatch(/account is being deleted/);
        expect(cancel).toHaveBeenCalledOnce();
        expect(put).not.toHaveBeenCalled();
      } finally {
        release();
        local.FILES = previousFiles;
        local.RESTORE_FENCE_IDS = previousFence;
      }
    });
  } finally {
    await runInDurableObject(source, (instance) => {
      (instance as unknown as { env: Env }).env.RESTORE_FENCE_IDS = sourceEnv;
    });
  }
});
