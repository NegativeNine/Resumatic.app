import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("unknown-end role dates", () => {
  it("keeps legacy date fields empty, preserves old null patches, and clears on a legacy dated edit", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "role-date-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const old = local.ROLE_UNKNOWN_END_ENABLED;
      local.ROLE_UNKNOWN_END_ENABLED = "true";
      try {
        expect((await instance.me(who)).capabilities?.roleDateUnknownEnd).toBe(true);
        const { roleId } = await instance.addRoleV2(who, {
          kind: "job", org: "Acme", title: "Engineer", startDate: null,
          endDate: null, unknownEndStartDate: "2020",
        });
        let role = (await instance.listRoles(who))[0]!;
        expect(role).toMatchObject({ startDate: null, endDate: null, unknownEndStartDate: "2020" });
        await instance.editRole(who, roleId, { org: "Acme Updated", startDate: null, endDate: null });
        role = (await instance.listRoles(who))[0]!;
        expect(role).toMatchObject({ org: "Acme Updated", startDate: null, unknownEndStartDate: "2020" });
        await expect(instance.editRoleV2(who, roleId, { startDate: "2021", endDate: null })).rejects.toThrow("unknown end");
        await instance.editRole(who, roleId, { startDate: "2021", endDate: null });
        role = (await instance.listRoles(who))[0]!;
        expect(role).toMatchObject({ startDate: "2021", endDate: null, unknownEndStartDate: null });
        await instance.editRoleV2(who, roleId, { startDate: null, endDate: null, unknownEndStartDate: "2022" });
        expect((await instance.listRoles(who))[0]).toMatchObject({ startDate: null, endDate: null, unknownEndStartDate: "2022" });
        await instance.editRoleV2(who, roleId, { unknownEndStartDate: null });
        expect((await instance.listRoles(who))[0]).toMatchObject({ startDate: null, endDate: null, unknownEndStartDate: null });
      } finally { local.ROLE_UNKNOWN_END_ENABLED = old; }
    });
  });
  it("keeps v2 writes disabled without the rollout flag", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "role-date-disabled", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.addRoleV2(who, { kind: "job", org: "Acme", title: null, startDate: null, endDate: null, unknownEndStartDate: "2020" })).rejects.toThrow("not enabled");
    });
    expect(await stub.listRoles(who)).toEqual([]);
  });
});

it("round-trips v2 role dates through HTTP and conservatively presents legacy dates", async () => {
  const { app } = await import("../../src/worker/routes");
  const { signIn } = await import("./support");
  const { readSession } = await import("../../src/worker/session");
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.split("=")[1]!);
  expect(session).not.toBeNull();
  const stub = vault(env, session!.vid);
  const previous = await runInDurableObject(stub, (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const old = local.ROLE_UNKNOWN_END_ENABLED;
    local.ROLE_UNKNOWN_END_ENABLED = "true";
    return old ?? null;
  });
  const enabledEnv = Object.assign(Object.create(env) as Env, { ROLE_UNKNOWN_END_ENABLED: "true" });
  const request = (method: string, path: string, body?: unknown) => app.fetch(new Request(`https://resumatic.test${path}`, {
    method, headers: { cookie: user.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), enabledEnv);
  try {
    expect((await (await request("GET", "/api/me")).json() as { capabilities: { roleDateUnknownEnd: boolean } }).capabilities.roleDateUnknownEnd).toBe(true);
    const created = await request("POST", "/api/v2/roles", { kind: "job", org: "Acme", title: "Engineer", startDate: null, endDate: null, unknownEndStartDate: "2020" });
    expect(created.status, await created.clone().text()).toBe(201);
    const { roleId } = await created.json() as { roleId: string };
    let response = await request("GET", "/api/roles");
    let role = (await response.json() as { roles: { id: string; startDate: string | null; endDate: string | null; unknownEndStartDate: string | null }[] }).roles.find((x) => x.id === roleId)!;
    expect(role).toMatchObject({ startDate: null, endDate: null, unknownEndStartDate: "2020" });
    expect((await request("PATCH", `/api/roles/${roleId}`, { org: "Acme Updated", startDate: null, endDate: null })).status).toBe(204);
    response = await request("GET", "/api/roles");
    role = (await response.json() as { roles: typeof role[] }).roles.find((x) => x.id === roleId)!;
    expect(role).toMatchObject({ startDate: null, endDate: null, unknownEndStartDate: "2020" });
    expect((await request("PATCH", `/api/v2/roles/${roleId}`, { startDate: null, endDate: null, unknownEndStartDate: "2022" })).status).toBe(204);
    response = await request("GET", "/api/roles");
    expect((await response.json() as { roles: typeof role[] }).roles.find((x) => x.id === roleId)).toMatchObject({ startDate: null, endDate: null, unknownEndStartDate: "2022" });
  } finally {
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Env }).env.ROLE_UNKNOWN_END_ENABLED = previous ?? undefined;
    });
  }
});
