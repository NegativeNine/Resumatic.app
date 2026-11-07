import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { unzipSync } from "fflate";
import { expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import { signIn } from "../integration/support";

it("exports a valid ZIP whose JSON snapshot exceeds the serialized RPC limit", async () => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  const stub = vault(env, session.vid);
  await runInDurableObject(stub, (_instance, state) => {
    const text = "x".repeat(768 * 1024);
    state.storage.transactionSync(() => {
      // Every individual synthetic row remains under the SQLite value limit.
      for (let i = 0; i < 45; i++)
        state.storage.sql.exec(`INSERT INTO roles(id,kind,org,state) VALUES (?,'job',?,'proposed')`, `large-role-${i}`, text);
    });
  });
  const response = await user.fetch("/api/export/archive");
  expect(response.status).toBe(200);
  const zip = new Uint8Array(await response.arrayBuffer());
  const json = unzipSync(zip)["vault.json"];
  expect(json).toBeDefined();
  expect(json!.byteLength).toBeGreaterThan(32 * 1024 * 1024);
  const data = JSON.parse(new TextDecoder().decode(json!)) as { roles: { id: string; org: string }[] };
  expect(data.roles).toHaveLength(45);
  expect(data.roles[0]!.org).toHaveLength(768 * 1024);
}, 120_000);
