import { describe, it } from "vitest";
import { credentials, restModels, wranglerVars } from "./rest-models";
import { runPilotTailoring } from "./pilot-tailor";

// Exploratory only: synthetic confirmed facts isolate tailoring; this does not
// cover Workflow execution, conversion, extraction or real career material.
const creds = credentials();
describe.skipIf(!creds)("first pilot", () => {
  it("confirmed-facts tailoring", async () => {
    const vars = wranglerVars(process.env.EVAL_ENV || "staging");
    await runPilotTailoring(restModels(creds!, vars));
  });
});
