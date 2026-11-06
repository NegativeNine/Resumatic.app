import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { vaultPrefix } from "../../src/shared/r2";
import { directory } from "../../src/shared/stubs";
import { signIn } from "./support";

it("keeps account deletion pending when a fresh listing finds a visible write during the sweep", async () => {
  const user = await signIn();
  const body = user.cookie.slice("__Host-session=".length).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/");
  const { vid } = JSON.parse(atob(body + "===".slice((body.length + 3) % 4))) as { vid: string };
  const prefix = vaultPrefix(vid);
  await env.FILES.put(`${prefix}sources/initial`, "synthetic");
  expect((await user.send("DELETE", "/auth/account")).status).toBe(202);

  await runInDurableObject(directory(env), async (instance, state) => {
    const bindings = (instance as unknown as { env: Env }).env;
    const original = bindings.FILES;
    let injections = 0;
    bindings.FILES = {
      list: original.list.bind(original),
      async delete(keys: string | string[]) {
        await original.delete(keys);
        if (injections < 2) {
          injections++;
          // The first write arrives during the provisional sweep, and the
          // second arrives during the authoritative post-close sweep. Both
          // are visible before their respective confirmation lists. Neither
          // models or settles a later, still-in-flight write.
          await original.put(`${prefix}sources/arrived-during-sweep`, "synthetic");
        }
      },
    } as R2Bucket;
    try {
      await instance.alarm();
      expect(injections).toBe(2);
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, vid).one().state).toBe("deleting");
      expect(await original.head(`${prefix}sources/arrived-during-sweep`)).not.toBeNull();
      await instance.alarm();
      const remaining = await original.list({ prefix });
      expect(remaining.objects).toEqual([]);
      const row = state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, vid).toArray()[0];
      expect(row === undefined || row.state === "swept").toBe(true);
    } finally {
      bindings.FILES = original;
    }
  });
});
