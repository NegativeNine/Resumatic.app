import { describe, expect, it } from "vitest";
import { SEED_KINDS } from "../evals/seeded";
import { seedFailureRecords, summarizeSeedRecords } from "../evals/seeded-report";

describe("seeded evaluation reporting", () => {
  it("marks every seed not run when baseline or model initialization fails", () => {
    const records = seedFailureRecords("synthetic", 0, undefined, false);
    expect(records[0]).toMatchObject({ outcome: "failed", caseId: "synthetic", repeat: 0 });
    expect(records.slice(1).map((r) => r.seed)).toEqual([...SEED_KINDS]);
    expect(records.slice(1).every((r) => r.outcome === "not_run")).toBe(true);
  });

  it("records the active error once and only later kinds as not run", () => {
    const records = seedFailureRecords("synthetic", 1, "raiseScope", false);
    expect(records[0]).toMatchObject({ seed: "raiseScope", outcome: "failed" });
    expect(records.slice(1).map((r) => r.seed)).toEqual(SEED_KINDS.slice(SEED_KINDS.indexOf("raiseScope") + 1));
    expect(records.slice(1).every((r) => r.outcome === "not_run")).toBe(true);
    expect(seedFailureRecords("synthetic", 1, "raiseScope", true)).toEqual(records.slice(1));
    expect(seedFailureRecords("synthetic", 1, "followInstruction", true)).toEqual([]);
  });

  it("does not report a perfect catch rate when any case failed or did not run", () => {
    const records = [
      { caseId: "first", repeat: 0, seed: "addTool" as const, outcome: "evaluated", caught: true },
      { caseId: "second", repeat: 0, seed: "addTool" as const, outcome: "failed" },
      { caseId: "third", repeat: 0, seed: "addTool" as const, outcome: "not_run" },
    ];
    expect(summarizeSeedRecords(records).find((r) => r.kind === "addTool"))
      .toMatchObject({ planted: 1, caught: 1, failed: 1, notRun: 1, catchRate: null });
  });

  it("never credits an uncertain result as caught", () => {
    const records = [
      { caseId: "first", repeat: 0, seed: "negateAction" as const, outcome: "evaluated", caught: true, uncertain: true },
      { caseId: "second", repeat: 0, seed: "negateAction" as const, outcome: "evaluated", caught: true, uncertain: false },
    ];
    expect(summarizeSeedRecords(records).find((r) => r.kind === "negateAction"))
      .toMatchObject({ planted: 2, caught: 1, uncertain: 1, catchRate: 0.5 });
  });
});
