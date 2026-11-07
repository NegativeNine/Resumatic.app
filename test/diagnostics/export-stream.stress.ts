import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import { signIn } from "../integration/support";

it("streams a synthetic export larger than the serialized RPC limit", async () => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  const stub = vault(env, session.vid);
  await runInDurableObject(stub, (_instance, state) => {
    const synthetic = "x".repeat(768 * 1024);
    state.storage.transactionSync(() => {
      // Each artificial row is under the SQLite value limit.
      for (let i = 0; i < 45; i++) state.storage.sql.exec(
        `INSERT INTO sources(id,filename,r2_key,state,created_at,markdown) VALUES (?,?,?,'ready',?,?)`,
        `large-source-${i}`, `synthetic-${i}.pdf`, `vaults/${session.vid}/sources/${i}`, Date.now(), synthetic,
      );
    });
  });
  const response = await user.fetch("/api/export");
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let bytes = 0, chunks = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    chunks++;
  }
  expect(bytes).toBeGreaterThan(32 * 1024 * 1024);
  expect(chunks).toBeGreaterThan(1);
}, 90_000);
