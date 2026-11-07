import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { JOB_DESCRIPTION, signIn, type User } from "./support";

function create(user: User, key: string, jdText = JOB_DESCRIPTION): Promise<Response> {
  return user.fetch("/api/v2/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ jdText }),
  });
}

describe("job request idempotency", () => {
  it("replays a committed job, rejects changed input, and accepts a new action", async () => {
    const user = await signIn();
    const first = await create(user, "job-request");
    expect(first.status).toBe(201);
    const saved = await first.json();
    const retry = await create(user, "job-request");
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(saved);
    expect((await create(user, "job-request", `${JOB_DESCRIPTION} A different requirement.`)).status).toBe(409);
    expect((await user.json("/api/applications")).applications).toHaveLength(1);
    const second = await create(user, "fresh-request");
    expect(second.status).toBe(201);
    expect(await second.json()).not.toEqual(saved);
    expect((await user.json("/api/applications")).applications).toHaveLength(2);
  });

  it("deduplicates simultaneous requests and rejects a competing input", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "job-race", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const [a, b] = await Promise.all([
        instance.addApplicationIdempotent(who, JOB_DESCRIPTION, "same-key"),
        instance.addApplicationIdempotent(who, JOB_DESCRIPTION, "same-key"),
      ]);
      expect(a).toEqual(b);
      const outcomes = await Promise.allSettled([
        instance.addApplicationIdempotent(who, JOB_DESCRIPTION, "competing"),
        instance.addApplicationIdempotent(who, `${JOB_DESCRIPTION} Different.`, "competing"),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await instance.listApplications(who)).toHaveLength(2);
    });
  });

  it("scopes keys to each vault and preserves the legacy endpoint", async () => {
    const alice = await signIn(), bob = await signIn();
    const [a, b] = await Promise.all([create(alice, "same-key"), create(bob, "same-key")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await a.json()).not.toEqual(await b.json());
    expect((await alice.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION })).status).toBe(201);
  });

  it("normalizes the input before comparing keys and rejects invalid request keys", async () => {
    const user = await signIn();
    const saved = await create(user, "normalized", `  ${JOB_DESCRIPTION}  `);
    expect(saved.status).toBe(201);
    const retry = await create(user, "normalized", JOB_DESCRIPTION);
    expect(await retry.json()).toEqual(await saved.json());
    expect((await create(user, "invalid key")).status).toBe(422);
    expect((await user.json("/api/applications")).applications).toHaveLength(1);
  });
});
