import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import type { FactView } from "../../src/shared/api";
import type { RecordExport } from "../../src/shared/record";
import { vault } from "../../src/shared/stubs";
import { RecordStore } from "../../src/vault/record";
import { fromBase64url } from "../../src/worker/crypto";
import { RESUME, fakeModels, signIn, waitForSource, type FakeModelOptions, type User } from "./support";

// Dividing lines while an upload is read: off unless switched on, and in shadow when it is on.

const LED = "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%";
const settings = env as unknown as { SPLIT_SHADOW_ENABLED?: string };
const AS_CONFIGURED = settings.SPLIT_SHADOW_ENABLED;

interface Seen {
  /** The lines each proposing call was shown. */
  asked: { id: string; text: string; words: string }[][];
  options: FakeModelOptions;
}

/** The usual stand-in models, plus an answer to the question of how lines divide. */
function splitting(answer: (lines: Seen["asked"][number]) => unknown, options: FakeModelOptions = {}): { seen: Seen; models: Models } {
  const seen: Seen = { asked: [], options: { calls: {}, ...options } };
  const base = fakeModels(seen.options);
  const models: Models = {
    ...base,
    async complete(route, messages, schema, opts) {
      const user = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      // The reading itself sends the resume between tags; the question about lines sends JSON.
      if (route === "extract" && user.startsWith("{")) {
        const { lines } = JSON.parse(user) as { lines: Seen["asked"][number] };
        seen.asked.push(lines);
        return schema.parse(await answer(lines));
      }
      return base.complete(route, messages, schema, opts);
    },
  };
  return { seen, models };
}

/** Divides the one line about the migration into what was done and what came of it. */
const divideLed = (lines: Seen["asked"][number]) => ({
  lines: lines.map((line) => ({
    id: line.id,
    parts:
      line.text === LED
        ? [
            { kind: "clause", words: [{ from: 0, to: 7 }], of: null },
            { kind: "result", words: [{ from: 8, to: 12 }], of: 0 },
            { kind: "mention", words: [{ from: 7, to: 7 }], of: null },
          ]
        : [],
  })),
});

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}

async function read(user: User): Promise<FactView[]> {
  const response = await user.upload("jane-doe.pdf", RESUME);
  expect(response.status, await response.clone().text()).toBe(201);
  const { sourceId } = (await response.json()) as { sourceId: string };
  expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
  return (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
}

/** Everything the record holds for this person, and what shows for one fact. */
function held(user: User, factId: string) {
  return runInDurableObject(vaultOf(user), (_instance, state) => {
    const record = new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn));
    return { all: record.export(), shown: record.split(factId), shadow: record.split(factId, { shadow: true }) };
  });
}

afterEach(() => {
  setModels(null);
  settings.SPLIT_SHADOW_ENABLED = AS_CONFIGURED;
});

describe("reading an upload as it is configured everywhere today", () => {
  it("asks no model how a line divides and keeps no division", async () => {
    expect(AS_CONFIGURED).toBeUndefined();
    const { seen, models } = splitting(divideLed);
    setModels(() => models);
    const user = await signIn();
    const facts = await read(user);
    expect(facts).toHaveLength(8);
    expect(seen.asked).toEqual([]);
    expect(seen.options.calls).toMatchObject({ extract: 1 });
    expect(seen.options.calls?.judge).toBeUndefined();
    const led = facts.find((fact) => fact.text === LED)!;
    expect((await held(user, led.id)).all).toEqual({ factSplits: [], conceptTags: [], recordLinks: [] });
  });
});

describe("reading an upload with shadow divisions switched on", () => {
  beforeEach(() => {
    settings.SPLIT_SHADOW_ENABLED = "true";
  });

  it("keeps a division that passes every check, in shadow, and changes nothing the app shows", async () => {
    const { seen, models } = splitting(divideLed);
    setModels(() => models);
    const user = await signIn();
    const facts = await read(user);
    // The same eight facts, each still one whole line.
    expect(facts).toHaveLength(8);
    const led = facts.find((fact) => fact.text === LED)!;
    expect(led).toMatchObject({ state: "proposed", origin: "extracted" });

    // One question, about the lines that could divide: no skill, and no line with "Helped" in it.
    expect(seen.asked).toHaveLength(1);
    expect(seen.asked[0]!.map((line) => line.text).sort()).toEqual(
      [LED, "Built a Go service that processes 2 million events per day", "Implemented React dashboards for the sales team", "Mentored 2 junior engineers"].sort(),
    );
    expect(seen.asked[0]!.map((line) => line.id)).toEqual(["1", "2", "3", "4"]);
    expect(seen.asked[0]!.find((line) => line.text === LED)!.words).toBe("0:Led 1:the 2:migration 3:of 4:40 5:services 6:to 7:Kubernetes, 8:cutting 9:deploy 10:time 11:by 12:60%");

    const record = await held(user, led.id);
    expect(record.shown).toBeNull();
    expect(record.shadow).toMatchObject({
      factId: led.id,
      state: "proposed",
      shadow: true,
      proposedBy: "model",
      model: `${env.MODEL_EXTRACT}+${env.MODEL_JUDGE}`,
      method: "split/3",
      decidedBy: null,
    });
    expect(record.shadow!.parts.map((part) => [part.kind, part.text])).toEqual([
      ["clause", "Led the migration of 40 services to Kubernetes"],
      ["mention", "Kubernetes"],
      ["result", "cutting deploy time by 60%"],
    ]);
    expect(record.shadow!.parts[2]!.resultOf).toBe(record.shadow!.parts[0]!.id);
    expect(record.all.factSplits).toHaveLength(1);
    expect(record.all.conceptTags).toEqual([]);

    // It is the person's data, so their export has it, marked as in shadow.
    const exported = await user.json<RecordExport>("/api/export");
    expect(exported.factSplits).toMatchObject([{ factId: led.id, shadow: true, state: "proposed" }]);
  });

  it("asks nothing about a line marked sensitive, so it is never put to the splitter or the judge", async () => {
    // An earlier reading, with divisions off, and its line about the migration marked.
    settings.SPLIT_SHADOW_ENABLED = AS_CONFIGURED;
    setModels(() => fakeModels());
    const user = await signIn();
    const led = (await read(user)).find((fact) => fact.text === LED)!;
    expect((await user.send("POST", "/api/facts/sensitive", { ids: [led.id], sensitive: true })).status).toBe(204);

    // The same lines in a second file, read with divisions on. Its copy of the line arrives marked.
    settings.SPLIT_SHADOW_ENABLED = "true";
    const { seen, models } = splitting(divideLed);
    setModels(() => models);
    const response = await user.upload("jane-doe-2024.pdf", `${RESUME}\nReferences on request.\n`);
    expect(response.status, await response.clone().text()).toBe(201);
    const { sourceId } = (await response.json()) as { sourceId: string };
    expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
    const arrived = (await user.json<{ facts: FactView[] }>("/api/facts")).facts.filter((fact) => fact.sourceId === sourceId);
    expect(arrived.filter((fact) => fact.sensitive).map((fact) => fact.text)).toEqual([LED]);

    // The other three lines were asked about. The marked one was not, and it would have been divided.
    expect(seen.asked).toHaveLength(1);
    expect(seen.asked[0]!.map((line) => line.text).sort()).toEqual(
      ["Built a Go service that processes 2 million events per day", "Implemented React dashboards for the sales team", "Mentored 2 junior engineers"].sort(),
    );
    expect(seen.options.calls?.judge).toBeUndefined();
    expect((await held(user, arrived.find((fact) => fact.text === LED)!.id)).all.factSplits).toEqual([]);
  });

  it("keeps nothing when the judge does not find that the line states a part as it reads alone", async () => {
    const { models } = splitting(divideLed, { judgeRejects: ["cutting deploy time by 60%"] });
    setModels(() => models);
    const user = await signIn();
    const facts = await read(user);
    expect(facts).toHaveLength(8);
    expect((await held(user, facts.find((fact) => fact.text === LED)!.id)).all.factSplits).toEqual([]);
  });

  it("keeps nothing when the judge does not find that the line states a result with the claim it is named as the outcome of", async () => {
    // Read together, the claim and its result have no comma between them. So this judge accepts
    // each part alone and the line against its parts, and refuses only the two read as one.
    const { seen, models } = splitting(divideLed, { judgeRejects: ["Kubernetes cutting deploy time by 60%"] });
    setModels(() => models);
    const user = await signIn();
    const facts = await read(user);
    expect(facts).toHaveLength(8);
    expect(seen.options.calls?.judge).toBe(1);
    expect((await held(user, facts.find((fact) => fact.text === LED)!.id)).all.factSplits).toEqual([]);
  });

  it("keeps nothing a check refuses, whatever the model proposes", async () => {
    // "Led ... deploy time by 60%" is the line's own words, and reaches across "40 services" to say it.
    const { models } = splitting((lines) => ({
      lines: lines.map((line) => ({
        id: line.id,
        parts: line.text === LED ? [{ kind: "clause", words: [{ from: 0, to: 0 }, { from: 9, to: 12 }], of: null }, { kind: "clause", words: [{ from: 1, to: 8 }], of: null }] : [],
      })),
    }));
    setModels(() => models);
    const user = await signIn();
    const facts = await read(user);
    expect((await held(user, facts.find((fact) => fact.text === LED)!.id)).all.factSplits).toEqual([]);
  });

  it("finishes the upload with every fact when the model that divides lines fails", async () => {
    const { seen, models } = splitting(() => {
      throw new Error("unavailable: model provider network failure");
    });
    setModels(() => models);
    const user = await signIn();
    const facts = await read(user);
    expect(seen.asked).toHaveLength(1);
    expect(facts).toHaveLength(8);
    expect((await held(user, facts[0]!.id)).all.factSplits).toEqual([]);
  });

  it("gets one try: when the stage runs out of time nothing is asked again, and the upload finishes", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      // The stage's first try runs out of time before it does anything. A second try would ask
      // the model and keep a division, and the upload would be marked ready that much later.
      await reading.modifyAll(async (step) => {
        await step.forceStepTimeout({ name: "split" }, 1);
      });
      const { seen, models } = splitting(divideLed);
      setModels(() => models);
      const user = await signIn();
      const facts = await read(user);
      expect(facts).toHaveLength(8);
      expect(seen.asked).toEqual([]);
      expect(seen.options.calls?.judge).toBeUndefined();
      expect((await held(user, facts.find((fact) => fact.text === LED)!.id)).all.factSplits).toEqual([]);
    } finally {
      await reading.dispose();
    }
  });

  it("finishes the upload with every fact when the answer is not an answer", async () => {
    const { models } = splitting(() => ({ lines: [{ id: "1", parts: [{ kind: "summary", words: "all of it" }] }] }));
    setModels(() => models);
    const user = await signIn();
    const facts = await read(user);
    expect(facts).toHaveLength(8);
    expect((await held(user, facts[0]!.id)).all.factSplits).toEqual([]);
  });
});
