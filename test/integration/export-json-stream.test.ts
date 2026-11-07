import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import { signIn } from "./support";

async function account() {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  return { user, session, stub: vault(env, session.vid) };
}

it("streams a consistent export captured before a later edit", async () => {
  const { user } = await account();
  expect((await user.send("PUT", "/api/profile", { name: "Before 😀" })).status).toBe(200);
  const response = await user.fetch("/api/export");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect((await user.send("PUT", "/api/profile", { name: "After" })).status).toBe(200);
  const captured = await response.json() as { profile: { name: string }; format: number };
  expect(captured.profile.name).toBe("Before 😀");
  expect(captured.format).toBe(2);
  expect((await user.json<{ profile: { name: string } }>("/api/export")).profile.name).toBe("After");
});

it("fails the remaining export stream after session revocation", async () => {
  const { user, session, stub } = await account();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.transactionSync(() => {
      for (let i = 0; i < 100; i++) state.storage.sql.exec(
        `INSERT INTO sources(id,filename,r2_key,state,created_at,markdown) VALUES (?,?,?,'ready',?,?)`,
        `source-${i}`, `synthetic-${i}.pdf`, `vaults/${session.vid}/sources/source-${i}`, Date.now(), "x".repeat(1000),
      );
    });
  });
  const response = await user.fetch("/api/export");
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  expect((await user.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
  let failed = false;
  for (let i = 0; i < 20; i++) {
    try { if ((await reader.read()).done) break; }
    catch { failed = true; break; }
  }
  expect(failed).toBe(true);
});
