import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { directory, vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { signIn } from "./support";

function session(cookie: string): { uid: string; vid: string } {
  const encoded = cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(encoded)));
}

it("quiesces a preparing target before acknowledging account deletion", async () => {
  const user = await signIn();
  const { uid, vid } = session(user.cookie);
  const d = directory(env);
  const operation = crypto.randomUUID();
  const { targetVaultId } = await d.prepareReplacement(vid, operation);
  const source = vault(env, vid);
  const target = vault(env, targetVaultId);
  const ids = `${vid},${targetVaultId}`;
  const originalFence = await runInDurableObject(source, (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const before = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = ids;
    state.storage.sql.exec(
      `INSERT INTO sources (id,filename,r2_key,state,created_at) VALUES ('s','resume.pdf',?,'ready',1)`,
      `vaults/${vid}/sources/s`,
    );
    return before;
  });
  try {
    const { manifest, pages } = await runInDurableObject(source, async (instance) => {
      const manifest = await instance.transferManifest(operation);
      const pages = [];
      for (const { name } of manifest.tables) pages.push(await instance.transferPage(operation, name));
      return { manifest, pages };
    });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const cancel = vi.fn();
    const put = vi.fn();
    const running = runInDurableObject(target, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const previousFence = local.RESTORE_FENCE_IDS;
      const previousFiles = local.FILES;
      local.RESTORE_FENCE_IDS = ids;
      local.FILES = {
        get: async () => { entered(); await hold; return { body: new ReadableStream({ cancel }) }; },
        put,
      } as unknown as R2Bucket;
      let pending: Promise<unknown> | undefined;
      try {
        await instance.importManifest(manifest);
        for (const page of pages) await instance.importPage(page);
        pending = instance.finishImport(operation, vid).then(() => null, (error: Error) => error);
        await started;
        await directory(local).deleteAccount(uid, vid);
        release();
        return await pending;
      } finally {
        release();
        await pending?.catch(() => {});
        local.FILES = previousFiles;
        local.RESTORE_FENCE_IDS = previousFence;
      }
    });
    try {
      const result = await running;
      expect((result as Error).message).toMatch(/account is being deleted/);
      expect(cancel).toHaveBeenCalledOnce();
      expect(put).not.toHaveBeenCalled();
    } finally { release(); await running.catch(() => {}); }
  } finally {
    await runInDurableObject(source, (instance) => {
      (instance as unknown as { env: Env }).env.RESTORE_FENCE_IDS = originalFence;
    });
  }
}, 20_000);

it("attempts target quiescence when the active Vault fails, and leaves durable deletion retryable", async () => {
  const user = await signIn();
  const { uid, vid } = session(user.cookie);
  const d = directory(env);
  const { targetVaultId } = await d.prepareReplacement(vid, crypto.randomUUID());
  const target = vault(env, targetVaultId);
  await runInDurableObject(d, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const original = local.VAULT;
    local.VAULT = {
      idFromString: (id: string) => original.idFromString(id),
      get: (id: DurableObjectId) => id.toString() === vid
        ? { quiesceForAccountDeletion: async () => { throw new Error("synthetic source outage"); } }
        : original.get(id),
    } as unknown as typeof original;
    try {
      await expect(instance.deleteAccount(uid, vid)).rejects.toThrow("synthetic source outage");
    } finally { local.VAULT = original; }
  });
  expect(await runInDurableObject(target, (_instance, state) =>
    state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='state'`).one().value,
  )).toBe("closing");
  const persisted = await runInDurableObject(d, async (_instance, state) => ({
    status: state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, vid).one().state,
    target: state.storage.sql.exec<{ state: string }>(`SELECT state FROM retired_vaults WHERE vault_id=?`, targetVaultId).one().state,
    alarm: await state.storage.getAlarm(),
  }));
  expect(persisted).toMatchObject({ status: "deleting", target: "deleting", alarm: expect.any(Number) });
  await expect(d.deleteAccount(uid, vid)).resolves.toBeUndefined();
  expect(await runInDurableObject(vault(env, vid), (_instance, state) =>
    state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='state'`).one().value,
  )).toBe("closing");
}, 20_000);

it("keeps source access closed and retries when target quiescence fails", async () => {
  const user = await signIn();
  const { uid, vid } = session(user.cookie);
  const d = directory(env);
  const { targetVaultId } = await d.prepareReplacement(vid, crypto.randomUUID());
  await runInDurableObject(d, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const original = local.VAULT;
    local.VAULT = {
      idFromString: (id: string) => original.idFromString(id),
      get: (id: DurableObjectId) => id.toString() === targetVaultId
        ? { quiesceForRetirement: async () => { throw new Error("synthetic target outage"); } }
        : original.get(id),
    } as unknown as typeof original;
    try {
      await expect(instance.deleteAccount(uid, vid)).rejects.toThrow("synthetic target outage");
    } finally { local.VAULT = original; }
  });
  const sourceState = await runInDurableObject(vault(env, vid), (_instance, state) =>
    state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='state'`).one().value,
  );
  expect(sourceState).toBe("closing");
  expect(await runInDurableObject(d, (_instance, state) => state.storage.getAlarm())).toEqual(expect.any(Number));
  await expect(d.deleteAccount(uid, vid)).resolves.toBeUndefined();
  expect(await runInDurableObject(vault(env, targetVaultId), (_instance, state) =>
    state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='state'`).one().value,
  )).toBe("closing");
}, 20_000);
