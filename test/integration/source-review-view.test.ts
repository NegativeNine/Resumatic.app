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

it("captures queued source state with its own items before a later ready transition", async () => {
  const { user, session, stub } = await account();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO sources(id,filename,r2_key,state,created_at) VALUES ('source','synthetic.pdf',?,'queued',?)`, `vaults/${session.vid}/sources/source`, Date.now());
  });
  const before = await user.fetch("/api/v2/vault");
  expect(before.status).toBe(200);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.transactionSync(() => {
      state.storage.sql.exec(`INSERT INTO roles(id,kind,org,title,state,source_id) VALUES ('role','job','Example','Engineer','proposed','source')`);
      state.storage.sql.exec(`INSERT INTO facts(id,role_id,kind,text,source_id,origin,state,updated_at) VALUES ('fact','role','accomplishment','Built a synthetic service','source','user','proposed',?)`, Date.now());
      state.storage.sql.exec(`UPDATE sources SET state='ready' WHERE id='source'`);
    });
  });
  const old = await before.json() as { sources: { state: string }[]; roles: unknown[]; facts: unknown[] };
  expect(old.sources[0]!.state).toBe("queued");
  expect(old.roles).toEqual([]);
  expect(old.facts).toEqual([]);
  const next = await user.json("/api/v2/vault") as { sources: { state: string; proposed: number }[]; roles: { id: string }[]; facts: { id: string }[] };
  expect(next.sources[0]).toMatchObject({ state: "ready", proposed: 1 });
  expect(next.roles.map((role) => role.id)).toEqual(["role"]);
  expect(next.facts.map((fact) => fact.id)).toEqual(["fact"]);
});

it("does not release further review bytes after session revocation fails the stream check", async () => {
  const { user, session, stub } = await account();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.transactionSync(() => {
      state.storage.sql.exec(`INSERT INTO sources(id,filename,r2_key,state,created_at) VALUES ('source','synthetic.pdf',?,'ready',?)`, `vaults/${session.vid}/sources/source`, Date.now());
      for (let i = 0; i < 100; i++)
        state.storage.sql.exec(`INSERT INTO facts(id,kind,text,source_id,origin,state,updated_at) VALUES (?,'accomplishment',?,'source','user','proposed',?)`, `fact-${i}`, `Synthetic ${i} ${"x".repeat(700)}`, Date.now());
    });
  });
  const response = await user.fetch("/api/v2/vault");
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(first.value!.byteLength).toBeGreaterThan(0);
  expect((await user.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
  // A transport can already have buffered a chunk before revocation. Drain
  // any such bytes and verify that the guarded stream then fails, rather than
  // presenting a complete JSON response after the failed session check.
  let failure: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      if ((await reader.read()).done) break;
    } catch (error) {
      failure = error;
      break;
    }
  }
  expect(failure).toBeDefined();
});
