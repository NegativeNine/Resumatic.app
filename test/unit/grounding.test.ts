import { describe, expect, it } from "vitest";
import { checkClaim, namesIn, numbersIn, scopeRank, unsupportedNames, unsupportedNumbers } from "../../src/grounding/claims";
import { normalizeForQuote, quoteIsVerbatim } from "../../src/grounding/quote";
import { checkLine, fallbackFact } from "../../src/grounding/verdict";
import type { FactRecord } from "../../src/shared/types";

describe("quoteIsVerbatim", () => {
  const source = `### Acme Corp — Senior Engineer

- **Led** the migration of 40 services to Kubernetes,
  cutting deploy time by 60%
* Wrote the team’s “on-call” handbook`;

  it("ignores case, emphasis, bullets, curly quotes, dashes and line breaks", () => {
    expect(quoteIsVerbatim(source, "led the migration of 40 services to Kubernetes, cutting deploy time by 60%")).toBe(true);
    expect(quoteIsVerbatim(source, `Wrote the team's "on-call" handbook`)).toBe(true);
    expect(quoteIsVerbatim(source, "Acme Corp - Senior Engineer")).toBe(true);
  });

  it("refuses paraphrases, changed numbers, joined passages and fragments too short to mean anything", () => {
    expect(quoteIsVerbatim(source, "Led the move of 40 services to Kubernetes")).toBe(false);
    expect(quoteIsVerbatim(source, "Led the migration of 400 services to Kubernetes")).toBe(false);
    expect(quoteIsVerbatim(source, "cutting deploy time by 60% Wrote the team's handbook")).toBe(false);
    expect(quoteIsVerbatim(source, "Led")).toBe(false);
  });

  it("normalises consistently", () => {
    expect(normalizeForQuote("  1. Shipped   *v2*  ")).toBe("shipped v2");
  });
});

describe("numbers", () => {
  it("reads units, scales, separators and number words", () => {
    const values = (text: string) => numbersIn(text).map((n) => [n.value, n.percent]);
    expect(values("Cut costs by 30%")).toEqual([[30, true]]);
    expect(values("grew revenue 25 percent")).toEqual([[25, true]]);
    expect(values("$2.5M in savings")).toEqual([[2_500_000, false]]);
    expect(values("1,200 customers")).toEqual([[1200, false]]);
    expect(values("3x faster")).toEqual([[3, false]]);
    expect(values("a team of twelve")).toEqual([[12, false]]);
  });

  it("matches equal amounts written differently, and nothing else", () => {
    expect(unsupportedNumbers("Saved $2.5M", "saved 2,500,000 dollars")).toEqual([]);
    expect(unsupportedNumbers("Handled 2 million events", "handled 2M events")).toEqual([]);
    expect(unsupportedNumbers("Mentored three engineers", "mentored 3 engineers")).toEqual([]);
    expect(unsupportedNumbers("Cut costs by 30%", "cut costs by 30 dollars")).toEqual(["30%"]);
    expect(unsupportedNumbers("Served 40 services", "served forty services")).toEqual(["40"]);
    expect(unsupportedNumbers("Grew users 10x", "grew users 5x")).toEqual(["10x"]);
    expect(unsupportedNumbers("From 2019 to 2021", "2019–2021")).toEqual([]);
    expect(unsupportedNumbers("From 2018 to 2021", "2019–2021")).toEqual(["2018"]);
    expect(unsupportedNumbers("Saved $1.2M", "saved $1,200,000")).toEqual([]);
    expect(unsupportedNumbers("Grew 40%", "grew 40 percent")).toEqual([]);
  });
});

describe("names", () => {
  it("finds tools, products and acronyms, but not sentence-initial words", () => {
    expect(namesIn("Built services in Go and C++ on AWS with Node.js")).toEqual(["Go", "C++", "AWS", "Node.js"]);
    expect(namesIn("Led the team. Shipped the release")).toEqual([]);
  });

  it("flags names the evidence does not contain", () => {
    expect(unsupportedNames("Rewrote the API in Rust", "rewrote the API in Go")).toEqual(["Rust"]);
    expect(unsupportedNames("Deployed on Kubernetes", "deployed services on kubernetes")).toEqual([]);
    expect(unsupportedNames("Wrote C++ services", "wrote c++ services")).toEqual([]);
    expect(unsupportedNames("Used GoLang", "used Go")).toEqual(["GoLang"]);
  });
});

describe("scope", () => {
  it.each([
    ["Helped design the billing API", 1],
    ["Helped lead the migration", 1],
    ["Supported the launch of the app", 1],
    ["Built the billing API", 2],
    ["Led the migration", 3],
    ["Mentored two engineers", 3],
    ["Architected the platform", 4],
    ["Co-founded the company", 5],
    ["Responsible for billing", 0],
  ])("%s -> %i", (text, rank) => {
    expect(scopeRank(text)).toBe(rank);
  });

  it("refuses a claim of more scope than the evidence", () => {
    expect(checkClaim("Led the migration", [{ text: "Helped lead the migration", level: "contributed" }]).ok).toBe(false);
    expect(checkClaim("Owned the billing API", [{ text: "Built the billing API", level: "implemented" }]).ok).toBe(false);
    expect(checkClaim("Built the billing API", [{ text: "Helped build the billing API", level: "contributed" }]).ok).toBe(false);
    expect(checkClaim("Built the billing API", [{ text: "Owned the billing API", level: "owned" }]).ok).toBe(true);
    expect(checkClaim("Improved billing", [{ text: "Billing improvements" }]).ok).toBe(true);
  });

  it("reports every problem at once", () => {
    const result = checkClaim("Led a Rust rewrite that cut costs by 50%", [{ text: "Helped with a Go rewrite", level: "contributed" }]);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(3);
  });
});

describe("checkLine", () => {
  const fact = (id: string, roleId: string | null, text: string, level: FactRecord["level"] = "implemented"): FactRecord => ({
    id,
    roleId,
    kind: "accomplishment",
    text,
    level,
    quote: text,
  });
  const facts = new Map(
    [fact("a", "r1", "Built the billing API"), fact("b", "r2", "Mentored 2 engineers", "led"), fact("c", "r1", "Wrote the on-call handbook"), fact("loose", null, "Built an internal tool")].map((f) => [
      f.id,
      f,
    ]),
  );
  const selected = new Set(["a", "b", "loose"]);

  it("passes a grounded line", () => {
    expect(checkLine({ roleId: "r1", text: "Built the billing API", factIds: ["a"] }, facts, selected).ok).toBe(true);
  });

  it("needs citations, from the selection, of the line's own role", () => {
    expect(checkLine({ roleId: "r1", text: "Built things", factIds: [] }, facts, selected).problems).toEqual(["cites no facts"]);
    expect(checkLine({ roleId: "r1", text: "Wrote the handbook", factIds: ["c"] }, facts, selected).ok).toBe(false);
    expect(checkLine({ roleId: "r1", text: "Mentored 2 engineers", factIds: ["b"] }, facts, selected).ok).toBe(false);
    expect(checkLine({ roleId: "r1", text: "Built a thing", factIds: ["zzz"] }, facts, selected).ok).toBe(false);
  });

  it("lets the summary cite any role", () => {
    expect(checkLine({ roleId: null, text: "Built the billing API and mentored 2 engineers", factIds: ["a", "b"] }, facts, selected).ok).toBe(true);
    expect(checkLine({ roleId: null, text: "Built an internal tool", factIds: ["loose"] }, facts, selected).ok).toBe(true);
    expect(fallbackFact({ roleId: null, text: "x", factIds: ["loose"] }, facts, selected)?.id).toBe("loose");
  });

  it("does not attribute an unattached fact to a specific role, including fallback", () => {
    const line = { roleId: "r1", text: "Built an internal tool", factIds: ["loose"] };
    expect(checkLine(line, facts, selected)).toEqual({ ok: false, problems: ["cites a fact not assigned to this role"] });
    expect(fallbackFact(line, facts, selected)).toBeNull();
    expect(fallbackFact({ ...line, factIds: ["loose", "a"] }, facts, selected)?.id).toBe("a");
  });

  it("falls back to the first usable fact, or to nothing", () => {
    expect(fallbackFact({ roleId: "r1", text: "x", factIds: ["c", "b", "a"] }, facts, selected)?.id).toBe("a");
    expect(fallbackFact({ roleId: "r1", text: "x", factIds: ["b"] }, facts, selected)).toBeNull();
  });
});
