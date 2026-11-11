import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { offers } from "../../src/pipeline/match";
import { MATCH_PAIRS } from "../fixtures/match-pairs";
import { credentials, restModels, wranglerVars } from "./rest-models";

// Offering two wordings as the same fact, against the real judge. The one outcome that must
// never happen is two different claims offered as the same. Everything else is reported for a
// person to read. The labelled pairs are made up: passing here does not set a threshold, which
// needs real records given with consent. Writes match-eval-report.json.

const creds = credentials();
const vars = wranglerVars(process.env.EVAL_ENV || "staging");
const report: Record<string, unknown>[] = [];

afterAll(() => {
  if (report.length) writeFileSync("match-eval-report.json", JSON.stringify({ models: { judge: vars.MODEL_JUDGE }, pairs: report }, null, 2));
});

describe.skipIf(!creds)("offering two lines as the same", () => {
  it.each(MATCH_PAIRS)("$later / $earlier", async (example) => {
    const [offer] = await offers(restModels(creds!, vars), [{ later: { id: "later", text: example.later }, earlier: { id: "earlier", text: example.earlier } }]);
    const found = !offer ? "different" : offer.relation === "same" ? "same" : offer.from === "later" ? "later-fuller" : "earlier-fuller";
    report.push({ ...example, found });
    if (example.expect === "different") expect(found, `offered as the same: ${example.why}`).not.toBe("same");
  });
});
