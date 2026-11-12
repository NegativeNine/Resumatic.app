import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { TAG_LINES } from "../fixtures/tag-lines";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";
import { requireTagging } from "./nonvacuity";
import { credentials, restModels, wranglerVars } from "./rest-models";
import { precision, runTagging, type TaggingRun } from "./tagging";

// Tagging facts and job roles, against the real judge. The labelled examples are put through
// the tagger exactly as an upload's rows are, over the made-up taxonomy the tests use. The one
// outcome that must never happen is a tag a careful reader would not give: a label the line only
// mentions, denies or intends. Everything else is reported for a person to read, with the
// precision of each method. The made-up taxonomy's vector index is built here with the real
// embedding model, as an operator's build would make it, so concepts near a line in meaning are
// put to the judge too, and what the vector part did is reported. The examples and the taxonomy
// are made up: passing here does not set a threshold, which needs lines given with consent and
// the real taxonomy. Writes tag-eval-report.json.

const creds = credentials();
const vars = wranglerVars(process.env.EVAL_ENV || "staging");
let run: TaggingRun | null = null;

afterAll(() => {
  if (run)
    writeFileSync(
      "tag-eval-report.json",
      JSON.stringify(
        {
          models: { judge: vars.MODEL_JUDGE },
          taxonomy: TAXONOMY_FIXTURE.info.version,
          run: run.report,
          vector: run.report.vector,
          methods: precision(run.outcomes),
          candidates: run.outcomes.map((outcome) => ({
            subject: outcome.subject,
            concept: outcome.concept,
            label: outcome.label,
            expected: outcome.listed?.expect ?? null,
            decidedBy: outcome.listed?.decidedBy ?? null,
            why: outcome.listed?.why ?? null,
            found: outcome.found,
            tagged: outcome.tagged,
          })),
        },
        null,
        2,
      ),
    );
});

describe.skipIf(!creds)("tagging facts and job roles", () => {
  it("gives no tag a careful reader would not", async () => {
    const models = restModels(creds!, vars);
    run = await runTagging(models, TAG_LINES, vars.MODEL_JUDGE, { embed: models.embed });
    // A run that ended early, found nothing or proposed nothing has measured nothing.
    expect(run.report.failed, "the run ended early").toBeUndefined();
    expect(run.report.vector.failed, "the vector part ended early").toBeUndefined();
    expect(run.left, "a cap left examples out").toEqual({ subjects: 0, words: 0, per_role: 0, per_fact: 0, per_upload: 0 });
    requireTagging(run.outcomes);
    const wrong = run.outcomes.filter((outcome) => outcome.tagged && outcome.listed?.expect !== "tag");
    expect(wrong.map((outcome) => `${outcome.subject} / ${outcome.label ?? outcome.concept}: ${outcome.listed?.why ?? "not a listed candidate"}`)).toEqual([]);
  });
});
