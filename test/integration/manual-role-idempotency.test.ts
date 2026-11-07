import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import type { NewRole } from "../../src/shared/api";
import { signIn, type User } from "./support";

const body: NewRole = { kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null };
function create(user: User, key: string, role: NewRole = body): Promise<Response> {
  return user.fetch("/api/v3/roles", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(role),
  });
}

describe("manual role request idempotency", () => {
  it("replays the saved role, rejects changed input, and permits a new action", async () => {
    const user = await signIn();
    const first = await create(user, "role-request");
    expect(first.status).toBe(201);
    const saved = await first.json();
    const retry = await create(user, "role-request");
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(saved);
    expect((await create(user, "role-request", { ...body, org: "Other" })).status).toBe(409);
    expect((await create(user, "role-request", { ...body, unknownEndStartDate: null })).status).toBe(409);
    expect((await user.json("/api/roles")).roles).toHaveLength(1);
    const second = await create(user, "fresh-request");
    expect(second.status).toBe(201);
    expect(await second.json()).not.toEqual(saved);
    expect((await user.json("/api/roles")).roles).toHaveLength(2);
  });

  it("deduplicates concurrent requests and rejects conflicting use of one key", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "role-race", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const [first, second] = await Promise.all([
        instance.addRoleIdempotent(who, body, "same-key", false),
        instance.addRoleIdempotent(who, body, "same-key", false),
      ]);
      expect(first).toEqual(second);
      const results = await Promise.allSettled([
        instance.addRoleIdempotent(who, body, "different-key", false),
        instance.addRoleIdempotent(who, { ...body, org: "Different" }, "different-key", false),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await instance.listRoles(who)).toHaveLength(2);
    });
  });

  it("scopes keys to the vault and preserves legacy routes", async () => {
    const alice = await signIn(), bob = await signIn();
    const [a, b] = await Promise.all([create(alice, "same-key"), create(bob, "same-key")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await a.json()).not.toEqual(await b.json());
    expect((await alice.send("POST", "/api/roles", { ...body, org: "Legacy" })).status).toBe(201);
  });

  it("gates unknown-end writes and preserves them across retries", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "role-date-retry", gen: 1 };
    await stub.init(who.userId);
    const input: NewRole = { ...body, startDate: null, unknownEndStartDate: "2021" };
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const prior = local.ROLE_UNKNOWN_END_ENABLED;
      try {
        local.ROLE_UNKNOWN_END_ENABLED = "false";
        await expect(instance.addRoleIdempotent(who, input, "unknown", true)).rejects.toThrow("not enabled");
        local.ROLE_UNKNOWN_END_ENABLED = "true";
        const result = await instance.addRoleIdempotent(who, input, "unknown", true);
        expect(await instance.addRoleIdempotent(who, input, "unknown", true)).toEqual(result);
        await expect(instance.addRoleIdempotent(who, { ...input, unknownEndStartDate: "2022" }, "unknown", true)).rejects.toThrow("changed");
        expect((await instance.listRoles(who))[0]).toMatchObject({ id: result.roleId, startDate: null, endDate: null, unknownEndStartDate: "2021" });
        local.ROLE_UNKNOWN_END_ENABLED = "false";
        // A retry of an already committed direct RPC is harmless even when the feature is disabled.
        expect(await instance.addRoleIdempotent(who, input, "unknown", true)).toEqual(result);
      } finally { local.ROLE_UNKNOWN_END_ENABLED = prior; }
    });
    const user = await signIn();
    expect((await create(user, "disabled", input)).status).toBe(503);
  });
});

it("requires both feature flags for new unknown-end roles but can replay after rollback", async () => {
  const { app } = await import("../../src/worker/routes");
  const { readSession } = await import("../../src/worker/session");
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.split("=")[1]!);
  expect(session).not.toBeNull();
  const stub = vault(env, session!.vid);
  const prior = await runInDurableObject(stub, (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const old = local.ROLE_UNKNOWN_END_ENABLED;
    local.ROLE_UNKNOWN_END_ENABLED = "true";
    return old ?? null;
  });
  const role: NewRole = { ...body, startDate: null, unknownEndStartDate: "2021" };
  const request = (workerEnabled: boolean, key: string) => app.fetch(new Request("https://resumatic.test/api/v3/roles", {
    method: "POST", headers: { cookie: user.cookie, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(role),
  }), Object.assign(Object.create(env) as Env, { ROLE_UNKNOWN_END_ENABLED: workerEnabled ? "true" : "false" }));
  try {
    // The test runtime exposes a shared environment proxy, so test divergent
    // Worker/Vault configuration through the real Vault RPC method directly.
    await runInDurableObject(stub, async (instance) => {
      const who = { userId: session!.uid, gen: session!.gen, epoch: session!.epoch };
      await expect(instance.addRoleIdempotent(who, role, "worker-off-direct", false)).rejects.toThrow("not enabled");
    });
    // The Worker passes its current flag through the HTTP path.
    expect((await request(false, "worker-off")).status).toBe(503);
    const created = await request(true, "committed");
    expect(created.status).toBe(201);
    const original = await created.json();
    // Returning a committed ID performs no feature-dependent write.
    const replay = await request(false, "committed");
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(original);
    // Exercise a Vault on an older configuration directly: the local Worker
    // harness otherwise shares bindings and cannot represent both versions.
    await runInDurableObject(stub, async (instance) => {
      (instance as unknown as { env: Env }).env.ROLE_UNKNOWN_END_ENABLED = "false";
      const who = { userId: session!.uid, gen: session!.gen, epoch: session!.epoch };
      await expect(instance.addRoleIdempotent(who, role, "vault-off", true)).rejects.toThrow("not enabled");
      expect(await instance.addRoleIdempotent(who, role, "committed", true)).toEqual(original);
    });
    expect((await user.json("/api/roles")).roles).toHaveLength(1);
  } finally {
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Env }).env.ROLE_UNKNOWN_END_ENABLED = prior ?? undefined;
    });
  }
});
