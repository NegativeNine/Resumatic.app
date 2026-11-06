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

  it("distinguishes counts, multipliers, percentages and currencies", () => {
    expect(unsupportedNumbers("Improved throughput 5x", "processed 5 invoices")).toEqual(["5x"]);
    expect(unsupportedNumbers("Processed 5 invoices", "improved throughput 5×")).toEqual(["5"]);
    for (const expression of ["5x", "5×", "5 times", "5-fold", "fivefold", "five times"]) {
      expect(unsupportedNumbers(`Improved throughput ${expression}`, "improved throughput 5x")).toEqual([]);
    }
    expect(unsupportedNumbers("Improved throughput five times", "processed five invoices")).toEqual(["five times"]);
    expect(unsupportedNumbers("Improved 5%", "improved five percent")).toEqual([]);
    expect(unsupportedNumbers("Raised $5", "raised 5 euros")).toEqual(["$5"]);
    expect(unsupportedNumbers("Raised $5", "served 5 customers")).toEqual(["$5"]);
    expect(unsupportedNumbers("Served 5 customers", "raised $5")).toEqual(["5"]);
    expect(unsupportedNumbers("Raised €5", "raised 5 euros")).toEqual([]);
    expect(unsupportedNumbers("Raised £5", "raised 5 pounds sterling")).toEqual([]);
    expect(unsupportedNumbers("Raised $5 euros", "raised $5 euros")).toEqual(["$5 euros"]);
    expect(unsupportedNumbers("Grew 5%", "changed by -5%")).toEqual(["5%"]);
    expect(unsupportedNumbers("Changed by -5%", "changed by 5%")).toEqual(["-5%"]);
    expect(unsupportedNumbers("Changed by −5%", "changed by minus five percent")).toEqual([]);
    expect(unsupportedNumbers("From 2019 to 2021", "2019-2021")).toEqual([]);
    expect(unsupportedNumbers("From 2019 to 2021", "2019 - 2021")).toEqual([]);
    expect(unsupportedNumbers("Built one service", "built services")).toEqual(["one"]);
    expect(unsupportedNumbers("Saved $1,000,000,001", "saved $1 billion")).toEqual(["$1,000,000,001"]);
    expect(unsupportedNumbers("Processed 1001 events", "processed 1.001k events")).toEqual([]);
    expect(unsupportedNumbers("Lost -$5", "lost $5")).toEqual(["-$5"]);
    expect(unsupportedNumbers("Changed by -5%", "changed by minus 5%")).toEqual([]);
    expect(unsupportedNumbers("Changed by $5", "changed by negative $5")).toEqual(["$5"]);
    expect(unsupportedNumbers("Changed by -$5", "changed by negative $five")).toEqual([]);
  });

  it("does not reuse explicit years as counts or counts as dates", () => {
    expect(unsupportedNumbers("Managed 2021 employees", "Worked from 2019–2021")).toEqual(["2021"]);
    expect(unsupportedNumbers("Worked in 2021", "Managed 2021 employees")).toEqual(["2021"]);
    expect(unsupportedNumbers("Worked in 2021", "Worked from 2019–2021")).toEqual([]);
    expect(unsupportedNumbers("Managed 2021 employees", "Managed 2021 employees")).toEqual([]);
    expect(unsupportedNumbers("Started in 2021", "Started March 2021")).toEqual([]);
    expect(unsupportedNumbers("Managed 2021 employees", "Started 2021-03-01")).toEqual(["2021"]);
    expect(unsupportedNumbers("Managed 3 employees", "Started 2021/03/01")).toEqual(["3"]);
    expect(unsupportedNumbers("Managed 1 employee", "Started 2021/03/01")).toEqual(["1"]);
  });

  it("keeps numeric and written date components separate from counts and from each other", () => {
    for (const date of ["03/01/2021", "03-01-2021", "03.01.2021", "March 3, 2021", "3 March 2021"]) {
      expect(unsupportedNumbers("Managed 3 employees", `Started ${date}`)).toEqual(["3"]);
      expect(unsupportedNumbers("Managed 2021 employees", `Started ${date}`)).toEqual(["2021"]);
    }
    expect(unsupportedNumbers("Started 2021/01/03", "Started 2021/03/01")).toEqual(["2021", "01", "03"]);
    expect(unsupportedNumbers("Started 2021/03/01", "Started 2021-03-01")).toEqual([]);
    expect(unsupportedNumbers("Started 2021.03.01", "Started 2021/03/01")).toEqual([]);
    expect(unsupportedNumbers("Started 03/01/2021", "Started 01/03/2021")).toEqual(["03", "01", "2021"]);
    expect(unsupportedNumbers("Started in 2021", "Started March 3, 2021")).toEqual([]);
    expect(unsupportedNumbers("Started 2021/04/02", "Started 2021/03/01 and finished 2022/04/02")).toEqual(["2021", "04", "02"]);
    expect(unsupportedNumbers("Started March 2021", "Started April 2021")).toEqual(["2021"]);
    expect(unsupportedNumbers("Started March 2021", "Started 2021/03/01")).toEqual([]);
    expect(unsupportedNumbers("Started March 3, 2021", "Started 2021/03/03")).toEqual([]);
  });

  it("recognizes ordinal days in written dates rather than treating the year as a count", () => {
    for (const date of ["March 3rd, 2021", "3rd March 2021", "Mar. 1st 2021", "2nd April 2020"]) {
      const year = date.endsWith("2020") ? "2020" : "2021";
      expect(unsupportedNumbers(`Managed ${year} employees`, `Started ${date}`)).toEqual([year]);
    }
    expect(unsupportedNumbers("Managed 3 employees", "Started March 3rd, 2021")).toEqual(["3"]);
    expect(unsupportedNumbers("Started March 4th, 2021", "Started March 3rd, 2021")).toEqual(["4", "2021"]);
    expect(unsupportedNumbers("Started March 3rd, 2021", "Started March 3, 2021")).toEqual([]);
    expect(unsupportedNumbers("Started 3rd March 2021", "Started 2021/03/03")).toEqual([]);
    expect(checkClaim("Managed 2021 employees", [{ text: "Managed employee support on March 3rd, 2021" }]).ok).toBe(false);
  });

  it("detects leading-dot decimals and scientific notation without dropping extreme values", () => {
    expect(unsupportedNumbers("Reduced cost by .5%", "reduced cost")).toEqual([".5%"]);
    expect(unsupportedNumbers("Reduced cost by .5%", "reduced cost by 0.5%")).toEqual([]);
    expect(unsupportedNumbers("Processed 1e6 requests", "processed requests")).toEqual(["1e6"]);
    expect(unsupportedNumbers("Processed 1e6 requests", "processed 1,000,000 requests")).toEqual([]);
    expect(unsupportedNumbers("Saved $1e309", "saved $1e309")).toEqual(["$1e309"]);
    expect(unsupportedNumbers("Improved by 1e-400%", "improved by 0%")).toEqual(["1e-400%"]);
  });

  it("checks ordinal ranks without reusing counts or dates", () => {
    expect(checkClaim("Ranked first", [{ text: "Ranked among competitors" }]).ok).toBe(false);
    expect(unsupportedNumbers("Ranked first", "Ranked 1st")).toEqual([]);
    expect(unsupportedNumbers("Ranked 1st", "Ranked first")).toEqual([]);
    expect(checkClaim("Ranked 1st", [{ text: "Ranked first" }]).ok).toBe(true);
    expect(unsupportedNumbers("Ranked first", "Processed one request")).toEqual(["first"]);
    expect(unsupportedNumbers("Processed one request", "Ranked first")).toEqual(["one"]);
    expect(unsupportedNumbers("Ranked twenty-first", "Ranked 21st")).toEqual([]);
    expect(unsupportedNumbers("Ranked twenty first", "Ranked 21st")).toEqual([]);
    expect(unsupportedNumbers("Ranked twenty-first", "Ranked 20th and 1st")).toEqual(["twenty-first"]);
    expect(unsupportedNumbers("Ranked twenty-first", "Ranked 22nd")).toEqual(["twenty-first"]);
    expect(unsupportedNumbers("Ranked first", "Joined March first, 2021")).toEqual(["first"]);
    expect(unsupportedNumbers("Joined March first, 2021", "Joined 2021-03-01")).toEqual([]);
    // Numeric month tokens are not inferred from written month names; this
    // remains a conservative mismatch in the existing date checker.
    expect(unsupportedNumbers("Joined 2021-03-01", "Joined first March 2021")).toEqual(["03"]);
    expect(unsupportedNumbers("Joined March second, 2021", "Joined March first, 2021")).toEqual(["2021", "second"]);
  });

  it("avoids treating common non-rank uses as ordinal claims", () => {
    expect(unsupportedNumbers("Reduced latency by one second", "Reduced latency by one second")).toEqual([]);
    expect(unsupportedNumbers("Ranked second", "Reduced latency by one second")).toEqual(["second"]);
    expect(unsupportedNumbers("Won a second award", "Won an award")).toEqual(["second"]);
    expect(unsupportedNumbers("Delivered first aid", "Delivered aid")).toEqual([]);
    expect(unsupportedNumbers("Delivered first-class support", "Delivered support")).toEqual([]);
    expect(unsupportedNumbers("Delivered first hand support", "Delivered support")).toEqual([]);
    expect(unsupportedNumbers("Provided service second to none", "Provided service")).toEqual([]);
    expect(unsupportedNumbers("Ranked first", "Ranked second to none")).toEqual(["first"]);
    expect(unsupportedNumbers("caféfirst", "worked in a café")).toEqual([]);
    expect(unsupportedNumbers("Ranked firsté", "Ranked first")).toEqual([]);
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

  it("rejects a multiplier or currency invented from an unrelated count", () => {
    expect(checkClaim("Improved throughput 5x", [{ text: "Processed 5 invoices" }]).ok).toBe(false);
    expect(checkClaim("Raised $5", [{ text: "Processed 5 invoices" }]).ok).toBe(false);
    expect(checkClaim("Reduced cost by .5%", [{ text: "Reduced cost" }]).ok).toBe(false);
    expect(checkClaim("Processed 1e6 requests", [{ text: "Processed requests" }]).ok).toBe(false);
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

  it("rejects a cited line that adds a leading-dot decimal or scientific quantity", () => {
    expect(checkLine({ roleId: "r1", text: "Built the billing API and reduced cost by .5%", factIds: ["a"] }, facts, selected).ok).toBe(false);
    expect(checkLine({ roleId: "r1", text: "Built the billing API serving 1e6 requests", factIds: ["a"] }, facts, selected).ok).toBe(false);
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
