import { describe, expect, it } from "vitest";
import { sourceRuns, validSpan, type SourceMark } from "../../src/web/components/facts/source-runs";

// The file beside a question marks only the words a fact rests on: a saved span whose words are
// exactly the saved quote. Nothing is found by searching for the quote's words.

const TEXT = "Sam Rivera\nLed migration of 40 services\nCut p95 API latency by moving hot paths to Redis\nSkills: Python, Redis";
const at = (quote: string, from = 0): [number, number] => {
  const start = TEXT.indexOf(quote, from);
  return [start, start + quote.length];
};
const mark = (quote: string, tone: SourceMark["tone"], span = at(quote)): SourceMark => ({ quote, span, tone });

describe("sourceRuns", () => {
  it("the current item wins an overlap", () => {
    const line = "Cut p95 API latency by moving hot paths to Redis";
    // A waiting mark that starts earlier and runs into the current one is dropped, as is one inside it.
    const runs = sourceRuns(TEXT, [
      mark("services\nCut p95", "waiting"),
      mark("API latency", "backed"),
      mark(line, "current"),
    ]);
    expect(runs.filter((run) => run.tone)).toEqual([{ text: line, tone: "current" }]);
    // Two marks that don't overlap are both placed, in the order they start.
    expect(sourceRuns(TEXT, [mark("Skills: Python, Redis", "backed"), mark("Led migration of 40 services", "waiting")]).filter((run) => run.tone)).toEqual([
      { text: "Led migration of 40 services", tone: "waiting" },
      { text: "Skills: Python, Redis", tone: "backed" },
    ]);
    // Between two others that overlap, the one that starts first is kept.
    expect(sourceRuns(TEXT, [mark("40 services", "backed"), mark("Led migration of 40 services", "waiting")]).filter((run) => run.tone)).toEqual([
      { text: "Led migration of 40 services", tone: "waiting" },
    ]);
  });

  it("drops a span out of bounds, non-integer or not matching its quote", () => {
    const quote = "Led migration of 40 services";
    const [start, end] = at(quote);
    const bad: SourceMark[] = [
      { quote, span: [start, TEXT.length + 5], tone: "current" },
      { quote, span: [-1, end], tone: "current" },
      { quote, span: [start + 0.5, end], tone: "current" },
      { quote, span: [end, start], tone: "current" },
      { quote, span: [start + 1, end + 1], tone: "current" },
      { quote: "Led the migration of 40 services", span: [start, end], tone: "current" },
      { quote, span: null, tone: "current" },
      { quote: null, span: [start, end], tone: "current" },
    ];
    for (const one of bad) {
      expect(validSpan(TEXT, one.span, one.quote), JSON.stringify(one)).toBe(false);
      expect(sourceRuns(TEXT, [one]), JSON.stringify(one)).toEqual([{ text: TEXT, tone: null }]);
    }
    expect(validSpan(TEXT, [start, end], quote)).toBe(true);
  });

  it("keeps text between marks", () => {
    const runs = sourceRuns(TEXT, [mark("Led migration of 40 services", "current"), mark("Skills: Python, Redis", "backed")]);
    expect(runs.map((run) => run.text).join("")).toBe(TEXT);
    expect(runs.map((run) => run.tone)).toEqual([null, "current", null, "backed"]);
    expect(sourceRuns("", [])).toEqual([]);
    expect(sourceRuns(TEXT, [])).toEqual([{ text: TEXT, tone: null }]);
  });
});
