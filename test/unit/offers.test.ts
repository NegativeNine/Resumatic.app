import { describe, expect, it } from "vitest";
import type { Models } from "../../src/ai/models";
import type { JudgeItem } from "../../src/ai/prompts";
import { offers, type OfferPair } from "../../src/pipeline/match";
import { MATCH_PAIRS } from "../fixtures/match-pairs";

const pair = (later: string, earlier: string, n = 1): OfferPair => ({ later: { id: `later-${n}`, text: later }, earlier: { id: `earlier-${n}`, text: earlier } });

type Verdict = "supported" | "unsupported" | "overstated" | "missing" | "twice";
type Answer = { id: string; verdict: "supported" | "unsupported" | "overstated"; reason: string };
/**
 * A judge that answers by the line it is asked about. Unlisted lines are supported. `reply`
 * rewrites a whole reply; `call` counts the judge's calls from 0.
 */
function models(verdicts: Record<string, Verdict> = {}, typed = false, reply?: (answers: Answer[], call: number) => Answer[]) {
  const asked: JudgeItem[][] = [];
  const judge = (items: JudgeItem[]) => {
    asked.push(items);
    const answers = items.flatMap((item): Answer[] => {
      const verdict = verdicts[item.text] ?? "supported";
      if (verdict === "missing") return [];
      const one = { id: item.alias, verdict: verdict === "twice" ? ("supported" as const) : verdict, reason: "" };
      return verdict === "twice" ? [one, one] : [one];
    });
    return { verdicts: reply ? reply(answers, asked.length - 1) : answers };
  };
  const made: Models = {
    async complete(route, messages, schema) {
      if (route !== "judge") throw new Error(`unexpected route ${route}`);
      const { lines } = JSON.parse(messages.at(-1)!.content) as { lines: { id: string; text: string; facts: JudgeItem["facts"] }[] };
      return schema.parse(judge(lines.map((line) => ({ alias: line.id, text: line.text, facts: line.facts }))));
    },
    embed: async () => [],
    rerank: async () => [],
    toMarkdown: async () => "",
    ...(typed ? { judge: async (items: JudgeItem[]) => judge(items) } : {}),
  };
  return { models: made, asked };
}

const LONG = "Mentored 2 junior engineers every quarter";
const SHORT = "Mentored 2 junior engineers";

describe("what to offer about two lines", () => {
  it("offers them as the same when each says everything the other says", async () => {
    const { models: fake, asked } = models();
    expect(await offers(fake, [pair("Cut deploy time from 40 minutes to 6", "Reduced deploy time from 40 minutes to 6")])).toEqual([{ relation: "same", from: "later-1", to: "earlier-1" }]);
    // Each direction is its own question: is this line supported by that one alone?
    expect(asked).toHaveLength(1);
    expect(asked[0]!.map((item) => [item.text, item.facts.map((fact) => fact.text)])).toEqual([
      ["Reduced deploy time from 40 minutes to 6", ["Cut deploy time from 40 minutes to 6"]],
      ["Cut deploy time from 40 minutes to 6", ["Reduced deploy time from 40 minutes to 6"]],
    ]);
  });

  it("offers the one that says more as a fuller version, whichever was read first", async () => {
    expect(await offers(models({ [LONG]: "unsupported" }).models, [pair(LONG, SHORT)])).toEqual([{ relation: "fuller", from: "later-1", to: "earlier-1" }]);
    expect(await offers(models({ [LONG]: "unsupported" }).models, [pair(SHORT, LONG)])).toEqual([{ relation: "fuller", from: "earlier-1", to: "later-1" }]);
  });

  it("offers nothing when neither says everything the other says", async () => {
    expect(await offers(models({ "Wrote the runbooks": "unsupported", "Reviewed the runbooks": "unsupported" }).models, [pair("Wrote the runbooks", "Reviewed the runbooks")])).toEqual([]);
  });

  it("takes anything but one plain yes as a no", async () => {
    for (const verdict of ["overstated", "missing", "twice"] as const) {
      expect(await offers(models({ [LONG]: verdict }).models, [pair(LONG, SHORT)]), verdict).toEqual([{ relation: "fuller", from: "later-1", to: "earlier-1" }]);
      expect(await offers(models({ [LONG]: verdict, [SHORT]: verdict }).models, [pair(LONG, SHORT)]), verdict).toEqual([]);
    }
  });

  it("settles a difference in figures, names or denial without asking, whatever a judge would say", async () => {
    // This judge says yes to everything. The checks that need no model stop each pair first.
    const cases: [later: string, earlier: string][] = [
      ["Led a team of 8 engineers", "Led a team of 5 engineers"],
      ["Built the billing API in Python", "Built the billing API in Go"],
      ["Managed the budget", "Did not manage the budget"],
    ];
    for (const [later, earlier] of cases) {
      const { models: fake, asked } = models();
      expect((await offers(fake, [pair(later, earlier)])).filter((offer) => offer.relation === "same"), later).toEqual([]);
      expect(asked.flat().length, later).toBeLessThan(2);
    }
    // One direction can still hold: the line with the figure says everything the line without it says.
    const { models: fake, asked } = models();
    expect(await offers(fake, [pair("Led a team of 5 engineers", "Led a team of engineers")])).toEqual([{ relation: "fuller", from: "later-1", to: "earlier-1" }]);
    expect(asked.flat().map((item) => item.text)).toEqual(["Led a team of engineers"]);
  });

  it("asks the typed-decision judge where there is one", async () => {
    const { models: fake, asked } = models({ [LONG]: "unsupported" }, true);
    expect(await offers(fake, [pair(LONG, SHORT)])).toEqual([{ relation: "fuller", from: "later-1", to: "earlier-1" }]);
    expect(asked).toHaveLength(1);
  });

  it("decides each pair by itself, across several calls", async () => {
    const pairs = Array.from({ length: 25 }, (_, index) => pair(`Trained ${index + 2} new starters every month`, `Trained ${index + 2} new starters`, index));
    const { models: fake, asked } = models({ [pairs[7]!.earlier.text]: "unsupported", [pairs[7]!.later.text]: "unsupported", ...Object.fromEntries(pairs.filter((_, index) => index % 2).map((found) => [found.later.text, "unsupported" as const])) });
    const found = await offers(fake, pairs);
    expect(asked.map((batch) => batch.length)).toEqual([20, 20, 10]);
    expect(found.map((offer) => offer.relation)).toEqual(pairs.flatMap((_, index) => (index === 7 ? [] : [index % 2 ? "fuller" : "same"])));
    expect(found.every((offer) => offer.from.startsWith("later-") && offer.to.startsWith("earlier-"))).toBe(true);
  });

  it("takes an answer only from the call that asked the question", async () => {
    // Eleven pairs are 22 questions, asked in calls of 20 and 2. Both questions about the last
    // pair are in the second call.
    const pairs = Array.from({ length: 11 }, (_, index) => pair(`Trained ${index + 2} new starters every month`, `Trained ${index + 2} new starters`, index));
    const yes = (id: string): Answer => ({ id, verdict: "supported", reason: "" });
    const relations = async (reply: (answers: Answer[], call: number) => Answer[], typed: boolean) => {
      const { models: fake, asked } = models({}, typed, reply);
      const found = await offers(fake, pairs);
      expect(asked.map((batch) => batch.map((item) => item.alias))).toEqual([expect.not.arrayContaining(["11.e", "11.l"]), ["11.e", "11.l"]]);
      return pairs.map((one) => found.find((offer) => [one.later.id, one.earlier.id].includes(offer.from))?.relation ?? "nothing");
    };
    for (const typed of [false, true]) {
      // The first reply volunteers that the earlier line says everything, and the call that asked gets no answer.
      expect(await relations((answers, call) => (call === 0 ? [...answers, yes("11.l")] : answers.filter((answer) => answer.id !== "11.l")), typed), String(typed)).toEqual([...Array(10).fill("same"), "fuller"]);
      // The other way round: no answer from the call that asked, and one volunteered by the next.
      expect(await relations((answers, call) => (call === 0 ? answers.filter((answer) => answer.id !== "3.e") : [...answers, yes("3.e")]), typed), String(typed)).toEqual(["same", "same", "fuller", ...Array(8).fill("same")]);
      // An answer nobody asked for decides nothing by itself, and takes nothing from the answer that was asked for.
      expect(await relations((answers, call) => (call === 0 ? [...answers, { ...yes("11.e"), verdict: "unsupported" }, yes("12.e")] : answers), typed), String(typed)).toEqual(Array(11).fill("same"));
      // Nor does a volunteered answer stand in for a direction a check settled without asking.
      const { models: fake } = models({}, typed, (answers) => [...answers, yes("1.l")]);
      expect(await offers(fake, [pair("Led a team of 5 engineers", "Led a team of engineers")]), String(typed)).toEqual([{ relation: "fuller", from: "later-1", to: "earlier-1" }]);
    }
  });

  it("lets a judge failure through, for the caller to keep nothing", async () => {
    const failing: Models = { ...models().models, complete: async () => Promise.reject(new Error("unavailable: model provider network failure")) };
    await expect(offers(failing, [pair(LONG, SHORT)])).rejects.toThrow("unavailable");
    expect(await offers(failing, [])).toEqual([]);
  });
});

describe("labelled pairs", () => {
  const never = MATCH_PAIRS.filter((example) => example.expect === "different");

  it.each(never.filter((example) => example.stoppedBy === "check"))("$later / $earlier: never the same, because of $why, whatever a judge says", async (example) => {
    const found = await offers(models().models, [pair(example.later, example.earlier)]);
    expect(found.filter((offer) => offer.relation === "same")).toEqual([]);
  });

  it.each(never.filter((example) => example.stoppedBy === "judge"))("$later / $earlier: only the judge can tell that $why", async (example) => {
    // With a judge that says yes to everything these are offered as the same: no check stops them.
    expect(await offers(models().models, [pair(example.later, example.earlier)])).toEqual([{ relation: "same", from: "later-1", to: "earlier-1" }]);
    // With a judge that says no to either direction, they are not.
    expect((await offers(models({ [example.later]: "unsupported" }).models, [pair(example.later, example.earlier)])).filter((offer) => offer.relation === "same")).toEqual([]);
  });

  it("says for every pair that must not be offered what stops it", () => {
    for (const example of never) expect(["check", "judge"], example.later).toContain(example.stoppedBy);
    expect(MATCH_PAIRS.filter((example) => example.expect !== "different").every((example) => example.stoppedBy === undefined)).toBe(true);
  });
});
