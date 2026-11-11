import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import { setPdfRenderer } from "../../src/render/pdf";
import type { FactView, Me, Profile, ResumeView, RoleView } from "../../src/shared/api";
import type { DocumentView } from "../../src/shared/documents";
import type { McpClaims } from "../../src/shared/mcp";
import { PREFERENCES_CHANGED, PREFERENCES_REFUSED, type PreferenceValues, type Preferences } from "../../src/shared/preferences";
import type { CoachClient, ShareGrant } from "../../src/shared/sharing";
import { directory, vault } from "../../src/shared/stubs";
import type { Who } from "../../src/shared/types";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { Vault } from "../../src/vault/vault";
import { base64url, fromBase64url } from "../../src/worker/crypto";
import worker from "../../src/worker/index";
import { app } from "../../src/worker/routes";
import { createSession } from "../../src/worker/session";
import { removePreferencesMigration } from "../support/undo-vault-incarnation";
import { JOB_DESCRIPTION, ORIGIN, RESUME, User, call, cookieFrom, eventually, fakeModels, signIn, uniqueEmail, waitForResume, waitForSource, type FakeModelOptions } from "./support";

// Job preferences inside a real vault, reached the way the app reaches them: saved and read by
// their owner over HTTP, exported, moved and erased with the vault, and found nowhere else.

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => {
  setModels(null);
  setPdfRenderer(null);
});

const UNSAID: Preferences = { revision: 0, place: null, jobTypes: [], availableFrom: null, payFloor: null, updatedAt: null };
const chosen: PreferenceValues = {
  place: "Toronto, Ontario",
  jobTypes: ["full_time", "contract"],
  availableFrom: "2027-03",
  payFloor: { amount: 140000, currency: "CAD", period: "year" },
};

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string; email?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
/** The caller as the Worker tells a vault of them, from their own session. */
function whoOf(user: User): Who {
  const session = sessionOf(user);
  return { userId: session.uid, gen: session.gen, epoch: session.epoch };
}

const read = (user: User) => user.json<Preferences>("/api/preferences");
const put = (user: User, body: unknown) => user.send("PUT", "/api/preferences", body);
const save = (user: User, values: PreferenceValues, expectedRevision: number) => put(user, { ...values, expectedRevision });
/** Saves, and gives back what the vault says it now holds. */
async function saved(user: User, values: PreferenceValues, expectedRevision: number): Promise<Preferences> {
  const response = await save(user, values, expectedRevision);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Preferences;
}
/** The table as the vault's storage holds it: no row until the first save. */
const rows = (user: User) =>
  runInDurableObject(vaultOf(user), (_instance, state) => state.storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM preferences`).toArray());

type VaultStub = ReturnType<typeof vault>;
const fenced: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const lift of fenced.splice(0).reverse()) await lift();
});
/** Sets the deployment's maintenance fence, as this one object reads it, to these vaults until the test ends. */
async function fence(target: VaultStub | ReturnType<typeof directory>, ids: string[]): Promise<void> {
  const prior = await runInDurableObject(target, (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const before = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = ids.join(",");
    return before;
  });
  fenced.push(() =>
    runInDurableObject(target, (instance) => {
      (instance as unknown as { env: Env }).env.RESTORE_FENCE_IDS = prior;
    }),
  );
}

/** What a rejected call into a vault said, or "nothing" when it was let through. */
const refusal = (work: Promise<unknown>): Promise<string> => work.then(() => "nothing", (error: unknown) => String((error as Error).message ?? error));

describe("job preferences", () => {
  it("starts with nothing said, then saves, reads back and needs the new revision", async () => {
    const user = await signIn();
    expect(await read(user)).toEqual(UNSAID);
    // Reading makes no row: there is none until the owner first saves.
    expect(await rows(user)).toEqual([]);

    const before = Date.now();
    const first = await saved(user, { place: "  Toronto, Ontario ", jobTypes: ["contract", "full_time"], availableFrom: "2027-03", payFloor: { amount: 140000, currency: "CAD", period: "year" } }, 0);
    // As stored: the place trimmed, and the job types in the list's own order.
    expect(first).toEqual({ revision: 1, ...chosen, updatedAt: expect.any(Number) });
    expect(first.updatedAt).toBeGreaterThanOrEqual(before);
    expect(first.updatedAt).toBeLessThanOrEqual(Date.now());
    expect(await read(user)).toEqual(first);
    expect(await rows(user)).toEqual([
      { id: 1, revision: 1, place: "Toronto, Ontario", job_types: '["full_time","contract"]', available_from: "2027-03", pay_amount: 140000, pay_currency: "CAD", pay_period: "year", updated_at: first.updatedAt },
    ]);

    // The revision a save was read at is spent once it lands. The next one needs the new revision.
    const stale = await save(user, { ...chosen, place: "Leeds" }, 0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", message: PREFERENCES_CHANGED });
    expect(await read(user)).toEqual(first);
    // A save replaces all four values: what is left out of it is no longer said.
    const second = await saved(user, { place: "Leeds", jobTypes: [], availableFrom: "now", payFloor: null }, 1);
    expect(second).toEqual({ revision: 2, place: "Leeds", jobTypes: [], availableFrom: "now", payFloor: null, updatedAt: expect.any(Number) });
    // The same values again are still a save, at the next revision.
    expect(await saved(user, { place: "Leeds", jobTypes: [], availableFrom: "now", payFloor: null }, 2)).toMatchObject({ revision: 3, place: "Leeds" });
    // Clearing everything leaves nothing said, in the one row there is.
    expect(await saved(user, { place: null, jobTypes: [], availableFrom: null, payFloor: null }, 3)).toEqual({ ...UNSAID, revision: 4, updatedAt: expect.any(Number) });
    expect(await rows(user)).toHaveLength(1);
    // Nothing about a save is cached where another reader could be served it.
    const response = await user.fetch("/api/preferences");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps one of two saves from one revision, and answers the other with the form's sentence", async () => {
    const user = await signIn();
    const leeds = { ...chosen, place: "Leeds" };
    const york = { ...chosen, place: "York" };
    const answers = await Promise.all([save(user, leeds, 0), save(user, york, 0)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const kept = (await answers.find((answer) => answer.status === 200)!.json()) as Preferences;
    const lost = await answers.find((answer) => answer.status === 409)!.json();
    // The sentence the form shows as it stands: it says what happened and what to do next.
    expect(lost).toEqual({ error: "conflict", message: "Your preferences were changed somewhere else. Load the saved preferences, check them, then save again." });
    expect(kept).toMatchObject({ revision: 1 });
    expect(["Leeds", "York"]).toContain(kept.place);
    expect(await read(user)).toEqual(kept);

    // The same request sent again can't apply twice: there is no key, and the revision it names is spent.
    const replayed = await save(user, { ...chosen, place: kept.place }, 0);
    expect(replayed.status).toBe(409);
    expect(await read(user)).toEqual(kept);
    expect(await rows(user)).toHaveLength(1);
  });

  it("refuses malformed, out-of-set, missing and unknown fields with 422, and an oversized body with 413, and stores nothing", async () => {
    const user = await signIn();
    const other = sessionOf(await signIn());
    const floor = { amount: 140000, currency: "CAD", period: "year" };
    const without = (field: keyof PreferenceValues) => {
      const { [field]: _dropped, ...rest } = chosen;
      return { ...rest, expectedRevision: 0 };
    };
    // Refused by the rule a save is held to, with the sentence the form shows.
    const outside: Record<string, unknown> = {
      "a place of two lines": { ...chosen, place: "Leeds\nYork" },
      "a place over the cap": { ...chosen, place: "x".repeat(121) },
      "a place that is not text": { ...chosen, place: 7 },
      // Storage would replace the unpaired half, and the place saved would not be the place sent.
      "a place holding half of a character": { ...chosen, place: "Leeds \ud83d" },
      "a job type twice": { ...chosen, jobTypes: ["full_time", "full_time"] },
      "a job type that isn't offered": { ...chosen, jobTypes: ["full_time", "seasonal"] },
      "job types that are no list": { ...chosen, jobTypes: "full_time" },
      "an availability that is no month": { ...chosen, availableFrom: "soon" },
      "a day where a month goes": { ...chosen, availableFrom: "2027-03-01" },
      "half a pay floor": { ...chosen, payFloor: { amount: 140000, currency: "CAD" } },
      "a pay floor with cents": { ...chosen, payFloor: { ...floor, amount: 140000.5 } },
      "an amount written out": { ...chosen, payFloor: { ...floor, amount: "140,000" } },
      "a pay floor of nothing": { ...chosen, payFloor: { ...floor, amount: 0 } },
      "a pay floor over the cap": { ...chosen, payFloor: { ...floor, amount: 1_000_000_000_000 } },
      "a withdrawn currency": { ...chosen, payFloor: { ...floor, currency: "HRK" } },
      "a period that isn't offered": { ...chosen, payFloor: { ...floor, period: "fortnight" } },
      "a pay floor with a fourth part": { ...chosen, payFloor: { ...floor, bonus: 20000 } },
    };
    // Refused before the rule is asked: not the four fields and a revision, or not JSON at all.
    const misshapen: Record<string, unknown> = {
      "no place": without("place"),
      "no job types": without("jobTypes"),
      "no availability": without("availableFrom"),
      "no pay floor": without("payFloor"),
      "no revision": chosen,
      "work authorisation": { ...chosen, expectedRevision: 0, workAuthorisation: "citizen-canary" },
      "remote work": { ...chosen, expectedRevision: 0, remote: "remote-canary" },
      "an account to save it for": { ...chosen, expectedRevision: 0, userId: other.uid },
      "a vault to save it in": { ...chosen, expectedRevision: 0, vaultId: other.vid },
      "a revision to save it as": { ...chosen, expectedRevision: 0, revision: 9 },
      "a negative revision": { ...chosen, expectedRevision: -1 },
      "a fractional revision": { ...chosen, expectedRevision: 0.5 },
      "a revision in words": { ...chosen, expectedRevision: "0" },
      "a revision past the last one": { ...chosen, expectedRevision: Number.MAX_SAFE_INTEGER },
      "a list": [chosen],
      "words": "Toronto, full time",
      "nothing": null,
    };
    async function refuseAll(revision: number) {
      const reached = vi.spyOn(Vault.prototype, "updatePreferences");
      try {
        for (const [why, values] of Object.entries(outside)) {
          const response = await put(user, { ...(values as object), expectedRevision: revision });
          expect(response.status, why).toBe(422);
          expect(await response.json(), why).toEqual({ error: "invalid", message: PREFERENCES_REFUSED });
        }
        for (const [why, body] of Object.entries(misshapen)) {
          const response = await put(user, body);
          expect(response.status, why).toBe(422);
          const answer = await response.text();
          expect(JSON.parse(answer), why).toMatchObject({ error: "invalid" });
          // Whatever the reply says of the request's shape, it repeats nothing that was typed into it.
          for (const typed of ["citizen-canary", "remote-canary", "Toronto", other.uid, other.vid]) expect(answer, why).not.toContain(typed);
        }
        const notJson = await user.fetch("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"place": "Toronto"' });
        expect(notJson.status).toBe(422);
        expect(await notJson.json()).toEqual({ error: "invalid", message: "expected a JSON body" });
        const oversized = await put(user, { ...chosen, place: "x".repeat(70_000), expectedRevision: revision });
        expect(oversized.status).toBe(413);
        expect(await oversized.json()).toEqual({ error: "too_large", message: "This request is too large to process." });
        // Every one of those was refused by the Worker, before the vault was asked to save anything.
        expect(reached).not.toHaveBeenCalled();
      } finally {
        reached.mockRestore();
      }
      // The Vault judges the values again by the same rule: a route is not its only caller.
      for (const why of ["a job type that isn't offered", "half a pay floor", "a withdrawn currency", "a place of two lines"])
        expect(await refusal(vaultOf(user).updatePreferences(whoOf(user), outside[why] as PreferenceValues, revision)), why).toBe(`invalid: ${PREFERENCES_REFUSED}`);
      expect(await refusal(vaultOf(user).updatePreferences(whoOf(user), { ...chosen, workAuthorisation: "citizen" } as PreferenceValues, revision))).toBe(`invalid: ${PREFERENCES_REFUSED}`);
      expect(await refusal(vaultOf(user).updatePreferences(whoOf(user), chosen, -1))).toBe(`conflict: ${PREFERENCES_CHANGED}`);
      expect(await refusal(vaultOf(user).updatePreferences(whoOf(user), chosen, revision + 1))).toBe(`conflict: ${PREFERENCES_CHANGED}`);
    }

    // In a vault where nothing was ever saved, no refusal makes the row.
    await refuseAll(0);
    expect(await rows(user)).toEqual([]);
    expect(await read(user)).toEqual(UNSAID);
    // And where something is saved, no refusal changes it.
    const kept = await saved(user, chosen, 0);
    const held = await rows(user);
    await refuseAll(1);
    expect(await rows(user)).toEqual(held);
    expect(await read(user)).toEqual(kept);
  });

  it("still reads and exports a saved choice that has left its list, and takes it in no new save", async () => {
    const user = await signIn();
    await saved(user, chosen, 0);
    // As the row would be had it been saved while a seasonal job type, a fortnightly period and the kuna were offered.
    await runInDurableObject(vaultOf(user), (_instance, state) => void state.storage.sql.exec(`UPDATE preferences SET job_types = '["full_time","seasonal"]', pay_currency = 'HRK', pay_period = 'biweekly'`));
    const stored = await read(user);
    // Read as stored: nothing dropped, replaced or refused, so the owner can see it and change it.
    expect(stored).toMatchObject({ revision: 1, place: "Toronto, Ontario", jobTypes: ["full_time", "seasonal"], payFloor: { amount: 140000, currency: "HRK", period: "biweekly" } });
    expect((await user.json<Record<string, unknown>>("/api/export")).preferences).toEqual(stored);

    // Sent back as it is, it is refused by the route and by the Vault, and the row stays as it was.
    const { revision: _revision, updatedAt: _updatedAt, ...values } = stored;
    const again = await put(user, { ...values, expectedRevision: 1 });
    expect(again.status).toBe(422);
    expect(await again.json()).toEqual({ error: "invalid", message: PREFERENCES_REFUSED });
    expect(await refusal(vaultOf(user).updatePreferences(whoOf(user), values as PreferenceValues, 1))).toBe(`invalid: ${PREFERENCES_REFUSED}`);
    expect(await read(user)).toEqual(stored);
    // With each one replaced by a choice offered today, it saves.
    expect(await saved(user, { ...chosen, jobTypes: ["full_time"], payFloor: { amount: 1200, currency: "EUR", period: "month" } }, 1)).toMatchObject({
      revision: 2, jobTypes: ["full_time"], payFloor: { amount: 1200, currency: "EUR", period: "month" },
    });
  });

  it("needs a session: none, forged, or signed out everywhere", async () => {
    const email = uniqueEmail();
    const laptop = await signIn(email);
    const kept = await saved(laptop, chosen, 0);
    const body = JSON.stringify({ ...chosen, place: "Leeds", expectedRevision: 1 });
    const attempt = async (cookie: string | undefined, why: string) => {
      const reading = await call("/api/preferences", { cookie });
      expect(reading.status, why).toBe(401);
      expect(await reading.json(), why).toMatchObject({ error: "unauthenticated" });
      const saving = await call("/api/preferences", { method: "PUT", cookie, headers: { "content-type": "application/json" }, body });
      expect(saving.status, why).toBe(401);
      expect(await saving.text(), why).not.toContain("Toronto");
    };
    await attempt(undefined, "no session");
    await attempt("__Host-session=not-a-token", "a cookie that is no session");
    // A session whose claims were changed after it was signed.
    const [payload, mac] = laptop.cookie.slice("__Host-session=".length).split(".");
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload!)));
    const forged = base64url(new TextEncoder().encode(JSON.stringify({ ...claims, gen: claims.gen + 1 })));
    await attempt(`__Host-session=${forged}.${mac}`, "a forged session");
    // An expired one, properly signed.
    const expired = await createSession(env.SESSION_KEY, sessionOf(laptop), Date.now() - 8 * 24 * 3600 * 1000);
    await attempt(`__Host-session=${expired}`, "an expired session");
    expect(await read(laptop)).toEqual(kept);

    // Signing out everywhere closes both routes to every session there was, at once.
    const phone = await signIn(email);
    expect((await phone.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    await attempt(laptop.cookie, "a session signed out from another device");
    await attempt(phone.cookie, "the session that signed out");
    const again = await signIn(email);
    expect(await read(again)).toEqual(kept);
  });

  it("reads only the session's own vault: another account's who on this Vault is forbidden, and a stale generation is unauthenticated", async () => {
    const sam = await signIn();
    const dana = await signIn();
    const sams = await saved(sam, chosen, 0);
    const danas = await saved(dana, { place: "Lagos", jobTypes: ["part_time"], availableFrom: "now", payFloor: { amount: 25, currency: "GBP", period: "hour" } }, 0);
    // Each account is given its own, and only its own.
    expect(await read(sam)).toEqual(sams);
    expect(await read(dana)).toEqual(danas);
    expect(JSON.stringify(await read(dana))).not.toContain("Toronto");

    // The Worker picks the vault from the session. The Vault still asks whose it is: another
    // account's caller, however it arrived, is refused by the vault itself.
    const outsider = whoOf(dana);
    expect(await refusal(vaultOf(sam).getPreferences(outsider))).toBe("forbidden: not this user's vault");
    expect(await refusal(vaultOf(sam).updatePreferences(outsider, { ...chosen, place: "Lagos" }, 1))).toBe("forbidden: not this user's vault");
    // Even with everything else about the vault's own session right.
    expect(await refusal(vaultOf(sam).getPreferences({ ...whoOf(sam), userId: outsider.userId }))).toBe("forbidden: not this user's vault");
    // A session signed by this app for one account but naming another's vault opens nothing.
    const crossed = new User(dana.email, `__Host-session=${await createSession(env.SESSION_KEY, { ...sessionOf(sam), uid: sessionOf(dana).uid })}`);
    const reading = await crossed.fetch("/api/preferences");
    expect(reading.status).toBe(403);
    expect(await reading.text()).not.toContain("Toronto");
    expect((await save(crossed, { ...chosen, place: "Lagos" }, 1)).status).toBe(403);
    expect(await read(sam)).toEqual(sams);

    // The vault's own account with a session from before it changed is no longer current.
    expect(await refusal(vaultOf(sam).getPreferences({ ...whoOf(sam), epoch: "an-earlier-epoch" }))).toBe("unauthenticated: this session is no longer valid");
    expect(await refusal(vaultOf(sam).updatePreferences({ ...whoOf(sam), epoch: "an-earlier-epoch" }, chosen, 1))).toBe("unauthenticated: this session is no longer valid");
    const earlier = whoOf(sam);
    expect((await sam.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    expect(await refusal(vaultOf(sam).getPreferences(earlier))).toBe("unauthenticated: this session was signed out");
    expect(await refusal(vaultOf(sam).updatePreferences(earlier, { ...chosen, place: "Leeds" }, 1))).toBe("unauthenticated: this session was signed out");
    expect(await refusal(vaultOf(sam).getPreferences({ ...earlier, gen: earlier.gen + 1 }))).toBe("nothing");
    expect(await rows(sam)).toMatchObject([{ revision: 1, place: "Toronto, Ontario" }]);
  });

  it("refuses a cross-site save", async () => {
    const user = await signIn();
    const body = JSON.stringify({ ...chosen, expectedRevision: 0 });
    const crossSite = await user.fetch("/api/preferences", { method: "PUT", headers: { origin: "https://evil.example", "content-type": "application/json" }, body });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "forbidden", message: "cross-site request refused" });
    expect(await rows(user)).toEqual([]);
    // The same save from this site goes through.
    const sameSite = await user.fetch("/api/preferences", { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json" }, body });
    expect(sameSite.status).toBe(200);
    expect(await read(user)).toMatchObject({ revision: 1, place: "Toronto, Ontario" });
  });

  it("is refused with 429 at the write limit, and stores nothing", async () => {
    const user = await signIn();
    const limit = vi.fn(async (_input: { key: string }) => ({ success: false }));
    const limited = { ...env, RATE_LIMITS_ENABLED: "true", WRITE_LIMIT: { limit } } as unknown as Env;
    const saving = () =>
      new Request(`${ORIGIN}/api/preferences`, { method: "PUT", headers: { cookie: user.cookie, "content-type": "application/json" }, body: JSON.stringify({ ...chosen, expectedRevision: 0 }) });
    const refused = await app.fetch(saving(), limited);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "quota", message: "Too many requests. Try again in a minute." });
    // Counted against the signed-in account, which the session names and the request can't.
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: `user:${sessionOf(user).uid}` });
    expect(await rows(user)).toEqual([]);
    // Reading is not a write: it isn't counted, and still answers.
    const reading = await app.fetch(new Request(`${ORIGIN}/api/preferences`, { headers: { cookie: user.cookie } }), limited);
    expect(reading.status).toBe(200);
    expect(await reading.json()).toEqual(UNSAID);
    expect(limit).toHaveBeenCalledOnce();
    // Under the limit, the same save lands.
    const allowed = { ...env, RATE_LIMITS_ENABLED: "true", WRITE_LIMIT: { limit: async () => ({ success: true }) } } as unknown as Env;
    expect((await app.fetch(saving(), allowed)).status).toBe(200);
    expect(await rows(user)).toHaveLength(1);
  });

  it("is closed while the vault is fenced or being deleted", async () => {
    const user = await signIn();
    const kept = await saved(user, chosen, 0);
    const held = await rows(user);

    await fence(vaultOf(user), [sessionOf(user).vid]);
    const reading = await user.fetch("/api/preferences");
    expect(reading.status).toBe(503);
    expect(await reading.json()).toEqual({ error: "unavailable", message: "this account is temporarily unavailable during maintenance" });
    const saving = await save(user, { ...chosen, place: "Leeds" }, 1);
    expect(saving.status).toBe(503);
    expect(await refusal(vaultOf(user).updatePreferences(whoOf(user), { ...chosen, place: "Leeds" }, 1))).toMatch(/^unavailable: /);
    expect(await rows(user)).toEqual(held);
    await fence(vaultOf(user), []);
    expect(await read(user)).toEqual(kept);

    // An account being deleted is closed at once, before anything of it has been erased.
    expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
    const after = await user.fetch("/api/preferences");
    expect(after.status).toBe(410);
    expect(await after.text()).not.toContain("Toronto");
    expect((await save(user, { ...chosen, place: "Leeds" }, 1)).status).toBe(410);
    expect(await refusal(vaultOf(user).getPreferences(whoOf(user)))).toMatch(/^gone: /);
    expect(await refusal(vaultOf(user).updatePreferences(whoOf(user), { ...chosen, place: "Leeds" }, 1))).toMatch(/^gone: /);
  });

  it("is in the owner's export, JSON and ZIP", async () => {
    const user = await signIn();
    // Before anything is saved the export says so, in the same words a read does.
    const empty = await user.json<Record<string, unknown>>("/api/export");
    expect(empty.preferences).toEqual(UNSAID);
    expect(empty.format).toBe(2);

    const kept = await saved(user, chosen, 0);
    const exported = await user.json<Record<string, unknown>>("/api/export");
    expect(exported.preferences).toEqual(kept);
    expect(exported.format).toBe(2);
    // Beside the profile, and no part of it: a profile is copied into every resume, and these are not.
    const keys = Object.keys(exported);
    expect(keys[keys.indexOf("profile") + 1]).toBe("preferences");
    expect(JSON.stringify(exported.profile)).not.toContain("Toronto");

    const archive = await user.fetch("/api/export/archive");
    expect(archive.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(["vault.json"]);
    expect(JSON.parse(strFromU8(entries["vault.json"]!)).preferences).toEqual(kept);

    // Another account's export holds its own, which is nothing.
    expect((await (await signIn()).json<Record<string, unknown>>("/api/export")).preferences).toEqual(UNSAID);
  });

  it("goes with a vault moved to a replacement, revision and all", async () => {
    const email = uniqueEmail();
    const user = await signIn(email);
    expect((await user.send("PUT", "/api/profile", { name: "Sam Rivera" })).status).toBe(200);
    await saved(user, { ...chosen, place: "Leeds" }, 0);
    const before = await saved(user, chosen, 1);
    expect(before.revision).toBe(2);

    // The fenced replacement an operator runs with scripts/move-vault.mjs, step for step.
    const old = sessionOf(user);
    const operation = crypto.randomUUID();
    const { targetVaultId } = await directory(env).prepareReplacement(old.vid, operation);
    const source = vault(env, old.vid);
    const target = vault(env, targetVaultId);
    // A replacement is made with no row of its own, which is what lets the import begin.
    const count = (stub: VaultStub) => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM preferences`).one().n);
    expect(await count(target)).toBe(0);
    for (const object of [source, target, directory(env)]) await fence(object, [old.vid, targetVaultId]);
    const manifest = await source.transferManifest(operation);
    // Sent directly after the profile, as one row.
    expect(manifest.tables.slice(0, 2)).toEqual([{ name: "profile", count: 1 }, { name: "preferences", count: 1 }]);
    await target.importManifest(manifest);
    for (const table of manifest.tables) {
      const page = await source.transferPage(operation, table.name);
      expect(page.done).toBe(true);
      await target.importPage(page);
    }
    expect(await target.finishImport(operation, old.vid)).toMatchObject({ state: "ready", completedTables: manifest.tables.length });
    await directory(env).cutover(old.vid, targetVaultId, operation);
    // Checked, the replacement is let out of its fence. The old vault stays in.
    await fence(target, [old.vid]);

    const moved = await signIn(email);
    expect(sessionOf(moved)).toMatchObject({ uid: old.uid, vid: targetVaultId });
    // The same values at the same revision, saved when they were.
    expect(await read(moved)).toEqual(before);
    expect(await count(target)).toBe(1);
    // So a form that loaded them before the move is as stale or as current as it was.
    expect((await save(moved, { ...chosen, place: "York" }, 1)).status).toBe(409);
    expect(await saved(moved, { ...chosen, place: "York" }, 2)).toMatchObject({ revision: 3, place: "York" });
    expect((await moved.json<Profile>("/api/profile")).name).toBe("Sam Rivera");
    // The vault it left stays closed to its old session.
    expect((await user.fetch("/api/preferences")).status).not.toBe(200);
  });

  it("is gone when the account is deleted", async () => {
    const email = uniqueEmail();
    const user = await signIn(email);
    const { vid } = sessionOf(user);
    await saved(user, chosen, 0);
    // The audit that says whether a vault is empty counts every table it finds, this one included.
    const counted = (await vaultOf(user).deletionProbe()).rows;
    expect(await rows(user)).toHaveLength(1);
    await runInDurableObject(vaultOf(user), (_instance, state) => void state.storage.sql.exec(`DELETE FROM preferences`));
    expect((await vaultOf(user).deletionProbe()).rows).toBe(counted - 1);
    await saved(user, chosen, 0);
    expect((await vaultOf(user).deletionProbe()).rows).toBe(counted);

    expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
    // The alarm is due at once; run it now rather than waiting for the runtime to.
    await runDurableObjectAlarm(directory(env));
    await eventually(async () => {
      const page: { vaultId: string }[] = await directory(env).listVaults({ limit: 200 });
      // The newest accounts are not always on the first page, so ask the vault itself as well.
      return !page.some((row) => row.vaultId === vid) && (await vault(env, vid).deletionProbe()).rows === 0;
    }, "the account to be erased");

    // Not a row and not a table: nothing of the vault's storage is left to hold one.
    expect(await vault(env, vid).deletionProbe()).toEqual({ rows: 0 });
    const tables = await runInDurableObject(vault(env, vid), (_instance, state) =>
      state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray().map((table) => table.name).filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_")),
    );
    expect(tables).toEqual([]);
    expect((await user.fetch("/api/preferences")).status).toBe(410);
    expect((await save(user, chosen, 0)).status).toBe(410);

    // Signing in again is a new account with a new vault, and nothing said in it.
    const again = await signIn(email);
    expect(sessionOf(again).vid).not.toBe(vid);
    expect(await read(again)).toEqual(UNSAID);
  });

  it("never appears in a shared copy, a coach's view, connected-app tools, a resume, a letter, /api/me or any model input, and a save calls no model", async () => {
    // Three values found nowhere else in the fixtures or in anything the app makes from them.
    const PLACE = "Zennor-Quoit-Under-Carn-Galver";
    const AMOUNT = 508_642_031_862;
    const MONTH = "2031-07";
    const canary: PreferenceValues = { place: PLACE, jobTypes: ["temporary", "internship"], availableFrom: MONTH, payFloor: { amount: AMOUNT, currency: "ISK", period: "week" } };
    /** Whether a text holds any of the three, however the amount's digits are grouped. */
    const found = (text: string): string[] => {
      const squeezed = text.replace(/(?<=\d)[,. _'\u00a0\u202f](?=\d)/g, "");
      return [PLACE, String(AMOUNT), MONTH].filter((value) => text.toLowerCase().includes(value.toLowerCase()) || squeezed.includes(value));
    };
    expect(found(`pay floor ${AMOUNT.toLocaleString("en-US")} in ${PLACE.toUpperCase()} from ${MONTH}`)).toEqual([PLACE, String(AMOUNT), MONTH]);

    const FACT = "Built a Go service that processes 2 million events per day";
    const options: FakeModelOptions = { calls: {}, inputs: [] };
    const inputs = options.inputs!;
    // The stand-in models, with a writer that says one fact back for a letter. Every call's text is kept.
    const recording = (): Models => {
      const base = fakeModels(options);
      return {
        ...base,
        async complete(route, messages, schema, opts) {
          const asked = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
          if (route === "write" && asked.startsWith("{")) {
            inputs.push(JSON.stringify(messages));
            const data = JSON.parse(asked) as { facts?: { id: string; roleId: string | null; text: string }[] };
            const first = data.facts?.find((fact) => fact.text === FACT) ?? data.facts?.[0];
            return schema.parse({ units: first ? [{ roleId: first.roleId, text: first.text, factIds: [first.id], group: 0 }] : [] });
          }
          return base.complete(route, messages, schema, opts);
        },
      };
    };
    setModels(recording);
    const rendered: string[] = [];
    setPdfRenderer(async (_env, html) => {
      rendered.push(html);
      return new TextEncoder().encode("%PDF-1.7 synthetic");
    });

    const user = await signIn();
    expect((await user.send("PUT", "/api/profile", { name: "Sam Rivera", location: "Halifax" })).status).toBe(200);
    // Saved before anything is read or made, so every later step had the chance to pick it up.
    await saved(user, canary, 0);

    const upload = await user.upload("jane-doe.pdf", RESUME);
    expect(upload.status, await upload.clone().text()).toBe(201);
    expect((await waitForSource(user, ((await upload.json()) as { sourceId: string }).sourceId)).state).toBe("ready");
    const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
    const { roles } = await user.json<{ roles: RoleView[] }>("/api/roles");
    expect((await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
    // A fact typed by hand is indexed when it is saved, which is a model call of its own.
    expect((await user.send("POST", "/api/facts", { roleId: null, kind: "skill", text: "Rust", level: null })).status).toBe(201);

    // With facts in the vault, a save is still only a save: no model, no run, and no fact or role touched.
    const state = () =>
      runInDurableObject(vaultOf(user), (_instance, object) => ({
        runs: object.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`).one().n,
        clock: object.storage.sql.exec<{ value: number }>(`SELECT value FROM entity_incarnation_clock`).one().value,
        facts: object.storage.sql.exec(`SELECT id, revision, updated_at FROM facts ORDER BY id`).toArray(),
      }));
    const quiet = { calls: { ...options.calls }, inputs: inputs.length, state: await state() };
    expect(quiet.inputs).toBeGreaterThan(0);
    expect(quiet.state.runs).toBeGreaterThan(0);
    await saved(user, canary, 1);
    expect((await save(user, { ...canary, place: "x".repeat(121) }, 2)).status).toBe(422);
    expect((await save(user, canary, 1)).status).toBe(409);
    expect(options.calls).toEqual(quiet.calls);
    expect(inputs).toHaveLength(quiet.inputs);
    expect(await state()).toEqual(quiet.state);

    // A tailored resume and a cover letter, each made from the confirmed facts.
    const job = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
    const { applicationId } = (await job.json()) as { applicationId: string };
    const tailoring = await user.send("POST", `/api/applications/${applicationId}/resumes`);
    expect(tailoring.status, await tailoring.clone().text()).toBe(202);
    const { resumeId } = (await tailoring.json()) as { resumeId: string };
    const resume = (await waitForResume(user, resumeId)) as ResumeView;
    expect(resume.state, resume.error ?? "").toBe("ready");
    const writing = await user.send("POST", `/api/applications/${applicationId}/documents`, { kind: "letter" });
    expect(writing.status, await writing.clone().text()).toBe(202);
    const { documentId } = (await writing.json()) as { documentId: string };
    const letter = await eventually(async () => {
      const document = await user.json<DocumentView>(`/api/documents/${documentId}`);
      return document.state !== "running" ? document : null;
    }, "the letter to finish");
    expect(letter.state, letter.error ?? "").toBe("ready");

    // Everything below leaves the vault for someone or something that is not its owner's own page.
    const outward: Record<string, string> = {};
    const text = async (response: Response, what: string) => {
      expect(response.status, `${what}: ${await response.clone().text()}`).toBe(200);
      return response.text();
    };
    const docx = async (response: Response, what: string) => {
      expect(response.status, what).toBe(200);
      return strFromU8(unzipSync(new Uint8Array(await response.arrayBuffer()))["word/document.xml"]!);
    };

    // A copy with facts, the resume and the letter, its owner's name and the job on it, read by its
    // link and then by the coach it names, from their own list.
    const address = uniqueEmail("coach");
    const sharing = await user.send("POST", "/api/shares", {
      factIds: facts.slice(0, 5).map((fact) => fact.id), resumes: [{ id: resumeId, version: resume.version }], documents: [{ id: documentId, version: letter.version }],
      showName: true, showJobs: true, label: "For my coach", coachEmail: address,
    });
    expect(sharing.status, await sharing.clone().text()).toBe(201);
    const { grant, url } = (await sharing.json()) as { grant: ShareGrant; url: string };
    const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
    expect(exchange.status).toBe(200);
    const link = cookieFrom(exchange, `__Host-share-${grant.id}`)!;
    outward["the copy by its link"] = await text(await call(`/share/snapshot?g=${grant.id}`, { cookie: link }), "the copy by its link");
    // A copy's own session opens the copy and nothing of the vault it came from.
    expect((await call("/api/preferences", { cookie: link })).status).toBe(401);

    const coach = await signIn(address);
    const takeUp = await call("/api/coach/clients", { method: "POST", cookie: `${link}; ${coach.cookie}`, headers: { "content-type": "application/json" }, body: JSON.stringify({ grantId: grant.id }) });
    expect(takeUp.status, await takeUp.clone().text()).toBe(204);
    const opened = await coach.send("POST", `/api/coach/clients/${grant.id}/open`);
    expect(opened.status).toBe(200);
    outward["the copy as its coach opens it"] = await text(
      await call(`/share/snapshot?g=${grant.id}`, { cookie: `${cookieFrom(opened, `__Host-share-${grant.id}`)}; ${coach.cookie}` }),
      "the copy as its coach opens it",
    );
    outward["the coach's client list"] = JSON.stringify(await coach.json<{ clients: CoachClient[] }>("/api/coach/clients"));
    // A coach is an ordinary account: their card is their own, and theirs says nothing.
    expect(await read(coach)).toEqual(UNSAID);
    outward["the coach's own export"] = JSON.stringify(await coach.json("/api/export"));
    expect(await refusal(vaultOf(user).getPreferences(whoOf(coach)))).toBe("forbidden: not this user's vault");

    // A connected app that was given every permission there is.
    const who = whoOf(user);
    const granted = await vaultOf(user).createMcpGrant(who, {
      id: crypto.randomUUID(), clientId: "synthetic-client", clientName: "Synthetic client",
      scopes: ["vault:read", "vault:generate", "vault:jobs", "offline_access"], expiresAt: Date.now() + 10 * 60_000,
    });
    const claims: McpClaims = { uid: who.userId, vid: sessionOf(user).vid, gen: granted.gen, epoch: granted.epoch, grantId: granted.id, clientId: granted.clientId, scopes: granted.scopes, expiresAt: granted.expiresAt };
    await vaultOf(user).bindMcpGrant(claims, "synthetic-oauth-grant");
    // The Vault's methods for connected apps are asked through this, which notes each one asked, so
    // that a method added later fails this test until its answer is read here too.
    const asked = new Set<string>();
    const apps = new Proxy(vaultOf(user), {
      get(stub, name) {
        if (typeof name === "string") asked.add(name);
        return Reflect.get(stub, name);
      },
    });
    const listed = (await apps.mcpFacts(claims, {})) as unknown[];
    expect(listed.length).toBeGreaterThan(5);
    outward["list_facts"] = JSON.stringify(listed);
    outward["search_facts"] = JSON.stringify(await apps.mcpFacts(claims, { query: "Kubernetes" }));
    // Searching for the place itself finds nothing: it is not a fact, and no fact holds it.
    expect(await apps.mcpFacts(claims, { query: PLACE })).toEqual([]);
    expect(await apps.mcpFacts(claims, { query: String(AMOUNT) })).toEqual([]);
    outward["get_resume"] = JSON.stringify(await apps.mcpResume(claims, resumeId));
    outward["add_job"] = JSON.stringify(
      await apps.mcpAddJob(claims, { description: "Platform Engineer at Litware. Run our Kubernetes fleet and build the tools product teams ship with.", url: "https://jobs.example.com/litware/platform-engineer" }, crypto.randomUUID()),
    );
    outward["list_jobs"] = JSON.stringify(await apps.mcpJobs(claims, {}));
    const started = await apps.mcpTailor(claims, applicationId, crypto.randomUUID());
    outward["start_tailoring"] = JSON.stringify(started);
    const second = (await waitForResume(user, started.resumeId)) as ResumeView;
    expect(second.state, second.error ?? "").toBe("ready");
    outward["get_resume, for the one the app started"] = JSON.stringify(await apps.mcpResume(claims, started.resumeId));
    // The epoch an app's grant is checked against, which the consent page asks for with the owner's session.
    const identity = await apps.mcpIdentity(who);
    expect(identity).toEqual({ epoch: expect.any(String) });
    expect(found(JSON.stringify(identity))).toEqual([]);
    // Every method named for connected apps was asked above, and nothing else was asked of it.
    const tools = Object.getOwnPropertyNames(Vault.prototype).filter((name) => /^mcp[A-Z]/.test(name) && typeof Object.getOwnPropertyDescriptor(Vault.prototype, name)!.value === "function");
    expect(tools).toContain("mcpJobs");
    expect([...asked].sort()).toEqual(tools.sort());

    // What is made for the owner to send on: the resume and the letter, in each form they are given in.
    for (const [name, id] of [["the resume", resumeId], ["the resume a connected app started", started.resumeId]] as const) {
      outward[`${name} as JSON`] = await text(await user.fetch(`/api/resumes/${id}`), name);
      outward[`${name} as a preview`] = await text(await user.fetch(`/api/resumes/${id}/preview`), name);
      outward[`${name} as a Word file`] = await docx(await user.fetch(`/api/resumes/${id}/docx`), name);
      expect((await user.fetch(`/api/resumes/${id}/pdf`)).status, name).toBe(200);
    }
    expect(rendered).toHaveLength(2);
    outward["the pages printed as PDF"] = rendered.join("\n");
    outward["the letter as JSON"] = await text(await user.fetch(`/api/documents/${documentId}`), "the letter");
    outward["the letter as a Word file"] = await docx(await user.fetch(`/api/documents/${documentId}/docx`), "the letter");
    // What loads with every page, and the contact details every resume is headed with.
    const me = await user.json<Me>("/api/me");
    outward["/api/me"] = JSON.stringify(me);
    outward["the profile"] = JSON.stringify(await user.json("/api/profile"));
    // Everything a model was sent, of every kind: reading the upload, indexing, ranking, reading
    // the posting, writing and judging, for both resumes and the letter.
    for (const route of ["extract", "analyze", "write", "judge", "embed", "rerank"] as const) expect(options.calls![route], route).toBeGreaterThan(0);
    expect(inputs.length).toBeGreaterThan(quiet.inputs);
    expect(inputs.some((input) => input.includes(FACT))).toBe(true);
    outward["every model input"] = inputs.join("\n");

    for (const [surface, said] of Object.entries(outward)) {
      expect(said.length, surface).toBeGreaterThan(20);
      expect(found(said), surface).toEqual([]);
    }
    // The surfaces above really carry what they are for, so a place among them would have been seen.
    expect(outward["the copy by its link"]).toContain("Sam Rivera");
    expect(outward["the copy as its coach opens it"]).toContain(FACT);
    // A place to work is not where someone lives: the resume is headed with the profile's own location.
    expect(me.profile.location).toBe("Halifax");
    expect(outward["the resume as a preview"]).toContain("Halifax");
    expect(outward["the pages printed as PDF"]).toContain("Halifax");
    expect(outward["the letter as a Word file"]).toContain(FACT);
    expect(outward["list_facts"]).toContain("Kubernetes");

    // And all three are where they belong: with their owner, read back and in the export.
    expect(found(JSON.stringify(await read(user)))).toEqual([PLACE, String(AMOUNT), MONTH]);
    expect(found(await (await user.fetch("/api/export")).text())).toEqual([PLACE, String(AMOUNT), MONTH]);
  }, 120_000);

  it("gains the table in a vault made before it, with the profile as it was", async () => {
    const user = await signIn();
    expect((await user.send("PUT", "/api/profile", { name: "Sam Rivera", location: "Halifax", links: ["https://example.com/sam"] })).status).toBe(200);
    const before = await user.json<Profile>("/api/profile");
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const sql = state.storage.sql;
      // Rewind this vault to the schema before job preferences, as an older vault would be.
      removePreferencesMigration(sql);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("CREATE TABLE preferences")));
      expect(previous).toBeGreaterThan(-1);
      const tables = () => sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preferences'`).toArray();
      expect(tables()).toEqual([]);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(tables()).toEqual([{ name: "preferences" }]);
      // The migration makes the table and no row: an older vault has said nothing.
      expect(sql.exec(`SELECT COUNT(*) AS n FROM preferences`).one()).toEqual({ n: 0 });
      // No index and no trigger come with it.
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE tbl_name = 'preferences' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%'`).toArray()).toEqual([]);
    });
    expect(await user.json<Profile>("/api/profile")).toEqual(before);
    // And the table works: nothing said, then a first save.
    expect(await read(user)).toEqual(UNSAID);
    expect(await saved(user, chosen, 0)).toMatchObject({ revision: 1, place: "Toronto, Ontario" });
    expect(await user.json<Profile>("/api/profile")).toEqual(before);
  });

  it("logs none of what was typed, whether saved or refused", async () => {
    const PLACE = "Porthcurno-Canary-Cove";
    const AMOUNT = 731_550_246_908;
    const typed = { place: PLACE, jobTypes: ["full_time"], availableFrom: "2029-09", payFloor: { amount: AMOUNT, currency: "NOK", period: "month" } } satisfies PreferenceValues;
    const user = await signIn();
    const metric = vi.fn();
    const bindings = { ...env, RATE_LIMITS_ENABLED: "false", METRICS: { writeDataPoint: metric } } as unknown as Env;
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const fetch = worker.fetch as (request: Request, env: Env, context: ExecutionContext) => Promise<Response>;
    const send = (body: unknown) =>
      fetch(new Request(`${ORIGIN}/api/preferences`, { method: "PUT", headers: { cookie: user.cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), bindings, {} as ExecutionContext);
    try {
      // Saved, refused by the rule, refused for its shape, refused as stale, and read back.
      expect((await send({ ...typed, expectedRevision: 0 })).status).toBe(200);
      expect((await send({ ...typed, place: `${PLACE}\n${PLACE}`, expectedRevision: 1 })).status).toBe(422);
      expect((await send({ ...typed, expectedRevision: 1, workAuthorisation: PLACE, [PLACE]: AMOUNT })).status).toBe(422);
      expect((await send({ ...typed, payFloor: { ...typed.payFloor, amount: AMOUNT + 0.5 }, expectedRevision: 1 })).status).toBe(422);
      expect((await send({ ...typed, expectedRevision: 0 })).status).toBe(409);
      const reading = await fetch(new Request(`${ORIGIN}/api/preferences`, { headers: { cookie: user.cookie } }), bindings, {} as ExecutionContext);
      expect(reading.status).toBe(200);
      expect(((await reading.json()) as Preferences).place).toBe(PLACE);

      // Each request is counted as a route category, a status and a duration, and nothing else.
      expect(metric).toHaveBeenCalledTimes(6);
      for (const [point] of metric.mock.calls as [{ indexes: string[]; blobs: string[]; doubles: number[] }][]) {
        expect(point.indexes).toEqual(["http"]);
        expect(point.blobs).toEqual(["", "http", "other", "", "ok"]);
        expect(point.doubles).toEqual([expect.any(Number), 0, 0, 0]);
      }
      const written = JSON.stringify([metric.mock.calls, ...logs.map((log) => log.mock.calls)]);
      for (const value of [PLACE, String(AMOUNT), "2029-09"]) expect(written).not.toContain(value);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });
});
