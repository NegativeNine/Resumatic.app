import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { EXPORT_CACHE_ITEM_BYTES, EXPORT_CACHE_TOTAL_BYTES } from "../../src/vault/export-cache";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import { signIn } from "./support";

async function account() {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing session");
  const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
  return { who, stub: vault(env, session.vid), vid: session.vid };
}

it("stores actual binary chunks, verifies their digest, and treats corrupt bytes as a miss", async () => {
  const { who, stub, vid } = await account();
  const key = `vaults/${vid}/exports/resume-1.pdf`;
  expect(await stub.putExportCache(who, key, new TextEncoder().encode("abc"))).toBe(true);
  expect(new TextDecoder().decode((await stub.readExportCache(who, key))!)).toBe("abc");
  await runInDurableObject(stub, (_instance, state) => {
    const entry = state.storage.sql.exec<{ sha256: string }>(`SELECT sha256 FROM export_cache WHERE cache_key=?`, key).one();
    expect(entry.sha256).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    state.storage.sql.exec(`UPDATE export_cache_chunks SET bytes=? WHERE cache_key=?`, new TextEncoder().encode("xyz").buffer, key);
  });
  expect(await stub.readExportCache(who, key)).toBeNull();
  expect(await stub.putExportCache(who, key, new TextEncoder().encode("repaired"))).toBe(true);
  expect(new TextDecoder().decode((await stub.readExportCache(who, key))!)).toBe("repaired");
});

it("bounds storage, evicts least recently used entries, and skips oversized documents", async () => {
  const { who, stub, vid } = await account();
  const key = (n: number) => `vaults/${vid}/exports/resume-${n}.pdf`;
  const large = new Uint8Array(EXPORT_CACHE_ITEM_BYTES).fill(42);
  const count = EXPORT_CACHE_TOTAL_BYTES / EXPORT_CACHE_ITEM_BYTES;
  for (let i = 0; i < count; i++) expect(await stub.putExportCache(who, key(i), large)).toBe(true);
  await runInDurableObject(stub, (_instance, state) => {
    for (let i = 0; i < count; i++) state.storage.sql.exec(`UPDATE export_cache SET accessed_at=? WHERE cache_key=?`, i + 1, key(i));
  });
  expect(await stub.putExportCache(who, key(9), new Uint8Array([9]))).toBe(true);
  expect(await stub.readExportCache(who, key(0))).toBeNull();
  expect((await stub.readExportCache(who, key(1)))?.length).toBe(EXPORT_CACHE_ITEM_BYTES);
  expect(await stub.putExportCache(who, key(10), new Uint8Array(EXPORT_CACHE_ITEM_BYTES + 1))).toBe(false);
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec<{ total: number }>(`SELECT SUM(size) AS total FROM export_cache`).one().total).toBeLessThanOrEqual(EXPORT_CACHE_TOTAL_BYTES);
    expect(state.storage.sql.exec(`SELECT cache_key FROM export_cache WHERE cache_key=?`, key(10)).toArray()).toHaveLength(0);
  });
}, 60_000);

it("cannot write or return cached bytes after closure during hashing", async () => {
  const { who, stub, vid } = await account();
  const key = `vaults/${vid}/exports/resume-1.docx`;
  await runInDurableObject(stub, async (instance, state) => {
    const pending = instance.putExportCache(who, key, new Uint8Array(1024));
    instance.quiesce();
    await expect(pending).rejects.toThrow("account is being deleted");
    expect(state.storage.sql.exec(`SELECT cache_key FROM export_cache`).toArray()).toHaveLength(0);
    await expect(instance.readExportCache(who, key)).rejects.toThrow("account is being deleted");
  });
});

it("does not include regenerable export caches in a replacement manifest", async () => {
  const { who, stub, vid } = await account();
  await stub.putExportCache(who, `vaults/${vid}/exports/resume-1.pdf`, new Uint8Array([1]));
  await runInDurableObject(stub, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = vid;
    try {
      const manifest = await instance.transferManifest("cache-test");
      expect(manifest.tables.map((table) => table.name)).not.toContain("export_cache");
      expect(manifest.tables.map((table) => table.name)).not.toContain("export_cache_chunks");
    } finally { local.RESTORE_FENCE_IDS = previous; }
  });
});

it("removes cache manifests and chunks during account destruction", async () => {
  const { who, stub, vid } = await account();
  await stub.putExportCache(who, `vaults/${vid}/exports/resume-1.pdf`, new Uint8Array([1, 2, 3]));
  await runInDurableObject(stub, async (instance, state) => {
    expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM export_cache_chunks`).one().n).toBe(1);
    instance.quiesce();
    await instance.destroy();
    expect(await instance.deletionProbe()).toEqual({ rows: 0 });
    expect(state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('export_cache', 'export_cache_chunks')`).toArray()).toHaveLength(0);
  });
});
