import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import { signIn } from "../integration/support";

it("streams a synthetic aggregate above the RPC value limit", async () => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  const stub = vault(env, session.vid);
  await runInDurableObject(stub, (_instance, state) => {
    const synthetic = "x".repeat(768 * 1024);
    state.storage.transactionSync(() => {
      // Individually each row remains below the SQLite value limit. These
      // artificial values test transport, not the public input-size limits.
      for (let i = 0; i < 45; i++)
        state.storage.sql.exec(`INSERT INTO roles(id,kind,org,state) VALUES (?,'job',?,'proposed')`, `large-role-${i}`, synthetic);
    });
  });
  const response = await user.fetch("/api/v2/vault");
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let bytes = 0;
  let chunks = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    chunks++;
  }
  expect(bytes).toBeGreaterThan(32 * 1024 * 1024);
  expect(chunks).toBeGreaterThan(1);
}, 60_000);
