import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import type { Me } from "../../src/shared/api";
import { CARD_PREVIEW_OFF, type CardPreview } from "../../src/shared/card";
import type { ConceptKind } from "../../src/taxonomy";
import type { Stamp, TagSubject } from "../../src/shared/record";
import type { ShareGrant } from "../../src/shared/sharing";
import { vault } from "../../src/shared/stubs";
import { RecordStore } from "../../src/vault/record";
import { Vault } from "../../src/vault/vault";
import { fromBase64url } from "../../src/worker/crypto";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";
import { outwardParts } from "./outward";
import { call, fakeModels, signIn, uniqueEmail, type User } from "./support";

// The owner's private card preview: off unless switched on, inert without a wholly loaded
// taxonomy, read from the session's own vault only, and shown to its owner alone. The taxonomy is
// the made-up one, loaded into the local D1 database before each test. No path in the app confirms
// a tag, so tests confirm them directly through the record, as the owner's review one day will.

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KUBERNETES = "onet:tool:kubernetes";
const VERSION = TAXONOMY_FIXTURE.info.version;
/** The groups the made-up taxonomy puts S(1) and Kubernetes in. */
const RESOURCES = { id: "esco:skill:S1.1", label: "allocating and controlling resources" };
const ORCHESTRATION = { id: "onet:toolcat:5.A.1.02", label: "Container orchestration software" };
const DEVELOPER = { id: O(1), label: "software developer" };
/** What a tag keeps as its label. A card never shows it: it shows the taxonomy's own. */
const STORED_LABEL = "Stored label xq";

const settings = env as unknown as { CARD_PREVIEW_ENABLED?: string; TAXONOMY?: D1Database };
const AS_CONFIGURED = { card: settings.CARD_PREVIEW_ENABLED, taxonomy: settings.TAXONOMY! };

const TABLES = ["taxonomy_meta", "concepts", "labels", "relations"] as const;
/** Empties the taxonomy's database, then runs these statements of a load in order. */
async function load(statements: readonly string[] = TAXONOMY_FIXTURE_SQL): Promise<void> {
  const db = AS_CONFIGURED.taxonomy;
  for (const table of TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const statement of statements) await db.prepare(statement).run();
}

beforeEach(async () => {
  await load();
  setModels(() => fakeModels());
  settings.CARD_PREVIEW_ENABLED = "true";
});
afterEach(() => {
  setModels(null);
  settings.CARD_PREVIEW_ENABLED = AS_CONFIGURED.card;
  settings.TAXONOMY = AS_CONFIGURED.taxonomy;
  vi.restoreAllMocks();
});

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
const whoOf = (user: User) => ({ userId: sessionOf(user).uid, gen: sessionOf(user).gen, epoch: sessionOf(user).epoch });

const owner: Stamp = { proposedBy: "owner", model: null, method: "owner", taxonomyVersion: VERSION, confidence: null, shadow: false };
const proposed: Stamp = { proposedBy: "model", model: "@cf/test/judge", method: "judge/1", taxonomyVersion: VERSION, confidence: null, shadow: false };
const shadow: Stamp = { ...proposed, shadow: true };

/** Stores a tag in the user's vault, through the record as a reading or the owner's review would. */
function tag(user: User, subject: TagSubject, conceptId: string, conceptKind: ConceptKind, stamp: Stamp = owner) {
  return runInDurableObject(vaultOf(user), (_instance, state) =>
    new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)).proposeTag({ subject, conceptId, conceptKind, label: STORED_LABEL, stamp }),
  );
}

async function job(user: User, fields: { org?: string; title?: string; startDate?: string | null; endDate?: string | null } = {}): Promise<string> {
  const response = await user.send("POST", "/api/roles", {
    kind: "job",
    org: fields.org ?? "Fabrikam Logistics",
    title: fields.title ?? "Principal Platform Engineer",
    startDate: fields.startDate === undefined ? "2016-03" : fields.startDate,
    endDate: fields.endDate === undefined ? null : fields.endDate,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { roleId: string }).roleId;
}
async function fact(user: User, roleId: string | null, text: string, kind = "accomplishment"): Promise<string> {
  const response = await user.send("POST", "/api/facts", { roleId, kind, text, level: null });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { factId: string }).factId;
}
const mark = (user: User, ids: string[], sensitive = true) => user.send("POST", "/api/facts/sensitive", { ids, sensitive });

async function preview(user: User): Promise<CardPreview> {
  const response = await user.fetch("/api/v2/card-preview");
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as CardPreview;
}
async function card(user: User) {
  const answer = await preview(user);
  if (answer.state !== "ready") throw new Error("expected a card");
  expect(answer.taxonomyVersion).toBe(VERSION);
  return answer.card;
}
/** What the Vault says when asked for a card's material directly, as `who`. */
const asking = (user: User, who: ReturnType<typeof whoOf>) =>
  runInDurableObject(vaultOf(user), async (instance) => {
    try {
      await instance.cardMaterial(who);
      return "given";
    } catch (error) {
      return (error as Error).message;
    }
  });
const capability = async (user: User) => (await user.json<Me>("/api/me")).capabilities?.cardPreview;

/** A job with a confirmed occupation, and two facts under it whose confirmed tags show S(1) and Kubernetes. */
async function tagged(user: User) {
  const roleId = await job(user);
  const budgets = await fact(user, roleId, "Cut the platform budget by a fifth through quarterly reviews");
  const cluster = await fact(user, roleId, "Ran the Zephyrine cluster for 40 teams");
  await tag(user, { kind: "role", id: roleId }, O(1), "occupation");
  await tag(user, { kind: "fact", id: budgets }, S(1), "skill");
  await tag(user, { kind: "fact", id: cluster }, KUBERNETES, "tool");
  return { roleId, budgets, cluster };
}

describe("the card preview", () => {
  it("is switched off unless CARD_PREVIEW_ENABLED is exactly true", async () => {
    const user = await signIn();
    const material = vi.spyOn(Vault.prototype, "cardMaterial");
    for (const value of [undefined, "false", "TRUE", "1"]) {
      settings.CARD_PREVIEW_ENABLED = value;
      const response = await user.fetch("/api/v2/card-preview");
      expect(response.status, String(value)).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable", message: CARD_PREVIEW_OFF });
      expect(await capability(user), String(value)).toBe(false);
      // The Vault refuses on its own account too: it is not only the route that checks.
      expect(await asking(user, whoOf(user))).toBe(`unavailable: ${CARD_PREVIEW_OFF}`);
    }
    // Only the four direct calls reached the Vault: the route asked it nothing.
    expect(material).toHaveBeenCalledTimes(4);
    material.mockClear();
    settings.CARD_PREVIEW_ENABLED = "true";
    expect(await capability(user)).toBe(true);
    expect(await preview(user)).toEqual({ state: "ready", taxonomyVersion: VERSION, card: { occupation: null, experience: null, skills: [] } });
    expect(material).toHaveBeenCalledTimes(1);
  });

  it("says it is unavailable without a taxonomy, or with one part-loaded", async () => {
    const user = await signIn();
    await tagged(user);
    const material = vi.spyOn(Vault.prototype, "cardMaterial");
    settings.TAXONOMY = undefined;
    expect(await preview(user)).toEqual({ state: "unavailable" });
    settings.TAXONOMY = AS_CONFIGURED.taxonomy;
    for (const statements of [[], TAXONOMY_FIXTURE_SQL.slice(0, -1)]) {
      await load(statements);
      expect(await preview(user)).toEqual({ state: "unavailable" });
    }
    // The vault was never read: not its tags, not its jobs.
    expect(material).not.toHaveBeenCalled();
    // The page offers the section all the same, and says why it shows nothing.
    expect(await capability(user)).toBe(true);
    await load();
    expect((await card(user)).occupation).toEqual(DEVELOPER);
  });

  it("is empty on a vault with no confirmed tags, shadow and proposed ones included", async () => {
    const user = await signIn();
    expect(await card(user)).toEqual({ occupation: null, experience: null, skills: [] });
    const roleId = await job(user, { startDate: "2020-01", endDate: "2023-12" });
    const factId = await fact(user, roleId, "Cut the platform budget by a fifth through quarterly reviews");
    await tag(user, { kind: "role", id: roleId }, O(1), "occupation", shadow);
    await tag(user, { kind: "fact", id: factId }, S(1), "skill", shadow);
    await tag(user, { kind: "role", id: roleId }, O(2), "occupation", proposed);
    await tag(user, { kind: "fact", id: factId }, KUBERNETES, "tool", proposed);
    // Dates are not tags: a confirmed job still gives its band.
    expect(await card(user)).toEqual({ occupation: null, experience: "2-5", skills: [] });
  });

  it("shows confirmed tags at their group level, and no name, employer, title, date, fact word or row ID", async () => {
    const user = await signIn();
    expect((await user.send("PUT", "/api/profile", { name: "Imogen Quarrie", email: "imogen@example.com", phone: "", location: "Leeds", links: [] })).status).toBe(200);
    const { roleId, budgets, cluster } = await tagged(user);
    const earlier = await job(user, { org: "Tailspin Toys", title: "Build Engineer", startDate: "2012-05", endDate: "2016-02" });
    await tag(user, { kind: "role", id: earlier }, O(3), "occupation");
    // A skills-list item is self-declared: its tag is confirmed, and the card still leaves it out.
    const listed = await fact(user, null, "Python", "skill");
    await tag(user, { kind: "fact", id: listed }, S(3), "knowledge");

    const response = await user.fetch("/api/v2/card-preview");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      state: "ready",
      taxonomyVersion: VERSION,
      // The current job's occupation; ten years and more from March 2012 to now; each skill as its group, by the taxonomy's label.
      card: { occupation: DEVELOPER, experience: "10-plus", skills: [RESOURCES, ORCHESTRATION] },
    });
    for (const word of ["Imogen", "Quarrie", "Leeds", "Fabrikam", "Tailspin", "Principal Platform Engineer", "Build Engineer", "2016", "2012", "Zephyrine", "budget", "Python", STORED_LABEL, roleId, earlier, budgets, cluster, listed, sessionOf(user).vid, sessionOf(user).uid])
      expect(text, word).not.toContain(word);
  });

  it("leaves out a marked fact's concept, and shows it again when unmarked", async () => {
    const user = await signIn();
    const { roleId, budgets } = await tagged(user);
    // Another fact shows the marked fact's concept too. The card shows neither while the mark stands.
    const second = await fact(user, roleId, "Kept three product lines inside their annual budgets");
    await tag(user, { kind: "fact", id: second }, S(1), "skill");
    expect((await card(user)).skills).toEqual([RESOURCES, ORCHESTRATION]);
    expect((await mark(user, [budgets])).status).toBe(204);
    expect((await card(user)).skills).toEqual([ORCHESTRATION]);
    expect((await mark(user, [budgets], false)).status).toBe(204);
    expect((await card(user)).skills).toEqual([RESOURCES, ORCHESTRATION]);
  });

  it("gives another account's session its own card, and the vault refuses another account's identity", async () => {
    const sam = await signIn();
    await tagged(sam);
    const dana = await signIn();
    expect((await card(sam)).skills).toEqual([RESOURCES, ORCHESTRATION]);
    // Dana's session reads Dana's vault, which holds nothing.
    expect(await card(dana)).toEqual({ occupation: null, experience: null, skills: [] });
    // Sam's vault, asked with Dana's identity, refuses.
    expect(await asking(sam, whoOf(dana))).toMatch(/^forbidden: /);
    // A stale generation is not the owner either.
    expect(await asking(sam, { ...whoOf(sam), gen: whoOf(sam).gen + 1 })).toMatch(/^unauthenticated: /);
    expect(await asking(sam, whoOf(sam))).toBe("given");
    // The request can't name another vault: there is nothing in it to name one with.
    const query = await dana.fetch(`/api/v2/card-preview?vault=${sessionOf(sam).vid}&user=${sessionOf(sam).uid}`);
    expect(((await query.json()) as CardPreview & { card: unknown }).card).toEqual({ occupation: null, experience: null, skills: [] });
  });

  it("gives a coach holding a copy only their own card; no coach path or copy holds the owner's card", async () => {
    const sam = await signIn();
    const { budgets, cluster } = await tagged(sam);
    const coach = await signIn(uniqueEmail("coach"));
    const response = await sam.send("POST", "/api/shares", { factIds: [budgets, cluster], resumes: [], coachEmail: coach.email });
    expect(response.status, await response.clone().text()).toBe(201);
    const { grant, url } = (await response.json()) as { grant: ShareGrant; url: string };
    const copy = { grant, token: new URL(url).hash.slice(1), coach };
    const parts = await outwardParts({ owner: sam, copies: [copy], inputs: [] });
    // The copy was read by its link and by its coach: the canary isn't looking at nothing.
    expect(parts.map((part) => part.surface)).toEqual(expect.arrayContaining(["copy by its link", "copy as its coach", "coach's client list", "card preview"]));
    // The owner's groups are on the owner's card and nowhere else.
    for (const label of [RESOURCES.label, ORCHESTRATION.label, DEVELOPER.label])
      expect(parts.filter((part) => part.text.includes(label)).map((part) => part.surface), label).toEqual(["card preview"]);
    // The coach, holding the copy, sees their own empty card.
    expect(await card(coach)).toEqual({ occupation: null, experience: null, skills: [] });
  });

  it("keeps a marked fact's tag out of every outward surface, the card preview included", async () => {
    const user = await signIn();
    const { budgets } = await tagged(user);
    const before = await outwardParts({ owner: user, copies: [], inputs: [] });
    // The control: unmarked, its group leaves by the card preview.
    expect(before.filter((part) => part.text.includes(RESOURCES.label)).map((part) => part.surface)).toEqual(["card preview"]);
    expect((await mark(user, [budgets])).status).toBe(204);
    const after = await outwardParts({ owner: user, copies: [], inputs: [] });
    // The card is still among the surfaces read, and the marked fact's group is in none of them.
    expect(after.map((part) => part.surface)).toContain("card preview");
    expect(after.map((part) => part.text).join("\n")).not.toContain(RESOURCES.label);
    expect(after.map((part) => part.text).join("\n")).not.toContain(RESOURCES.id);
    expect(after.find((part) => part.surface === "card preview")!.text).toContain(ORCHESTRATION.label);
  });

  it("refuses a signed-out request", async () => {
    const material = vi.spyOn(Vault.prototype, "cardMaterial");
    const response = await call("/api/v2/card-preview");
    expect(response.status).toBe(401);
    expect(material).not.toHaveBeenCalled();
  });
});
