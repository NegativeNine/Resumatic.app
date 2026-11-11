import { describe, expect, it } from "vitest";
import { unsupportedNumbers } from "../../src/grounding/claims";

describe("negated quantity comparisons", () => {
  it.each([
    ["not more than", "more than", "at most"],
    ["no greater than", "greater than", "at most"],
    ["not greater than", "greater than", "at most"],
    ["no fewer than", "fewer than", "at least"],
    ["not fewer than", "fewer than", "at least"],
    ["not less than", "less than", "at least"],
    ["not over", "over", "at most"],
    ["not under", "under", "at least"],
    ["a maximum of", "more than", "at most"],
    ["fewer than or equal to", "more than", "at most"],
  ])("preserves the bound in %s", (negative, opposite, equivalent) => {
    const evidence = `Managed ${negative} 10 people`;
    expect(unsupportedNumbers(`Managed ${opposite} 10 people`, evidence)).not.toEqual([]);
    expect(unsupportedNumbers(`Managed 10 people`, evidence)).not.toEqual([]);
    expect(unsupportedNumbers(`Managed ${equivalent} 10 people`, evidence)).toEqual([]);
    expect(unsupportedNumbers(evidence, evidence)).toEqual([]);
  });

  it("preserves negated comparisons for word quantities and currency", () => {
    expect(unsupportedNumbers("Managed more than ten projects", "Managed not more than ten projects")).not.toEqual([]);
    expect(unsupportedNumbers("Managed fewer than $10", "Managed no fewer than $10")).not.toEqual([]);
  });

  it("does not confuse an explicitly negated bound with its positive form or another bound", () => {
    expect(unsupportedNumbers("Managed at most 10 people", "Managed not at most 10 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed not at least 10 people", "Managed not at most 10 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed no more than 10 people", "Managed not no more than 10 people")).not.toEqual([]);
    expect(unsupportedNumbers("Managed not at most 10 people", "Managed not at most 10 people")).toEqual([]);
  });

  it.each([
    ["more than 10", "not always more than 10"],
    ["greater than 10", "not strictly greater than 10"],
    ["at most 10", "not not more than 10"],
    ["10", "not 10"],
    ["10 or more", "not 10 or more"],
    ["10", "10 or fewer"],
    ["10", "10 or less"],
    ["10", "10 people or fewer"],
    ["10", "10 people maximum"],
    ["10 people at least", "10 people at most"],
    ["10", "at   most 10"],
    ["10", "up-to 10"],
    ["10", "maximum: 10"],
    ["5 to 10", "hardly between 5 and 10"],
  ])("does not treat %s as supported by %s", (claim, evidence) => {
    expect(unsupportedNumbers(`Managed ${claim} people`, `Managed ${evidence} people`)).not.toEqual([]);
    expect(unsupportedNumbers(`Managed ${evidence} people`, `Managed ${evidence} people`)).toEqual([]);
  });

  it("does not carry negation across a clause or interpret 'not only' as a denial", () => {
    expect(unsupportedNumbers("Managed 10 people", "Not only managed 10 people but also mentored staff")).toEqual([]);
    expect(unsupportedNumbers("Managed 10 people", "Never managed billing; managed 10 people")).toEqual([]);
  });

  it("matches a suffix bound after a short unit to its equivalent prefix", () => {
    expect(unsupportedNumbers("Managed at most 10 people", "Managed 10 people maximum")).toEqual([]);
    expect(unsupportedNumbers("Managed at least 10 people", "Managed 10 people or more")).toEqual([]);
  });

  it("does not borrow a qualifier from a different source line", () => {
    expect(unsupportedNumbers("Managed 10+ people", "Managed 10\n+ another responsibility")).not.toEqual([]);
    expect(unsupportedNumbers("Managed at least 10 people", "at least\nManaged 10 people")).not.toEqual([]);
  });
});

describe("upto, written as one word", () => {
  it("is the same bound on a figure as up to", () => {
    expect(unsupportedNumbers("Cut costs by 30%", "Cut costs by upto 30%")).not.toEqual([]);
    expect(unsupportedNumbers("Cut costs by at least 30%", "Cut costs by Upto 30%")).not.toEqual([]);
    expect(unsupportedNumbers("Cut costs by upto 30%", "Cut costs by upto 30%")).toEqual([]);
    expect(unsupportedNumbers("Cut costs by up to 30%", "Cut costs by up to 30%")).toEqual([]);
    expect(unsupportedNumbers("Cut costs by upto 30%", "Cut costs by up to 30%")).toEqual([]);
    expect(unsupportedNumbers("Cut costs by up to 30%", "Cut costs by upto 30%")).toEqual([]);
    expect(unsupportedNumbers("Cut costs by at most 30%", "Cut costs by upto 30%")).toEqual([]);
  });

  it("is the same bound when it is denied", () => {
    expect(unsupportedNumbers("Cut costs by upto 30%", "Cut costs by not upto 30%")).not.toEqual([]);
    expect(unsupportedNumbers("Cut costs by 30%", "Cut costs by not upto 30%")).not.toEqual([]);
    expect(unsupportedNumbers("Cut costs by not up to 30%", "Cut costs by not upto 30%")).toEqual([]);
  });

  it("is not read inside a longer word", () => {
    expect(unsupportedNumbers("Opened 30 stores", "Opened uptown 30 stores")).toEqual([]);
    expect(unsupportedNumbers("Opened 30 stores", "Set upto 30 stores")).not.toEqual([]);
  });
});
