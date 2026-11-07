import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directory, directoryByName } from "../../src/shared/stubs";
import { maintenance } from "../../src/worker/maintenance";
import { app } from "../../src/worker/routes";

const request = (email: string) => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }),
});

it("observes an unindexed legacy shard user without returning an email or identity", async () => {
  const email = `inventory-\u0130-${crypto.randomUUID()}@example.test`;
  const shard = directoryByName(env, "directory-7"), global = directory(env);
  const orphan = crypto.randomUUID(), deleting = crypto.randomUUID();
  await runInDurableObject(shard, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'active',?)`, orphan, `  ${email.toUpperCase()}  `, Date.now());
    // This deliberately has no coordinator home, as can happen with older writers.
    state.storage.sql.exec(`INSERT INTO identities(provider,subject,user_id) VALUES ('legacy',?,?)`, `subject-${orphan}`, orphan);
  });
  await runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'deleting',?)`, deleting, email, Date.now()),
  );
  const response = await maintenance.request("/invite-user-inventory", request(email), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const raw = await response.text();
  expect(raw).not.toContain(email);
  expect(raw).not.toContain(orphan);
  expect(raw).not.toContain(deleting);
  const result = JSON.parse(raw);
  expect(result).toMatchObject({ status: "pending", scope: "current_rows_only", complete: false });
  expect(result.observations).toHaveLength(17);
  expect(result.observations[0]).toMatchObject({ directory: "global", status: "observed", deleting: 1 });
  expect(result.observations[8]).toEqual({ directory: "directory-7", status: "observed", active: 1, deleting: 0 });
});

it("reports per-shard failure and invalid responses without returning error text", async () => {
  const seen: string[] = [];
  const mock = {
    DIRECTORY: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ inviteUserInventory: async () => {
        seen.push(name);
        if (name === "directory-3") throw new Error("private provider detail");
        if (name === "directory-5") return { status: "observed", active: -1, deleting: 0 };
        if (name === "directory-8") return { status: "row_limit" };
        return { status: "observed", active: 0, deleting: 0 };
      } }),
    },
  } as unknown as Env;
  const response = await maintenance.request("/invite-user-inventory", request("synthetic@example.test"), mock);
  expect(response.status).toBe(200);
  const raw = await response.text();
  expect(raw).not.toContain("private provider detail");
  const result = JSON.parse(raw);
  expect(seen).toHaveLength(17);
  expect(result).toMatchObject({ status: "pending", complete: false });
  expect(result.observations[4]).toEqual({ directory: "directory-3", status: "unavailable" });
  expect(result.observations[6]).toEqual({ directory: "directory-5", status: "unavailable" });
  expect(result.observations[9]).toEqual({ directory: "directory-8", status: "row_limit" });
});

it("does not let one stalled Directory suppress the other observations", async () => {
  const mock = {
    DIRECTORY: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ inviteUserInventory: () => name === "directory-2"
        ? new Promise(() => {})
        : Promise.resolve({ status: "observed", active: 0, deleting: 0 }) }),
    },
  } as unknown as Env;
  const response = await maintenance.request("/invite-user-inventory", request("synthetic@example.test"), mock);
  expect(response.status).toBe(200);
  const result = await response.json() as { status: string; complete: boolean; observations: { status: string }[] };
  expect(result.status).toBe("pending");
  expect(result.complete).toBe(false);
  expect(result.observations[3]?.status).toBe("unavailable");
  expect(result.observations.filter((item) => item.status === "observed")).toHaveLength(16);
}, 12_000);

it("refuses to report partial counts when the local user inventory is malformed or too large", async () => {
  const shard = directoryByName(env, "directory-12");
  await runInDurableObject(shard, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES ('bad',x'FF','active',?)`, Date.now());
  });
  expect(await shard.inviteUserInventory("synthetic@example.test")).toEqual({ status: "invalid_rows" });
  await runInDurableObject(shard, (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM users WHERE user_id='bad'`);
    state.storage.transactionSync(() => {
      for (let i = 0; i < 10_001; i++)
        state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'active',?)`, `synthetic-${i}`, `synthetic-${i}@example.test`, Date.now());
    });
  });
  expect(await shard.inviteUserInventory("synthetic@example.test")).toEqual({ status: "row_limit" });
}, 30_000);

it("rejects unauthenticated requests at the mounted admin route", async () => {
  const response = await app.fetch(new Request("https://resumatic.test/admin/invite-user-inventory", request("synthetic@example.test")), env);
  expect(response.status).toBe(403);
});
