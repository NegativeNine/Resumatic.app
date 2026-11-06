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
  it("keeps malformed and locale-ambiguous numeric literals from supporting their pieces", () => {
    for (const source of ["1,00", "1,,000", "1,000,00", "1.2.3", ".5,00", ".5.6", "1,00e-3", "1,00e--3", "1e--3", "1e3.1", "1.000e3,4", "1e3e5", "1e--3 million", "1e--3 to 5", "1,00/2", "1,00 million", "1,00/2 million", "2021.03.01,00", "v1,00"]) {
      for (const count of ["-3000000", "-3", "0", "1", "2", "3", "4", "5", "6", "50", "100", "1000", "3000000"])
        expect(unsupportedNumbers(`Managed ${count} people`, `Managed ${source} people`), `${source} must not support ${count}`).not.toEqual([]);
      expect(unsupportedNumbers(`Managed ${source} people`, "Managed people"), source).not.toEqual([]);
    }
    // No locale is guessed for decimal commas or comma-separated lists with
    // no spacing. Both stay unmatchable until their meaning is explicit.
    expect(unsupportedNumbers("Measured 1,00", "Measured 1,00")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5", "Managed 5,10,20 people")).not.toEqual([]);
    expect(unsupportedNumbers("Raised $1", "Raised $1,00")).not.toEqual([]);
    expect(unsupportedNumbers("Lost -1%", "Lost −1,00%")).not.toEqual([]);
    expect(unsupportedNumbers("Earned 2 USD", "Earned USD 2,50")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 people", "Unreadable value 1,00; managed 5 people")).toEqual([]);
    expect(unsupportedNumbers("Managed 5 people", "Unreadable value 1e--3 million; managed 5 people")).toEqual([]);
  });

  it("preserves well-formed grouped decimals and explicit dates", () => {
    for (const [claim, evidence] of [
      ["Measured 1000", "Measured 1,000"],
      ["Measured 1000.5", "Measured 1,000.5"],
      ["Measured -1000500", "Measured -1,000.5k"],
      ["Measured 1000", "Measured 1e3"],
      ["Measured 0.001", "Measured 1e-3"],
      ["Saved $2000", "Saved USD 2,000"],
      ["Saved £2000", "Saved 2,000 pounds sterling"],
      ["Managed 10", "Managed 5, 10, 20 people"],
      ["Managed 1 and 2", "Managed 1, and 2 people"],
      ["Started March 5, 2020", "Started March 5,2020"],
      ["Started 2021-03-01", "Started 2021.03.01"],
    ]) expect(unsupportedNumbers(claim, evidence), `${claim} / ${evidence}`).toEqual([]);
    expect(checkClaim("Upgraded service to v1.2.3", [{ text: "Upgraded service to v1.2.3" }]).ok).toBe(true);
    expect(unsupportedNumbers("Managed 2 people", "Shipped v1.2.3")).not.toEqual([]);
  });

  it("matches same-line ranges only as ranges, never as unrelated endpoints", () => {
    for (const value of ["5 to 10", "between 5 and 10", "5–10", "5-10", "5 — 10", "five to ten", "between five and ten", "5 to ten", "5% to 10%", "$5 to $10", "5 to 10 million"]) {
      expect(unsupportedNumbers(`Managed ${value} people`, `Managed ${value} people`)).toEqual([]);
      expect(unsupportedNumbers("Managed 5 people", `Managed ${value} people`)).not.toEqual([]);
      expect(unsupportedNumbers("Managed 10 people", `Managed ${value} people`)).not.toEqual([]);
      expect(unsupportedNumbers(`Managed ${value} people`, "Managed 5 and 10 people")).not.toEqual([]);
    }
    expect(unsupportedNumbers("Managed 5 to 10 people", "Managed 5 to 11 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 to 10 people", "Managed approximately 5 to 10 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 to 10 people", "Managed 5 to 10 percent")).not.toEqual([]);
    // A fold range is a multiplier, not a range of people. The unit must not
    // be left outside a shorter, otherwise valid range token.
    for (const wording of ["5 to 10-fold", "5–10fold", "5 to 10 fold", "five to ten-fold"]) {
      expect(unsupportedNumbers("Managed 5 to 10 people", `Increased ${wording}`)).not.toEqual([]);
      expect(unsupportedNumbers(`Increased ${wording}`, `Increased ${wording}`)).toEqual([]);
    }
    for (const wording of ["5 to 10-percent", "5–10-percent", "five to ten-per cent"]) {
      expect(unsupportedNumbers("Managed 5 to 10 people", `Increased ${wording}`)).not.toEqual([]);
      expect(unsupportedNumbers(`Increased ${wording}`, `Increased ${wording}`)).toEqual([]);
    }
    for (const wording of ["5 to 10€", "5€ to 10€", "5 to 10-pct", "5 to 10 percentage points", "5 to 10 basis points"]) {
      expect(unsupportedNumbers("Managed 5 to 10 people", `Measured ${wording}`)).not.toEqual([]);
      expect(unsupportedNumbers(`Measured ${wording}`, `Measured ${wording}`)).toEqual([]);
    }
    for (const wording of ["5% to 10 dollars", "$5 to $10%", "5 USD to 10€", "5% to 10-fold", "$5 to $10-fold", "5 to 10-folded", "5 to 10-percentile", "1e999 to 2", "1e-999 to 2"]) {
      expect(unsupportedNumbers("Managed 5 to 10 people", `Measured ${wording}`)).not.toEqual([]);
      expect(unsupportedNumbers(`Measured ${wording}`, `Measured ${wording}`)).not.toEqual([]);
    }
    for (const wording of ["1,000.5 to 2,000.5", "1,000.5–2,000.5", "1e-3 to 2e-3", "1e-3–2e-3", "1e+3 to 2e+3", "(-5) to (-10)", "($5) to ($10)", "5th to 10th", "fifth to tenth"]) {
      expect(unsupportedNumbers(`Measured ${wording}`, `Measured ${wording}`)).toEqual([]);
      for (const component of ["1", "2", "5", "10", "1000", "1000.5", "5th", "10th"])
        expect(unsupportedNumbers(`Measured ${component}`, `Measured ${wording}`)).not.toEqual([]);
    }
    for (const wording of ["1,00 to 2", "1,,000 to 2", "5th to 10", "5 to 10th"]) {
      expect(unsupportedNumbers(`Measured ${wording}`, `Measured ${wording}`)).not.toEqual([]);
      expect(unsupportedNumbers("Measured 1", `Measured ${wording}`)).not.toEqual([]);
    }
    expect(unsupportedNumbers("Measured 1000.5", "Measured 1,000.5")).toEqual([]);
    expect(unsupportedNumbers("Measured 1000", "Measured 1,000.5")).not.toEqual([]);
    for (const modifier of ["not", "never", "no", "without", "except", "excluding"]) {
      expect(unsupportedNumbers("Managed 5 to 10 million people", `Managed ${modifier} 5 to 10 million people`)).not.toEqual([]);
      expect(unsupportedNumbers(`Managed ${modifier} 5 to 10 million people`, "Managed 5 to 10 million people")).not.toEqual([]);
      expect(unsupportedNumbers("Managed between 5 and 10 people", `Managed ${modifier} between 5 and 10 people`)).not.toEqual([]);
      expect(unsupportedNumbers(`Managed ${modifier} between 5 and 10 people`, "Managed between 5 and 10 people")).not.toEqual([]);
    }
    expect(unsupportedNumbers("Managed 5 to 10 people", "Managed no more than 5 to 10 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed no more than 5 to 10 people", "Managed 5 to 10 people")).not.toEqual([]);
    expect(unsupportedNumbers("Lost -5 to -10%", "Lost -5 to -10%")).toEqual([]);
    expect(unsupportedNumbers("Lost -5%", "Lost -5 to -10%")).not.toEqual([]);
    expect(unsupportedNumbers("Lost -5%", "Lost 5 to 10%")).not.toEqual([]);
    expect(unsupportedNumbers("Lost -10 to -5%", "Lost -10 to -5%")).toEqual([]);
    expect(unsupportedNumbers("Lost -10%", "Lost -10 to -5%")).not.toEqual([]);
    expect(unsupportedNumbers("Changed by -5%", "Changed by -5%")).toEqual([]);
    expect(unsupportedNumbers("Managed 25 people", "Managed twenty-five people")).toEqual([]);
    expect(unsupportedNumbers("Managed twenty five to thirty people", "Managed twenty five to thirty people")).toEqual([]);
    for (const count of ["5", "20", "25", "30"])
      expect(unsupportedNumbers(`Managed ${count} people`, "Managed twenty five to thirty people")).not.toEqual([]);
    for (const [value, endpoints] of [
      ["five hundred to six hundred", ["5", "100", "500", "600"]],
      ["1.2 million to 3.4 million", ["1200000", "3400000"]],
      ["five-hundred to 900", ["5", "100", "500", "900"]],
      ["five hundred–six hundred", ["5", "100", "500", "600"]],
      ["500 to a thousand", ["500", "1000"]],
    ] as const) {
      expect(unsupportedNumbers(`Managed ${value} people`, `Managed ${value} people`)).toEqual([]);
      for (const count of endpoints)
        expect(unsupportedNumbers(`Managed ${count} people`, `Managed ${value} people`)).not.toEqual([]);
    }
    expect(unsupportedNumbers("Managed 0.001 people", "Managed 1e-3 people")).toEqual([]);
    expect(unsupportedNumbers("Saved $5", "Saved $5 to $10 million")).not.toEqual([]);
    for (const source of ["5 to 10 millionfold", "five to ten hundredfold", "5 to 10٫5 million", "5 to 10/2 million", "5 to 10 millions", "five hundred to 10 five", "five hundred–5 five"]) {
      expect(unsupportedNumbers("Managed 5 to 10 people", `Managed ${source} people`)).not.toEqual([]);
      expect(unsupportedNumbers("Managed 5 people", `Managed ${source} people`)).not.toEqual([]);
      expect(unsupportedNumbers("Managed 10 people", `Managed ${source} people`)).not.toEqual([]);
      expect(unsupportedNumbers("Managed 1000000 people", `Managed ${source} people`)).not.toEqual([]);
    }
    for (const source of ["between 1/2 and 10", "between one half and ten", "half to 10", "5 to ½", "1/2–10", "5–½"]) {
      expect(unsupportedNumbers("Managed 5 people", `Managed ${source} people`)).not.toEqual([]);
      expect(unsupportedNumbers("Managed 10 people", `Managed ${source} people`)).not.toEqual([]);
      expect(unsupportedNumbers(`Managed ${source} people`, `Managed ${source} people`)).not.toEqual([]);
    }
    expect(unsupportedNumbers("Managed 25 people", "Managed twenty–five people")).toEqual([]);
    expect(unsupportedNumbers("Worked 2019–2021", "Worked 2019 to 2021")).toEqual([]);
    expect(unsupportedNumbers("Worked 2021-03-01", "Worked 2021/03/01")).toEqual([]);
  });
  it("keeps line-wrapped ranges and their units together", () => {
    for (const [source, equivalent] of [
      ["5 to\n10", "5 to 10"],
      ["5\n to 10", "5 to 10"],
      ["between 5\nand 10", "between 5 and 10"],
      ["between\n5 and 10", "between 5 and 10"],
      ["5–\n10", "5–10"],
      ["five hundred\r\nto\r\nsix hundred", "five hundred to six hundred"],
      ["5 through\u202810", "5 through 10"],
      ["5 to 10\nmillion", "5 to 10 million"],
      ["5\nmillion to 10\nmillion", "5 million to 10 million"],
      ["5 to 10\npercent", "5 to 10 percent"],
    ]) {
      expect(unsupportedNumbers(`Managed ${equivalent} people`, `Managed ${source} people`), source).toEqual([]);
      expect(unsupportedNumbers("Managed 5 people", `Managed ${source} people`), source).not.toEqual([]);
      expect(unsupportedNumbers("Managed 10 people", `Managed ${source} people`), source).not.toEqual([]);
    }
    expect(unsupportedNumbers("Managed 5 to 10 people", "Managed 5 to 10\nmillion people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 to 10 people", "Managed 5 to 10\npercent")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 to 10 people", "Managed 5 to 10\nmillionfold")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 10 people", "Managed 5 to\n10 millionfold people")).not.toEqual([]);
    for (const continuation of ["½", "/2", "percentile"])
      expect(unsupportedNumbers("Managed 5 to 10 people", `Managed 5 to 10\n${continuation} people`)).not.toEqual([]);
    // A dash beginning a new line could introduce a bullet or negative number.
    expect(unsupportedNumbers("Managed 5 -10 people", "Managed 5\n-10 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 people", "Managed 5\n-10 people")).not.toEqual([]);
    for (const count of ["500", "600"])
      expect(unsupportedNumbers(`Managed ${count} people`, "Managed five hundred\nto six hundred people")).not.toEqual([]);
    expect(unsupportedNumbers("Worked 2021-03-01", "Worked 2021/03/01")).toEqual([]);
    // A following list item is not a continuation of the preceding value.
    expect(unsupportedNumbers("Managed 5 people", "Managed 5 people\n- Mentored 10 people")).toEqual([]);
  });
  it("fails closed on pathological whitespace without matching other evidence quantities", () => {
    const gap = " ".repeat(129);
    expect(unsupportedNumbers("Managed 5 people", `Managed 5 people${gap}unknown`)).not.toEqual([]);
    expect(unsupportedNumbers(`Managed 5${gap}people`, "Managed 5 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 people", `Managed 5 people${" ".repeat(60_000)}unknown`)).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 people", `${("5" + " ".repeat(128) + "unknown ").repeat(10)}Managed 5 people`)).not.toEqual([]);
    expect(unsupportedNumbers("Managed 5 people", "Managed 5 people")).toEqual([]);
  });
  it("treats written, numeric, and mixed scaled quantities as a single quantity", () => {
    for (const [source, expected] of [
      ["five hundred", "500"], ["one hundred and 5", "105"],
      ["2 hundred", "200"], ["five-hundred-and-five", "505"],
      ["twenty-five hundred", "2500"], ["one hundred and five thousand", "105000"],
      ["100 million", "100000000"], ["five million and 2 hundred", "5000200"],
      [".5 million", "500000"], ["1,000.5 million", "1000500000"],
      ["1e-3 million", "1000"], ["five dozen", "60"],
      ["0.5 hundred thousand", "50000"],
    ]) {
      expect(unsupportedNumbers(`Managed ${expected} people`, `Managed ${source} people`)).toEqual([]);
      expect(unsupportedNumbers(`Managed ${source} people`, `Managed ${expected} people`)).toEqual([]);
    }
    for (const [source, component] of [
      ["one hundred and 5", "100"], ["one hundred and 5", "5"],
      ["2 hundred", "2"], ["2 hundred", "100"],
      [".5 million", "5000000"], ["100 million", "1000000"],
      ["five hundredfold", "5"], ["five hundredth", "5"],
      ["between 10 and 20 million", "10"],
    ]) expect(unsupportedNumbers(`Managed ${component} people`, `Managed ${source} people`)).not.toEqual([]);
    expect(unsupportedNumbers("Improved 500x", "Improved five hundredfold")).toEqual([]);
    expect(unsupportedNumbers("Ranked 500th", "Ranked five hundredth")).toEqual([]);
    expect(unsupportedNumbers("Lost -500%", "Lost minus five hundred percent")).toEqual([]);
    expect(unsupportedNumbers("Gained 5%", "Lost -five percent")).toEqual(["5%"]);
    expect(unsupportedNumbers("Raised $5000000", "Raised $five million")).toEqual([]);
    expect(unsupportedNumbers("Managed 2020 people", "Founded in two thousand and twenty")).toEqual(["2020"]);
    expect(unsupportedNumbers("Founded in 2020", "Founded in two thousand and twenty")).toEqual([]);
    for (const source of ["<1,000", ">=1,000", "<=1,000", "~1,000", "1,000+"])
      expect(unsupportedNumbers("Managed 1000 people", `Managed ${source} people`)).not.toEqual([]);
    for (const source of ["~five million", "five million-ish", "at least five million", "more than five million", "five million-plus", "five million or more"])
      expect(unsupportedNumbers("Managed 5000000 people", `Managed ${source} people`)).not.toEqual([]);
    expect(unsupportedNumbers("Managed nearly 500 people", "Managed about five hundred people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 100 people", "Managed a hundred and something people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 1000000000 people", "Managed 1000000000.0000001 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 1001 people", "Managed 1.001k people")).toEqual([]);
    // Never lose a small fractional component while adding a larger group.
    for (const source of ["one million and 0.00000000001", "0.00000000001 million and one", "one hundred and 0.0000000000000001 thousand"]) {
      expect(unsupportedNumbers("Managed 1000000 people", `Managed ${source} people`)).not.toEqual([]);
      expect(unsupportedNumbers(`Managed ${source} people`, "Managed people")).not.toEqual([]);
    }
    expect(unsupportedNumbers("Managed 1481481468148160 people", "Managed 123456789012347 dozen people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed 1.48148146814816 people", "Managed 0.123456789012347 dozen people")).not.toEqual([]);
  });

  it("never exposes components of unknown fractions and scale suffixes", () => {
    for (const source of ["one hundred and one-half", "one hundred and one-quarter", "one million and a half", "1/2 million", "1⁄2 million", "5∕10 million", "1½ million", "½ million", "five hundredfolded", "five hundredths", "five millions", "five ⁵million", "five\u200bhundred", "five\u2060hundred", "five\u00adhundred", "5٫5 million", "1 to 2 million", "5 ± 2 million"]) {
      for (const component of ["1", "2", "5", "100", "500", "1000000"]) {
        expect(unsupportedNumbers(`Managed ${component} people`, `Managed ${source} people`)).not.toEqual([]);
      }
      expect(unsupportedNumbers(`Managed ${source} people`, "Managed people")).not.toEqual([]);
    }
    for (const source of ["zero", "thirteen", "nineteen", "a million", "thousands", "half a million", "١٠", "１２", "𝟙𝟚", "Ⅻ", "2/3", "two-thirds"])
      expect(unsupportedNumbers(`Managed ${source} people`, "Managed people")).not.toEqual([]);
    for (const boundary of ["\n", "\r\n", "\u2028", "\u2029"])
      expect(unsupportedNumbers("Managed 505 people", `Managed five hundred${boundary}five people`)).toEqual(["505"]);
  });

  it("fails closed on oversized numeric phrases without recursing through each word", () => {
    const source = `${"100 ".repeat(9000)}million`;
    expect(unsupportedNumbers("Managed 100 people", `Managed ${source} people`)).not.toEqual([]);
  });

  it("treats written compound cardinals as one quantity, not their components", () => {
    for (const wording of ["twenty-five", "twenty five", "twenty‑five"]) {
      expect(unsupportedNumbers("Managed 25 people", `Managed ${wording} people`)).toEqual([]);
      expect(unsupportedNumbers(`Managed ${wording} people`, "Managed 25 people")).toEqual([]);
      expect(unsupportedNumbers("Managed 5 people", `Managed ${wording} people`)).toEqual(["5"]);
      expect(unsupportedNumbers("Managed 20 people", `Managed ${wording} people`)).toEqual(["20"]);
      expect(unsupportedNumbers(`Managed ${wording} people`, "Managed 20 people and 5 people")).toEqual([wording]);
    }
    expect(unsupportedNumbers("Lost -25%", "Lost minus twenty-five percent")).toEqual([]);
    expect(unsupportedNumbers("Gained 25%", "Lost minus twenty-five percent")).toEqual(["25%"]);
    for (const prefix of ["-", "−"]) {
      expect(unsupportedNumbers("Gained 25%", `Changed ${prefix}twenty-five percent`)).toEqual(["25%"]);
      expect(unsupportedNumbers("Changed -25%", `Changed ${prefix}twenty-five percent`)).toEqual([]);
    }
    expect(unsupportedNumbers("Managed 21 people", "Managed twenty-onefolded people")).toEqual(["21"]);
    expect(unsupportedNumbers("Raised $25,000,000", "Raised twenty-five million dollars")).toEqual([]);
    expect(unsupportedNumbers("Managed 25 people", "Managed twenty-five hundred people")).toEqual(["25"]);
    expect(unsupportedNumbers("Ranked 25th", "Ranked twenty-fifth")).toEqual([]);
    expect(unsupportedNumbers("Managed 25 people", "Started March twenty-five, 2021")).toEqual(["25"]);
    expect(unsupportedNumbers("Managed 25 people", "Started March twenty-five")).toEqual(["25"]);
    expect(unsupportedNumbers("Managed 25 people", "Started twenty-five March")).toEqual(["25"]);
    expect(unsupportedNumbers("Started March twenty-five, 2021", "Started March 25, 2021")).toEqual([]);
  });

  it("does not join written compound numbers or their date context across lines", () => {
    for (const lineBreak of ["\n", "\r\n", "\u2028", "\u2029"]) {
      expect(unsupportedNumbers("Managed 25 people", `Managed twenty${lineBreak}five people`)).toEqual(["25"]);
      expect(unsupportedNumbers("Managed 25 people", `Managed twenty-${lineBreak}five people`)).toEqual(["25"]);
      expect(unsupportedNumbers("Started March twenty-five, 2021", `Started March${lineBreak}twenty-five, 2021`)).not.toEqual([]);
      expect(unsupportedNumbers("Started March twenty-five, 2021", `Started March twenty-five,${lineBreak}2021`)).not.toEqual([]);
    }
  });
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
    expect(unsupportedNumbers("Served 40 services", "served forty services")).toEqual([]);
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

  it.each([
    ["Led the migration", "Never led the migration"],
    ["Led the migration", "Did not lead the migration"],
    ["Led the migration", "Didn't lead the migration"],
    ["Led the migration", "No experience leading the migration"],
    ["Built the billing API", "Never built the billing API"],
    ["Owned the platform", "Was not the owner of the platform"],
    ["Founded the company", "Never founded the company"],
  ])("rejects %s when its only matching action is negated: %s", (claim, text) => {
    // A retained or explicitly selected level cannot override a direct denial.
    expect(checkClaim(claim, [{ text, level: "founded" }]).ok).toBe(false);
  });

  it.each([
    ["Never led the migration", "Led the migration"],
    ["Did not lead the migration", "Led the migration"],
    ["No experience leading the migration", "Led the migration"],
    ["Never built the billing API", "Built the billing API"],
  ])("rejects a negative action %s when the only evidence asserts it: %s", (claim, text) => {
    expect(checkClaim(claim, [{ text, level: "founded" }]).ok).toBe(false);
    expect(checkClaim(claim, [{ text: claim, level: "founded" }]).ok).toBe(true);
  });

  it("keeps an exact negative statement and recognizes a later positive assertion", () => {
    expect(checkClaim("Never led the migration", [{ text: "Never led the migration" }]).ok).toBe(true);
    expect(checkClaim("Led the migration", [{ text: "Never led the first migration, but led the second migration" }]).ok).toBe(true);
    expect(checkClaim("Led the migration", [{ text: "Not only led the migration but also mentored engineers" }]).ok).toBe(true);
    expect(checkClaim("Led the migration", [{ text: "No budget was allocated; I led the migration" }]).ok).toBe(true);
    expect(checkClaim("Led the migration", [{ text: "My colleague never led the migration, but I led the migration" }]).ok).toBe(true);
    // Mentioning a colleague's denial alone does not support the candidate's claim.
    expect(checkClaim("Led the migration", [{ text: "My colleague never led the migration" }]).ok).toBe(false);
  });

  it("does not let a positive action on a different object cancel an explicit denial", () => {
    const evidence = [{ text: "Did not deploy Kubernetes; deployed Docker", level: "implemented" as const }];
    expect(checkClaim("Deployed Kubernetes", evidence).problems).toContain("actions contradicted by the evidence: deploy:kubernetes");
    expect(checkClaim("Deployed Docker", evidence).ok).toBe(true);
    expect(checkClaim("Did not deploy Kubernetes", evidence).ok).toBe(true);
  });

  it("does not turn an explicit plan into a completed action", () => {
    for (const source of [
      "Planned to deploy Kubernetes",
      "Intended to deploy Kubernetes; deployed Docker",
      "Aimed to deploy Kubernetes",
      "Planned to deploy Kubernetes; never deployed Kubernetes",
    ]) {
      expect(checkClaim("Deployed Kubernetes", [{ text: source, level: "implemented" }]).ok).toBe(false);
    }
    expect(checkClaim("Planned to deploy Kubernetes", [{ text: "Planned to deploy Kubernetes", level: "implemented" }]).ok).toBe(true);
    expect(checkClaim("Deployed Kubernetes", [{ text: "Planned to deploy Kubernetes, then deployed Kubernetes", level: "implemented" }]).ok).toBe(true);
  });

  it("does not infer a blanket object denial from a qualified denial or override positive evidence", () => {
    const qualified = [{ text: "Did not deploy Kubernetes in production; deployed Docker", level: "implemented" as const }];
    expect(checkClaim("Deployed Kubernetes", qualified).problems).not.toContain("actions contradicted by the evidence: deploy:kubernetes");
    const both = [{ text: "Did not deploy Kubernetes; deployed Kubernetes in staging", level: "implemented" as const }];
    expect(checkClaim("Deployed Kubernetes", both).problems).not.toContain("actions contradicted by the evidence: deploy:kubernetes");
    const notOnly = [{ text: "Not only deployed Kubernetes; deployed Docker", level: "implemented" as const }];
    expect(checkClaim("Deployed Kubernetes", notOnly).ok).toBe(true);
  });

  it("treats a colleague's denial conservatively and preserves an explicit user assertion", () => {
    const colleague = [{ text: "My colleague never deployed Kubernetes; I deployed Docker", level: "implemented" as const }];
    expect(checkClaim("Deployed Kubernetes", colleague).ok).toBe(false);
    const user = [{ text: "My colleague never deployed Kubernetes; I deployed Docker and deployed Kubernetes", level: "implemented" as const }];
    expect(checkClaim("Deployed Kubernetes", user).ok).toBe(true);
  });

  it.each([
    ["Increased latency by 50%", "Reduced latency by 50%"],
    ["Reduced customer retention by 20%", "Increased customer retention by 20%"],
    ["Boosted throughput by 25%", "Cut throughput by 25%"],
    ["Cut the response time by 10%", "Raised the response time by 10%"],
  ])("rejects the reversed outcome in %s against %s", (claim, text) => {
    const result = checkClaim(claim, [{ text, level: "founded" }]);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.startsWith("outcome direction contradicted"))).toBe(true);
    expect(checkClaim(text, [{ text, level: "founded" }]).ok).toBe(true);
  });

  it("does not infer a direction reversal across different or ambiguous objects", () => {
    expect(checkClaim("Increased throughput by 20%", [{ text: "Reduced latency by 20%", level: "founded" }]).ok).toBe(true);
    expect(checkClaim("Increased latency by 20%", [{ text: "Reduced latency by 20%, then increased latency by 20%", level: "founded" }]).ok).toBe(true);
    expect(checkClaim("Increased latency by 20%", [{ text: "Did not reduce latency by 20%", level: "founded" }]).problems.some((problem) => problem.startsWith("outcome direction contradicted"))).toBe(false);
    expect(checkClaim("Increased cost of infrastructure by 20%", [{ text: "Reduced cost of operations by 20%", level: "founded" }]).ok).toBe(true);
    expect(checkClaim("Increased investments in training by 20%", [{ text: "Reduced investments in hiring by 20%", level: "founded" }]).problems.some((problem) => problem.startsWith("outcome direction contradicted"))).toBe(false);
  });

  it("does not swap percentages between two explicitly quantified outcomes", () => {
    const evidence = [{ text: "Reduced latency by 50% and increased throughput by 30%", level: "implemented" as const }];
    expect(checkClaim("Reduced latency by 30%", evidence).ok).toBe(false);
    expect(checkClaim("Reduced latency by 50%", evidence).ok).toBe(true);
    expect(checkClaim("Increased throughput by 30%", evidence).ok).toBe(true);
    expect(checkClaim("Cut latency by 30%", [
      { text: "Reduced latency by 50%", level: "implemented" },
      { text: "Increased throughput by 30%", level: "implemented" },
    ]).ok).toBe(false);
    expect(checkClaim("Reduced latency by 30%", [
      ...evidence, { text: "Reduced latency by 30% in another service", level: "implemented" },
    ]).ok).toBe(true);
  });

  it("leaves ambiguous and unparsed percentage relationships to the judge", () => {
    const hasSwap = (text: string) => checkClaim("Reduced latency by 30%", [{ text, level: "implemented" }])
      .problems.some((problem) => problem.startsWith("outcome percentage assigned"));
    expect(hasSwap("Did not reduce latency by 50%; increased throughput by 30%")).toBe(false);
    expect(hasSwap("Reduced latency by 50% and increased throughput by 30%; latency fell by 30% elsewhere")).toBe(false);
    expect(hasSwap("Reduced latency by at least 50% and increased throughput by 30%")).toBe(false);
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

  it("rejects a cited line that reverses an outcome", () => {
    const supporting = fact("latency", "r1", "Reduced latency by 20%");
    const result = checkLine({ roleId: "r1", text: "Increased latency by 20%", factIds: [supporting.id] }, new Map([[supporting.id, supporting]]), new Set([supporting.id]));
    expect(result.problems.some((problem) => problem.startsWith("outcome direction contradicted"))).toBe(true);
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
