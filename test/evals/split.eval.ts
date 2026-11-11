import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { Models } from "../../src/ai/models";
import { numberedWords, splitLines, toParts, type SplitProposal } from "../../src/pipeline/split";
import { lineRuns, partText, type NewPart } from "../../src/shared/record";
import { SPLIT_LINES, type LabelledPart } from "../fixtures/split-lines";
import { credentials, restModels, wranglerVars } from "./rest-models";

// Dividing lines, against the real models. Two questions:
//   1. Is a division that changes a line's meaning ever accepted? Each labelled trap is put to
//      the real checks and the real judge as if a model had proposed it. None may pass.
//   2. What does the real proposing model do with each labelled line? Reported for a person to
//      read, beside the labelled division and with the claim each result was given as the outcome
//      of; a line that must stay whole and was divided fails.
// The labelled lines are made up. Passing here does not set a threshold: that needs real resumes
// given with consent. Writes split-eval-report.json.

const creds = credentials();
const vars = wranglerVars(process.env.EVAL_ENV || "staging");
const report: Record<string, unknown>[] = [];

afterAll(() => {
  if (report.length)
    writeFileSync("split-eval-report.json", JSON.stringify({ models: { extract: vars.MODEL_EXTRACT, judge: vars.MODEL_JUDGE }, lines: report }, null, 2));
});

/** A labelled division as the word numbers a model would have answered with. */
function asProposal(line: string, parts: LabelledPart[]): SplitProposal {
  const runs = lineRuns(line);
  return parts.map(([kind, pieces, of]) => ({
    kind,
    of: of ?? null,
    words: pieces.map((piece) => {
      const start = line.indexOf(piece);
      const from = runs.findIndex((run) => run.start === start || run.coreStart === start);
      const to = runs.findIndex((run) => run.end === start + piece.length || run.coreEnd === start + piece.length);
      if (start < 0 || from < 0 || to < 0) throw new Error(`"${piece}" does not sit on whole words of the line`);
      return { from, to };
    }),
  }));
}

/** A division as a person reads it: each part's words, and for a result the claim it is named as the outcome of. */
function described(line: string, parts: NewPart[] | null): string[] | null {
  return (
    parts?.map((part) => {
      const text = partText(line, part.ranges);
      return part.kind === "result" ? `result of "${partText(line, parts[part.resultOf!]!.ranges)}": ${text}` : `${part.kind}: ${text}`;
    }) ?? null
  );
}

/** The real models, except that the question of how a line divides gets this answer. */
function proposing(models: Models, parts: SplitProposal): Models {
  return {
    ...models,
    complete: (route, messages, schema, options) =>
      route === "extract" ? Promise.resolve(schema.parse({ lines: [{ id: "1", parts }] })) : models.complete(route, messages, schema, options),
  };
}

describe.skipIf(!creds)("dividing lines", () => {
  const traps = SPLIT_LINES.flatMap((example) => (example.traps ?? []).map((trap) => ({ ...trap, line: example.line })));

  it.each(traps)("$line: a division that $says is never accepted", async (trap) => {
    const models = restModels(creds!, vars);
    const [decision] = await splitLines(proposing(models, asProposal(trap.line, trap.parts)), [{ id: "trap", text: trap.line }]);
    report.push({ line: trap.line, trap: trap.says, expected: trap.caught, refusal: decision!.refusal });
    expect(decision!.parts, `accepted a division that ${trap.says}`).toBeNull();
  });

  it.each(SPLIT_LINES)("$line", async (example) => {
    const models = restModels(creds!, vars);
    const [decision] = await splitLines(models, [{ id: "line", text: example.line }]);
    report.push({
      line: example.line,
      words: numberedWords(example.line),
      expected: example.expect,
      refusal: decision!.refusal,
      parts: described(example.line, decision!.parts),
      labelled: example.gold ? described(example.line, toParts(example.line, asProposal(example.line, example.gold))) : null,
    });
    // A line that must stay whole whatever a model says. "one_claim" is a reader's judgement, so
    // it is reported and not failed.
    if (example.expect === "qualified" || example.expect === "length") expect(decision!.refusal).toBe(example.expect);
  });
});
