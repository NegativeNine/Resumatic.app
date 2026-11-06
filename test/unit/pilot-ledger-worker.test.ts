import { describe, expect, it } from "vitest";
import { evalBudgetFromEnv } from "../extract-evals/budget";

describe.skipIf(process.env.TEST_PILOT_LEDGER_WORKER !== "1")(
  "durable pilot worker",
  () => {
    it("reserves against the shared ledger without making a network request", () => {
      const budget = evalBudgetFromEnv();
      budget.reserve("@cf/openai/gpt-oss-20b", "{}", 8192, 6, 6);
      expect(budget.calls).toBeGreaterThanOrEqual(6);
    });
  },
);
