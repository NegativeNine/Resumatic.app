import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import type { FactView } from "../../src/shared/api";
import { vault } from "../../src/shared/stubs";
import { RecordStore } from "../../src/vault/record";
import { fromBase64url } from "../../src/worker/crypto";
import { EXTRACTION, RESUME, fakeModels, signIn, waitForSource, type FakeModelOptions, type User } from "./support";

// Offering two wordings of one thing while an upload is read: off unless switched on, and in
// shadow when on. A second resume here says one line of the first a little more fully.

const SHORT = "Mentored 2 junior engineers";
const LONG = "Mentored 2 junior engineers every quarter";
const RESUME_2 = RESUME.replace(`- ${SHORT}`, `- ${LONG}`);
const EXTRACTION_2 = { ...EXTRACTION, facts: EXTRACTION.facts.map((fact) => (fact.text === SHORT ? { ...fact, text: LONG, quote: LONG } : fact)) };

const settings = env as unknown as { OFFER_SHADOW_ENABLED?: string; MATCH_SHADOW_ENABLED?: string };
const AS_CONFIGURED = { offer: settings.OFFER_SHADOW_ENABLED, match: settings.MATCH_SHADOW_ENABLED };

afterEach(() => {
  setModels(null);
  settings.OFFER_SHADOW_ENABLED = AS_CONFIGURED.offer;
  settings.MATCH_SHADOW_ENABLED = AS_CONFIGURED.match;
});

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}

async function read(user: User, filename: string, content: string): Promise<void> {
  const response = await user.upload(filename, content);
  expect(response.status, await response.clone().text()).toBe(201);
  const { sourceId } = (await response.json()) as { sourceId: string };
  expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
}

/** Reads the first resume, then the second with these models, and gives back what the record holds. */
async function twice(second: FakeModelOptions, wrap: (models: Models, user: User) => Models = (models) => models) {
  const user = await signIn();
  setModels(() => fakeModels());
  await read(user, "jane-doe.pdf", RESUME);
  const options: FakeModelOptions = { calls: {}, extraction: EXTRACTION_2, ...second };
  setModels(() => wrap(fakeModels(options), user));
  await read(user, "jane-doe-2024.pdf", RESUME_2);
  const facts = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
  const links = await runInDurableObject(vaultOf(user), (_instance, state) => {
    const record = new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn));
    return { all: record.export().recordLinks, shown: facts.flatMap((fact) => record.links("fact", fact.id)) };
  });
  return { facts, links, calls: options.calls!, long: facts.find((fact) => fact.text === LONG)!, short: facts.find((fact) => fact.text === SHORT)! };
}

describe("reading a second resume as it is configured everywhere today", () => {
  it("asks no judge about its lines and offers nothing", async () => {
    expect(AS_CONFIGURED).toEqual({ offer: undefined, match: undefined });
    const { facts, links, calls, long, short } = await twice({});
    expect(facts).toHaveLength(16);
    expect(long.id).not.toBe(short.id);
    expect(calls.judge).toBeUndefined();
    expect(links.all).toEqual([]);
  });
});

describe("reading with shadow offers switched on", () => {
  it("offers the line that says more as a fuller version, in shadow, and changes nothing the app shows", async () => {
    settings.OFFER_SHADOW_ENABLED = "true";
    // This judge finds the longer line says something the shorter one doesn't.
    const { facts, links, calls, long, short } = await twice({ judgeRejects: ["every quarter"] });
    expect(facts).toHaveLength(16);
    // One pair was worth asking about, so one call: every other line of the second resume is
    // word for word a line of the first, and no other line is near these two in meaning.
    expect(calls.judge).toBe(1);
    expect(links.all).toHaveLength(1);
    expect(links.all[0]).toMatchObject({
      kind: "fact",
      relation: "fuller",
      from: long.id,
      to: short.id,
      state: "proposed",
      shadow: true,
      holds: false,
      proposedBy: "model",
      model: env.MODEL_JUDGE,
      method: "entailment/2",
      decidedBy: null,
    });
    expect(links.shown).toEqual([]);
    // Both lines are still listed, each exactly as it was read.
    expect([long.state, short.state]).toEqual(["proposed", "proposed"]);
  });

  it("offers two lines as the same when the judge finds each says everything the other says", async () => {
    settings.OFFER_SHADOW_ENABLED = "true";
    const { links, long, short } = await twice({});
    expect(links.all).toMatchObject([{ relation: "same", from: long.id, to: short.id, state: "proposed", shadow: true, holds: false }]);
    expect(links.shown).toEqual([]);
  });

  it("offers nothing when the judge finds neither says everything the other says", async () => {
    settings.OFFER_SHADOW_ENABLED = "true";
    const { links, calls } = await twice({ judgeRejects: ["Mentored"] });
    expect(calls.judge).toBe(1);
    expect(links.all).toEqual([]);
  });

  it("keeps offers beside the copies a rule found, without confusing the two", async () => {
    settings.OFFER_SHADOW_ENABLED = "true";
    settings.MATCH_SHADOW_ENABLED = "true";
    const { links, long, short } = await twice({ judgeRejects: ["every quarter"] });
    // Three roles and seven lines are word for word the same. The eighth line is the offer.
    expect(links.all.filter((link) => link.proposedBy === "rule").map((link) => link.method).sort()).toEqual([...Array(3).fill("identical-role/2"), ...Array(7).fill("identical-wording/2")].sort());
    expect(links.all.filter((link) => link.proposedBy === "model")).toMatchObject([{ relation: "fuller", from: long.id, to: short.id, method: "entailment/2" }]);
    expect(links.all.every((link) => link.shadow && !link.holds)).toBe(true);
  });

  it.each([
    ["earlier", SHORT, "Mentored 12 junior engineers"],
    ["later", LONG, "Mentored 12 junior engineers every quarter"],
  ])("keeps no offer about a pair whose %s line was reworded while the judge was being asked", async (_which, before, after) => {
    settings.OFFER_SHADOW_ENABLED = "true";
    let reworded = false;
    // This judge says yes to both questions, about the lines as they stood when it was asked.
    const { facts, links, calls } = await twice({}, (models, user) => ({
      ...models,
      async complete(route, messages, schema, options) {
        if (route === "judge" && !reworded) {
          reworded = true;
          // Before it answers, the owner corrects one of the two lines: it was twelve engineers.
          const listed = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
          const edited = await user.send("PATCH", `/api/facts/${listed.find((fact) => fact.text === before)!.id}`, { text: after });
          expect(edited.status, await edited.clone().text()).toBe(204);
        }
        return models.complete(route, messages, schema, options);
      },
    }));
    expect(calls.judge).toBe(1);
    expect(facts).toHaveLength(16);
    expect(facts.filter((fact) => fact.text === after)).toHaveLength(1);
    // The answer was about words one of the lines no longer has, so nothing is kept of it.
    expect(links.all).toEqual([]);
  });

  it("gets one try: when the stage runs out of time the judge is not asked again, and the upload finishes", async () => {
    settings.OFFER_SHADOW_ENABLED = "true";
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      // The stage's first try runs out of time before it does anything. A second try would ask the judge.
      await reading.modifyAll(async (step) => {
        await step.forceStepTimeout({ name: "offer" }, 1);
      });
      const { facts, links, calls } = await twice({});
      expect(facts).toHaveLength(16);
      expect(calls.judge).toBeUndefined();
      expect(links.all).toEqual([]);
    } finally {
      await reading.dispose();
    }
  });

  it("finishes the upload with every fact when the judge fails", async () => {
    settings.OFFER_SHADOW_ENABLED = "true";
    const { facts, links } = await twice({}, (models) => ({
      ...models,
      complete: (route, messages, schema, options) => (route === "judge" ? Promise.reject(new Error("unavailable: model provider network failure")) : models.complete(route, messages, schema, options)),
    }));
    expect(facts).toHaveLength(16);
    expect(links.all).toEqual([]);
  });
});
