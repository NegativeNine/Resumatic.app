import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MCP_GRANT_TTL_MS, type McpClaims } from "../../src/shared/mcp";
import { vault } from "../../src/shared/stubs";

// A connected app's grant is erased when it ends: the privacy notice and the consent page say its
// access lasts at most thirty days. Use is refused at its end whatever storage holds; this is about
// the row itself leaving storage on time.

const DAY = 24 * 60 * 60 * 1000;

/** An account that does nothing but connect an app: no uploads, facts, links or jobs. */
async function account() {
  const id = env.VAULT.newUniqueId().toString();
  const stub = vault(env, id);
  const who = { userId: crypto.randomUUID(), gen: 1 };
  await stub.init(who.userId);
  return { id, stub, who };
}

async function connect(f: Awaited<ReturnType<typeof account>>, expiresAt: number) {
  const grant = await f.stub.createMcpGrant(f.who, {
    id: crypto.randomUUID(), clientId: "synthetic-client", clientName: "Synthetic client",
    scopes: ["vault:read"], expiresAt,
  });
  const claims: McpClaims = {
    uid: f.who.userId, vid: f.id, gen: grant.gen, epoch: grant.epoch,
    grantId: grant.id, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.expiresAt,
  };
  await f.stub.bindMcpGrant(claims, `synthetic-oauth-${grant.id}`);
  return grant;
}

const alarmOf = (f: Awaited<ReturnType<typeof account>>) =>
  runInDurableObject(f.stub, (_instance, state) => state.storage.getAlarm());
const held = (f: Awaited<ReturnType<typeof account>>) =>
  runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql.exec<{ id: string }>(`SELECT id FROM mcp_grants ORDER BY expires_at`).toArray().map((row) => row.id),
  );
/** Moves a grant to its last moment, as the days passing until it ends would. */
const lapse = (f: Awaited<ReturnType<typeof account>>, grantId: string) =>
  runInDurableObject(f.stub, (_instance, state) => {
    state.storage.sql.exec(`UPDATE mcp_grants SET expires_at = ? WHERE id = ?`, Date.now(), grantId);
  });

describe("a connected app's grant", () => {
  it("is erased from storage when it ends, in an account that does nothing else", async () => {
    const f = await account();
    expect(await alarmOf(f)).toBeNull();

    const sooner = await connect(f, Date.now() + 2 * DAY);
    // Until its token arrives a grant is pending, and a pending grant is erased ten minutes after
    // it was made. The alarm is set for that, and moves on to the grant's end once it has fired.
    expect(await alarmOf(f)).toBe(sooner.createdAt + 600_000);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await held(f)).toEqual([sooner.id]);
    expect(await alarmOf(f)).toBe(sooner.expiresAt);
    // A grant that ends later leaves the alarm on the one that ends sooner.
    const later = await connect(f, Date.now() + MCP_GRANT_TTL_MS);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await alarmOf(f)).toBe(sooner.expiresAt);

    await lapse(f, sooner.id);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await held(f)).toEqual([later.id]);
    // The alarm is set again for the grant that is left, and that one goes in its turn.
    expect(await alarmOf(f)).toBe(later.expiresAt);
    await lapse(f, later.id);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await held(f)).toEqual([]);
    expect(await alarmOf(f)).toBeNull();
  });

  it("is still due to be erased after the vault's alarm has fired for something else", async () => {
    const f = await account();
    const grant = await connect(f, Date.now() + 3 * DAY);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await alarmOf(f)).toBe(grant.expiresAt);
    // Other work sets the vault's one alarm sooner, and the alarm fires for it.
    await runInDurableObject(f.stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await held(f)).toEqual([grant.id]);
    // That alarm is spent. The grant's own time has to be set again, or nothing would ever erase it.
    expect(await alarmOf(f)).toBe(grant.expiresAt);
  });
});
