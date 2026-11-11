import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView, RoleView } from "../../src/shared/api";
import type { RecordExport, RecordLink, Stamp } from "../../src/shared/record";
import { vault } from "../../src/shared/stubs";
import { RecordStore } from "../../src/vault/record";
import { Vault } from "../../src/vault/vault";
import { fromBase64url } from "../../src/worker/crypto";
import { RESUME, fakeModels, signIn, waitForSource, type User } from "./support";

// Noting what an upload says again while it is read: off unless switched on, and in shadow when on.

const settings = env as unknown as { MATCH_SHADOW_ENABLED?: string };
const AS_CONFIGURED = settings.MATCH_SHADOW_ENABLED;
const BUILT = "Built a Go service that processes 2 million events per day";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => {
  setModels(null);
  settings.MATCH_SHADOW_ENABLED = AS_CONFIGURED;
  vi.restoreAllMocks();
});

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}

/** Reads one more copy of the same resume. `extra` makes the file a different file. */
async function read(user: User, extra = ""): Promise<string> {
  const response = await user.upload(`jane-doe${extra ? "-again" : ""}.pdf`, `${RESUME}${extra}`);
  expect(response.status, await response.clone().text()).toBe(201);
  const { sourceId } = (await response.json()) as { sourceId: string };
  expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
  return sourceId;
}

const shown = async (user: User) => ({
  facts: (await user.json<{ facts: FactView[] }>("/api/facts")).facts,
  roles: (await user.json<{ roles: RoleView[] }>("/api/roles")).roles,
});

function inVault<T>(user: User, work: (record: RecordStore) => T): Promise<T> {
  return runInDurableObject(vaultOf(user), (_instance, state) => work(new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn))));
}

describe("reading a second copy of a resume as it is configured everywhere today", () => {
  it("notes nothing about what it says again", async () => {
    expect(AS_CONFIGURED).toBeUndefined();
    const user = await signIn();
    await read(user);
    await read(user, "\nVolunteer: Code Club mentor, 2019");
    expect((await shown(user)).facts).toHaveLength(16);
    expect(await inVault(user, (record) => record.export())).toEqual({ factSplits: [], conceptTags: [], recordLinks: [] });
  });
});

describe("reading with shadow matching switched on", () => {
  beforeEach(() => {
    settings.MATCH_SHADOW_ENABLED = "true";
  });

  it("notes every role and line that repeats an earlier one, merges nothing, and changes nothing the app shows", async () => {
    const user = await signIn();
    const first = await read(user);
    // One upload repeats nothing.
    expect((await inVault(user, (record) => record.export())).recordLinks).toEqual([]);
    const second = await read(user, "\nVolunteer: Code Club mentor, 2019");
    const after = await shown(user);
    // Every role and fact of both uploads is still listed, each as it was read.
    expect(after.roles).toHaveLength(6);
    expect(after.facts).toHaveLength(16);
    const sourceOf = new Map<string, string | null>([...after.roles, ...after.facts].map((item) => [item.id, item.sourceId]));

    const links = (await inVault(user, (record) => record.export())).recordLinks;
    // Three jobs and courses, five lines and three skills, each said again by the second upload.
    expect(links.filter((link) => link.kind === "role")).toHaveLength(3);
    expect(links.filter((link) => link.kind === "fact")).toHaveLength(8);
    for (const link of links) {
      expect(link).toMatchObject({ relation: "same", state: "proposed", shadow: true, holds: false, proposedBy: "rule", model: null, decidedBy: null, method: link.kind === "role" ? "identical-role/2" : "identical-wording/2" });
      // The later copy points at the earlier one.
      expect([sourceOf.get(link.from), sourceOf.get(link.to)], link.id).toEqual([second, first]);
    }
    const text = new Map(after.facts.map((fact) => [fact.id, fact.text]));
    for (const link of links.filter((found) => found.kind === "fact")) expect(text.get(link.from)).toBe(text.get(link.to));

    // In shadow nothing is merged: each fact still stands for itself, with its own one quote.
    const built = after.facts.filter((fact) => fact.text === BUILT);
    expect(built).toHaveLength(2);
    const standing = await inVault(user, (record) => built.map((fact) => ({ root: record.root("fact", fact.id), quotes: record.evidenceOf(fact.id).length, visible: record.links("fact", fact.id) })));
    expect(standing).toEqual(built.map((fact) => ({ root: fact.id, quotes: 1, visible: [] })));

    // It is the person's data, so their export has it, marked as in shadow.
    const exported = await user.json<RecordExport>("/api/export");
    expect(exported.recordLinks).toHaveLength(11);
    expect(exported.recordLinks.every((link) => link.shadow)).toBe(true);
  });

  it("points a third copy at the first, and stores nothing twice", async () => {
    const user = await signIn();
    const first = await read(user);
    await read(user, "\nVolunteer: Code Club mentor, 2019");
    const before = (await inVault(user, (record) => record.export())).recordLinks;
    const third = await read(user, "\nSpeaker: local meetup, 2020");
    const after = await shown(user);
    const sourceOf = new Map<string, string | null>([...after.roles, ...after.facts].map((item) => [item.id, item.sourceId]));
    const links = (await inVault(user, (record) => record.export())).recordLinks;
    expect(links).toHaveLength(22);
    // What was noted for the second copy is exactly as it was.
    expect(links.slice(0, 11)).toEqual(before);
    for (const link of links.slice(11)) expect([sourceOf.get(link.from), sourceOf.get(link.to)]).toEqual([third, first]);
  });

  it("finds only what the record itself would merge without asking", async () => {
    const user = await signIn();
    await read(user);
    await read(user, "\nVolunteer: Code Club mentor, 2019");
    await read(user, "\nSpeaker: local meetup, 2020");
    const facts = (await shown(user)).facts.filter((fact) => fact.text === BUILT);
    const merged = await inVault(user, (record) => {
      const found = record.export().recordLinks;
      const rule = (link: RecordLink): Stamp => ({ proposedBy: "rule", model: null, method: link.method, taxonomyVersion: null, confidence: null, shadow: false });
      // Roles first, as the record requires, then the lines inside them. Each is put to the
      // record's own check of identity, where anything less than identical is refused.
      const states = [...found.filter((link) => link.kind === "role"), ...found.filter((link) => link.kind === "fact")].map(
        (link) => record.proposeLink({ kind: link.kind, from: link.from, to: link.to, relation: "same", stamp: rule(link), confirm: true }).state,
      );
      return { states, quotes: record.evidenceOf(facts[facts.length - 1]!.id), roots: facts.map((fact) => record.root("fact", fact.id)) };
    });
    expect(merged.states).toHaveLength(22);
    expect(new Set(merged.states)).toEqual(new Set(["confirmed"]));
    // The earliest copy of the line now stands for all three, with the quote from each upload.
    const earliest = facts[facts.length - 1]!.id;
    expect(merged.roots).toEqual(facts.map(() => earliest));
    expect(merged.quotes).toHaveLength(3);
    expect(new Set(merged.quotes.map((quote) => quote.sourceId)).size).toBe(3);
  });

  it("gets one try: when the stage runs out of time it is not run again, and the upload finishes", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      // The stage's first try runs out of time before it does anything. A second try would note the copies.
      await reading.modifyAll(async (step) => {
        await step.forceStepTimeout({ name: "match" }, 1);
      });
      const user = await signIn();
      await read(user);
      await read(user, "\nVolunteer: Code Club mentor, 2019");
      expect((await shown(user)).facts).toHaveLength(16);
      expect((await inVault(user, (record) => record.export())).recordLinks).toEqual([]);
    } finally {
      await reading.dispose();
    }
  });

  it("finishes the upload with every fact when matching fails", async () => {
    const failing = vi.spyOn(Vault.prototype, "matchShadow").mockRejectedValue(new Error("unavailable: storage is busy"));
    const user = await signIn();
    await read(user);
    await read(user, "\nVolunteer: Code Club mentor, 2019");
    expect(failing).toHaveBeenCalled();
    expect((await shown(user)).facts).toHaveLength(16);
    expect((await inVault(user, (record) => record.export())).recordLinks).toEqual([]);
  });
});
