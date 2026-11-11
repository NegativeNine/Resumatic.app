import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import type { Me } from "../../src/shared/api";
import { COACH_CLIENT_KEPT_MS, type CoachClient, type ShareGrant, type SharedView } from "../../src/shared/sharing";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { Vault } from "../../src/vault/vault";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { createSession } from "../../src/worker/session";
import { removeCoachMigration } from "../support/undo-vault-incarnation";
import { call, cookieFrom, fakeModels, signIn, uniqueEmail, User } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

const FACT = "Cut deploy time from forty minutes to six";

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string; email?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);

/** Someone with a name and one confirmed fact to share. */
async function owner(name = "Sam Rivera") {
  const user = await signIn();
  expect((await user.send("PUT", "/api/profile", { name })).status).toBe(200);
  const role = await user.send("POST", "/api/roles", { kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null });
  const { roleId } = (await role.json()) as { roleId: string };
  const fact = await user.send("POST", "/api/facts", { roleId, kind: "accomplishment", text: FACT, level: "implemented" });
  const { factId } = (await fact.json()) as { factId: string };
  return { user, factId };
}

async function share(user: User, body: Record<string, unknown>) {
  const response = await user.send("POST", "/api/shares", { resumes: [], showName: true, ...body });
  expect(response.status, await response.clone().text()).toBe(201);
  const { grant, url } = (await response.json()) as { grant: ShareGrant; url: string };
  return { grant, token: new URL(url).hash.slice(1) };
}

/** Opens a link as a browser does, and returns the cookie for that copy. */
async function open(shared: { grant: ShareGrant; token: string }): Promise<string> {
  const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: shared.token }) });
  expect(exchange.status).toBe(200);
  return cookieFrom(exchange, `__Host-share-${shared.grant.id}`)!;
}
const jar = (...cookies: (string | null | undefined)[]) => cookies.filter(Boolean).join("; ");
/** Reads the copy with the cookies a browser would send. */
async function read(grantId: string, cookie: string) {
  const response = await call(`/share/snapshot?g=${grantId}`, { cookie });
  return { status: response.status, view: response.status === 200 ? ((await response.json()) as SharedView) : null };
}
const takeUp = (grantId: string, cookie: string) =>
  call("/api/coach/clients", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ grantId }) });
const clients = async (user: User) => user.json<{ clients: CoachClient[]; needsSignIn: boolean }>("/api/coach/clients");
const grants = async (user: User) => (await user.json<{ grants: ShareGrant[] }>("/api/shares")).grants;

describe("a copy that names its coach", () => {
  it("is taken up only by the account that signs in with that address, and opens from their list without the link", async () => {
    const { user: sam, factId } = await owner();
    const address = uniqueEmail();
    const shared = await share(sam, { factIds: [factId], coachEmail: `  ${address.toUpperCase()} ` });
    expect(shared.grant.coach).toEqual({ email: address, name: null, joinedAt: null });
    const link = await open(shared);

    // Anyone with the link still reads the copy. What it says about its coach depends on who reads.
    expect((await read(shared.grant.id, link)).view).toMatchObject({ reviewer: "sign-in" });
    const stranger = await signIn();
    expect((await read(shared.grant.id, jar(link, stranger.cookie))).view!.reviewer).toBe("other");
    const refused = await takeUp(shared.grant.id, jar(link, stranger.cookie));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "forbidden" });
    expect((await clients(stranger)).clients).toEqual([]);
    expect((await grants(sam))[0]!.coach).toEqual({ email: address, name: null, joinedAt: null });
    // The copy's owner is told nothing about a coach, and can't be their own.
    expect((await read(shared.grant.id, jar(link, sam.cookie))).view).not.toHaveProperty("reviewer");
    expect((await takeUp(shared.grant.id, jar(link, sam.cookie))).status).toBe(409);

    const dana = await signIn(address);
    expect((await dana.send("PUT", "/api/profile", { name: "  Dana   Okafor " })).status).toBe(200);
    expect(await dana.json<Me>("/api/me")).toMatchObject({ signInEmail: address, clients: 0 });
    expect((await read(shared.grant.id, jar(link, dana.cookie))).view!.reviewer).toBe("you");
    // Without the link's own session there is no copy to take up. Said as a conflict: under /api a
    // 410 is the caller's own account being gone, and the app signs them out on it.
    const noLink = await takeUp(shared.grant.id, dana.cookie);
    expect(noLink.status).toBe(409);
    expect(await noLink.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("this copy has ended") });
    const before = Date.now();
    expect((await takeUp(shared.grant.id, jar(link, dana.cookie))).status).toBe(204);
    expect((await read(shared.grant.id, jar(link, dana.cookie))).view!.reviewer).toBe("joined");
    expect((await dana.json<Me>("/api/me")).clients).toBe(1);

    // The owner sees who took it up. The coach sees whose copy it is and what it holds.
    const taken = (await grants(sam))[0]!.coach!;
    expect(taken).toMatchObject({ email: address, name: "Dana Okafor" });
    expect(taken.joinedAt).toBeGreaterThanOrEqual(before);
    expect(await clients(dana)).toEqual({
      needsSignIn: false,
      clients: [{ grantId: shared.grant.id, ownerName: "Sam Rivera", addedAt: expect.any(Number), expiresAt: shared.grant.expiresAt, active: true, factCount: 1, resumeCount: 0, documentCount: 0 }],
    });
    // Nothing in the list says where the copy is kept, and neither does the coach's own export.
    expect(JSON.stringify(await clients(dana))).not.toContain(sessionOf(sam).vid);
    const exported = await dana.json<{ coachClients: unknown[] }>("/api/export");
    expect(exported.coachClients).toEqual([{ grantId: shared.grant.id, ownerName: "Sam Rivera", addedAt: expect.any(Number), expiresAt: shared.grant.expiresAt }]);
    expect(JSON.stringify(exported)).not.toContain(sessionOf(sam).vid);
    // The owner's export says who took the copy up, as their list does.
    const owned = await sam.json<{ shares: ShareGrant[]; coachClients: unknown[] }>("/api/export");
    expect(owned.shares[0]!.coach).toMatchObject({ email: address, name: "Dana Okafor" });
    expect(owned.coachClients).toEqual([]);
    // Taking it up twice changes nothing.
    expect((await takeUp(shared.grant.id, jar(link, dana.cookie))).status).toBe(204);
    expect((await grants(sam))[0]!.coach!.joinedAt).toBe(taken.joinedAt);
    expect((await clients(dana)).clients).toHaveLength(1);

    // From the list, with no link: the same copy, for the same hour, and the owner sees it opened.
    const opened = await dana.send("POST", `/api/coach/clients/${shared.grant.id}/open`);
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ grantId: shared.grant.id });
    const again = cookieFrom(opened, `__Host-share-${shared.grant.id}`)!;
    expect(again).toContain("=");
    const copy = await read(shared.grant.id, jar(again, dana.cookie));
    expect(copy.view).toMatchObject({ reviewer: "joined", snapshot: { owner: { name: "Sam Rivera" } } });
    expect(copy.view!.snapshot.facts.map((fact) => fact.text)).toEqual([FACT]);
    expect((await grants(sam))[0]!.lastReadAt).toEqual(expect.any(Number));
  });

  it("opens for no other account, whatever that account's own list says", async () => {
    const { user: sam, factId } = await owner();
    const address = uniqueEmail();
    const shared = await share(sam, { factIds: [factId], coachEmail: address });
    const link = await open(shared);
    const dana = await signIn(address);
    expect((await takeUp(shared.grant.id, jar(link, dana.cookie))).status).toBe(204);

    const mallory = await signIn();
    expect((await mallory.send("POST", `/api/coach/clients/${shared.grant.id}/open`)).status).toBe(404);
    // Even a list that names the copy and where it is kept opens nothing: the owner's vault decides.
    await runInDurableObject(vaultOf(mallory), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO coach_clients (grant_id, owner_vault, owner_name, added_at, expires_at) VALUES (?, ?, 'Sam Rivera', ?, ?)`,
        shared.grant.id, sessionOf(sam).vid, Date.now(), shared.grant.expiresAt,
      );
    });
    const forced = await mallory.send("POST", `/api/coach/clients/${shared.grant.id}/open`);
    expect(forced.status).toBe(409);
    expect(await forced.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("this copy has ended") });
    expect(forced.headers.getSetCookie()).toEqual([]);
    expect((await clients(mallory)).clients).toMatchObject([{ grantId: shared.grant.id, active: false, factCount: 0 }]);

    // A session from before the sign-in address was carried is nobody's coach until they sign in again.
    const { email: _email, ...old } = sessionOf(dana);
    const earlier = new User(dana.email, `__Host-session=${await createSession(env.SESSION_KEY, old)}`);
    expect(await earlier.json<Me>("/api/me")).not.toHaveProperty("signInEmail");
    expect((await read(shared.grant.id, jar(link, earlier.cookie))).view!.reviewer).toBe("sign-in-again");
    const stale = await earlier.send("POST", `/api/coach/clients/${shared.grant.id}/open`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ message: expect.stringContaining("sign out and in again") });
    expect((await takeUp(shared.grant.id, jar(link, earlier.cookie))).status).toBe(409);
    expect(await clients(earlier)).toMatchObject({ needsSignIn: true, clients: [{ active: false }] });
    // The same account with a current session is the coach it always was.
    expect((await dana.send("POST", `/api/coach/clients/${shared.grant.id}/open`)).status).toBe(200);
  });

  it("ends for the coach when the owner revokes it, and leaves the coach's list theirs to tidy", async () => {
    const { user: sam, factId } = await owner();
    const address = uniqueEmail();
    const shared = await share(sam, { factIds: [factId], coachEmail: address });
    const dana = await signIn(address);
    expect((await takeUp(shared.grant.id, jar(await open(shared), dana.cookie))).status).toBe(204);
    expect((await sam.send("DELETE", `/api/shares/${shared.grant.id}`)).status).toBe(204);

    expect((await clients(dana)).clients).toMatchObject([{ grantId: shared.grant.id, ownerName: "Sam Rivera", active: false, factCount: 0 }]);
    const ended = await dana.send("POST", `/api/coach/clients/${shared.grant.id}/open`);
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("this copy has ended") });
    expect(ended.headers.getSetCookie()).toEqual([]);
    // The coach is still signed in: a client's copy ending is never their own account ending.
    expect((await dana.send("GET", "/api/me")).status).toBe(200);
    // The owner's record of who took it up stays with the revoked link.
    expect((await grants(sam))[0]).toMatchObject({ revokedAt: expect.any(Number), coach: { email: address } });
    expect((await dana.send("DELETE", `/api/coach/clients/${shared.grant.id}`)).status).toBe(204);
    expect(await clients(dana)).toEqual({ clients: [], needsSignIn: false });
    expect((await dana.send("DELETE", `/api/coach/clients/${shared.grant.id}`)).status).toBe(204);
  });

  it("says the copy has ended, not the coach's account, when its last moment passes while it is being opened", async () => {
    const { user: sam, factId } = await owner();
    const address = uniqueEmail();
    // A minute left, so the clock below has only a minute to move.
    const shared = await share(sam, { factIds: [factId], coachEmail: address, expiresAt: Date.now() + 60_000 });
    const dana = await signIn(address);
    expect((await takeUp(shared.grant.id, jar(await open(shared), dana.cookie))).status).toBe(204);

    // The owner's vault finds the copy still live, and its last moment passes before the answer is back.
    const real = Date.now.bind(Date);
    let ahead = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + ahead);
    const openShareForCoach = Vault.prototype.openShareForCoach;
    const opening = vi.spyOn(Vault.prototype, "openShareForCoach").mockImplementation(async function (this: Vault, grantId, coach) {
      const opened = await openShareForCoach.call(this, grantId, coach);
      ahead = opened.expiresAt - real();
      return opened;
    });
    try {
      const late = await dana.send("POST", `/api/coach/clients/${shared.grant.id}/open`);
      expect(opening).toHaveBeenCalledOnce();
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("this copy has ended") });
      expect(late.headers.getSetCookie()).toEqual([]);
    } finally {
      opening.mockRestore();
      clock.mockRestore();
    }
    // A 410 here would have been read as the coach's own account being gone.
    expect((await dana.send("GET", "/api/me")).status).toBe(200);
    expect((await clients(dana)).clients).toMatchObject([{ grantId: shared.grant.id, active: true }]);
  });

  it("names nobody unless its owner says so, and takes only an address", async () => {
    const { user: sam, factId } = await owner();
    const plain = await share(sam, { factIds: [factId] });
    expect(plain.grant.coach).toBeNull();
    const link = await open(plain);
    const reader = await signIn();
    expect((await read(plain.grant.id, jar(link, reader.cookie))).view).not.toHaveProperty("reviewer");
    expect((await takeUp(plain.grant.id, jar(link, reader.cookie))).status).toBe(403);
    for (const coachEmail of ["dana", "dana@", "@example.test", "dana@example", "a b@example.test", `${"x".repeat(250)}@example.test`, 7])
      expect((await sam.send("POST", "/api/shares", { factIds: [factId], resumes: [], coachEmail })).status, String(coachEmail)).toBe(422);
    // An empty address names nobody.
    expect((await share(sam, { factIds: [factId], coachEmail: "   " })).grant.coach).toBeNull();
    expect(await grants(sam)).toHaveLength(2);
  });
});

describe("an entry in a coach's list", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const alarmOf = (user: User) => runInDurableObject(vaultOf(user), (_instance, state) => state.storage.getAlarm());
  const held = (user: User) =>
    runInDurableObject(vaultOf(user), (_instance, state) =>
      state.storage.sql.exec<{ grant_id: string }>(`SELECT grant_id FROM coach_clients ORDER BY expires_at`).toArray().map((row) => row.grant_id),
    );
  /** Moves an entry to the moment it is due to be cleared, as thirty days passing after its copy's last day would. */
  const lapse = (user: User, grantId: string) =>
    runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(`UPDATE coach_clients SET expires_at = ? WHERE grant_id = ?`, Date.now() - COACH_CLIENT_KEPT_MS, grantId);
    });

  it("is cleared from storage thirty days after its copy's last day, in an account that does nothing else", async () => {
    const { user: sam, factId } = await owner();
    const address = uniqueEmail();
    const sooner = await share(sam, { factIds: [factId], coachEmail: address, expiresAt: Date.now() + 2 * DAY });
    const later = await share(sam, { factIds: [factId], coachEmail: address, expiresAt: Date.now() + 5 * DAY });
    // An account used only to coach: no uploads, facts or links of its own, so nothing has woken its vault.
    const dana = await signIn(address);
    expect(await alarmOf(dana)).toBeNull();

    expect((await takeUp(sooner.grant.id, jar(await open(sooner), dana.cookie))).status).toBe(204);
    expect(await alarmOf(dana)).toBe(sooner.grant.expiresAt + COACH_CLIENT_KEPT_MS);
    // A copy that ends later leaves the alarm on the one that ends sooner.
    expect((await takeUp(later.grant.id, jar(await open(later), dana.cookie))).status).toBe(204);
    expect(await alarmOf(dana)).toBe(sooner.grant.expiresAt + COACH_CLIENT_KEPT_MS);

    // Thirty days after its last day the entry is unseen at once, and the alarm takes it out of storage.
    await lapse(dana, sooner.grant.id);
    expect((await clients(dana)).clients.map((client) => client.grantId)).toEqual([later.grant.id]);
    expect(await held(dana)).toEqual([sooner.grant.id, later.grant.id]);
    expect(await runDurableObjectAlarm(vaultOf(dana))).toBe(true);
    expect(await held(dana)).toEqual([later.grant.id]);
    // The alarm is set again for the entry that is left, and that one goes in its turn.
    expect(await alarmOf(dana)).toBe(later.grant.expiresAt + COACH_CLIENT_KEPT_MS);
    await lapse(dana, later.grant.id);
    expect(await runDurableObjectAlarm(vaultOf(dana))).toBe(true);
    expect(await held(dana)).toEqual([]);
    expect(await alarmOf(dana)).toBeNull();
  });

  it("is still due to be cleared after the vault's alarm has fired for something else", async () => {
    const { user: sam, factId } = await owner();
    // This coach has a fact and a link of her own. Saving the fact set an alarm, which is run out of the way.
    const { user: dana, factId: hers } = await owner("Dana Okafor");
    await runDurableObjectAlarm(vaultOf(dana));
    expect(await alarmOf(dana)).toBeNull();
    const shared = await share(sam, { factIds: [factId], coachEmail: dana.email });
    expect((await takeUp(shared.grant.id, jar(await open(shared), dana.cookie))).status).toBe(204);
    const due = shared.grant.expiresAt + COACH_CLIENT_KEPT_MS;
    expect(await alarmOf(dana)).toBe(due);

    // Her own link ends long before the entry is due, so the vault's one alarm is set for the link.
    const own = await share(dana, { factIds: [hers], expiresAt: Date.now() + 60_000 });
    expect(await alarmOf(dana)).toBe(own.grant.expiresAt);
    await runInDurableObject(vaultOf(dana), (_instance, state) => {
      state.storage.sql.exec(`UPDATE share_grants SET expires_at = ? WHERE id = ?`, Date.now() - 1, own.grant.id);
    });
    expect(await runDurableObjectAlarm(vaultOf(dana))).toBe(true);
    expect(await grants(dana)).toEqual([]);
    // That alarm is spent. The entry's own time has to be set again, or nothing would ever clear it.
    expect(await alarmOf(dana)).toBe(due);
    expect(await held(dana)).toEqual([shared.grant.id]);
  });
});

describe("coaches in an existing vault", () => {
  it("adds the columns and the list, and a link from before names nobody", async () => {
    const { user, factId } = await owner();
    const earlier = await share(user, { factIds: [factId] });
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const sql = state.storage.sql;
      removeCoachMigration(sql);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("ADD COLUMN coach_email")));
      expect(previous).toBeGreaterThan(-1);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT coach_email, coach_user_id, coach_name, coach_joined_at FROM share_grants`).toArray()).toEqual([
        { coach_email: null, coach_user_id: null, coach_name: null, coach_joined_at: null },
      ]);
      expect(sql.exec(`SELECT COUNT(*) AS n FROM coach_clients`).one()).toEqual({ n: 0 });
    });
    expect(await grants(user)).toMatchObject([{ id: earlier.grant.id, coach: null, available: true }]);
    expect(await clients(user)).toEqual({ clients: [], needsSignIn: false });
    expect((await read(earlier.grant.id, await open(earlier))).view).not.toHaveProperty("reviewer");
  });
});
