import type { SplitRefusal } from "../../src/pipeline/split";

// Labelled lines for dividing a line into its claims. Every line here is made up. They exercise
// the checks and say what each check is for; they cannot set a threshold. How often an accepted
// division changes a line's meaning has to be measured on real resumes given with consent
// (docs/taxonomy-pipelines-design.md, "What must be measured before anything is shown").
//
// A part is written as the stretches of the line it takes, in the order they appear in the line,
// so the labels can be read beside it.

export type LabelledPart = [kind: "clause" | "result" | "mention", pieces: string[], of?: number];

export interface SplitExample {
  line: string;
  /** "split" when a careful reader would divide the line; otherwise why it must stay whole. */
  expect: "split" | SplitRefusal;
  /** One division a careful reader would accept. */
  gold?: LabelledPart[];
  /**
   * Divisions made only of the line's own words that say something the line doesn't: in a claim,
   * in a mention, or in which claim a result is the outcome of. None may ever be accepted.
   * `caught` is the check that refuses it without a model, or "judge" when nothing but the judge
   * can.
   */
  traps?: { says: string; parts: LabelledPart[]; caught: SplitRefusal | "judge" }[];
}

export const SPLIT_LINES: SplitExample[] = [
  {
    line: "Designed and built the API, cutting deploy time from 40 minutes to 6.",
    expect: "split",
    gold: [
      ["clause", ["Designed", "the API"]],
      ["clause", ["built the API"]],
      ["result", ["cutting deploy time from 40 minutes to 6"], 1],
      ["mention", ["40 minutes"]],
    ],
    traps: [
      {
        says: "drops the unit of a figure",
        parts: [
          ["clause", ["Designed", "the API"]],
          ["clause", ["built the API"]],
          ["result", ["cutting deploy time from 40", "to 6"], 1],
        ],
        caught: "word_lost",
      },
    ],
  },
  {
    line: "Led a team of 5 and shipped 3 products",
    expect: "split",
    gold: [
      ["clause", ["Led a team of 5"]],
      ["clause", ["shipped 3 products"]],
    ],
    traps: [
      {
        says: "gives each verb the other's figure",
        parts: [
          ["clause", ["Led", "3 products"]],
          ["clause", ["a team of 5", "shipped"]],
        ],
        caught: "figure_skipped",
      },
      {
        says: "drops how many were led",
        parts: [
          ["clause", ["Led a team"]],
          ["clause", ["shipped 3 products"]],
        ],
        caught: "word_lost",
      },
    ],
  },
  {
    line: "Cut costs by 30% and raised uptime to 99%",
    expect: "split",
    gold: [
      ["clause", ["Cut costs by 30%"]],
      ["clause", ["raised uptime to 99%"]],
    ],
    traps: [
      {
        says: "swaps the two outcomes' figures",
        parts: [
          ["clause", ["Cut costs by", "99%"]],
          ["clause", ["30%", "raised uptime to"]],
        ],
        caught: "figure_skipped",
      },
    ],
  },
  {
    line: "Led the design team and shipped the billing product",
    expect: "split",
    gold: [
      ["clause", ["Led the design team"]],
      ["clause", ["shipped the billing product"]],
    ],
    traps: [
      {
        says: "gives each verb the other's object",
        parts: [
          ["clause", ["Led", "the billing product"]],
          ["clause", ["the design team", "shipped"]],
        ],
        caught: "judge",
      },
    ],
  },
  {
    line: "Built a service handling 2 million events and cut its costs by 30%",
    expect: "split",
    gold: [
      ["clause", ["Built a service handling 2 million events"]],
      ["clause", ["cut its costs by 30%"]],
    ],
    traps: [
      {
        says: "cuts a figure from the word that scales it",
        parts: [
          ["clause", ["Built a service handling 2"]],
          ["clause", ["million events", "cut its costs by 30%"]],
        ],
        caught: "claim_check",
      },
      {
        says: "mentions a figure without the word that scales it",
        parts: [
          ["clause", ["Built a service handling 2 million events"]],
          ["clause", ["cut its costs by 30%"]],
          ["mention", ["2"]],
        ],
        caught: "claim_check",
      },
    ],
  },
  {
    line: "Migrated 40 services to Kubernetes and trained the on-call team",
    expect: "split",
    gold: [
      ["clause", ["Migrated 40 services to Kubernetes"]],
      ["clause", ["trained the on-call team"]],
      ["mention", ["Kubernetes"]],
    ],
    traps: [
      {
        says: "says the on-call team was migrated",
        parts: [
          ["clause", ["Migrated", "the on-call team"]],
          ["clause", ["40 services to Kubernetes", "trained"]],
        ],
        caught: "figure_skipped",
      },
    ],
  },
  {
    line: "Rebuilt search in Elasticsearch, raising click-through from 12% to 19%",
    expect: "split",
    gold: [
      ["clause", ["Rebuilt search in Elasticsearch"]],
      ["result", ["raising click-through from 12% to 19%"], 0],
      ["mention", ["Elasticsearch"]],
    ],
    traps: [
      {
        says: "keeps where the figure ended and drops where it began",
        parts: [
          ["clause", ["Rebuilt search in Elasticsearch"]],
          ["result", ["raising click-through", "to 19%"], 0],
        ],
        caught: "word_lost",
      },
    ],
  },
  {
    line: "Wrote the on-call runbooks and ran weekly incident reviews",
    expect: "split",
    gold: [
      ["clause", ["Wrote the on-call runbooks"]],
      ["clause", ["ran weekly incident reviews"]],
    ],
    traps: [
      {
        says: "gives each verb the other's object",
        parts: [
          ["clause", ["Wrote", "weekly incident reviews"]],
          ["clause", ["the on-call runbooks", "ran"]],
        ],
        caught: "judge",
      },
    ],
  },
  {
    line: "Rebuilt the checkout, raising conversion by 12%, and led the design team",
    expect: "split",
    gold: [
      ["clause", ["Rebuilt the checkout"]],
      ["result", ["raising conversion by 12%"], 0],
      ["clause", ["led the design team"]],
    ],
    traps: [
      {
        says: "names a claim that comes after a result as what led to it",
        parts: [
          ["clause", ["Rebuilt the checkout"]],
          ["result", ["raising conversion by 12%"], 2],
          ["clause", ["led the design team"]],
        ],
        caught: "result_before_claim",
      },
    ],
  },
  {
    line: "Trained 4 new hires and rewrote the importer, cutting import time from 2 hours to 5 minutes",
    expect: "split",
    gold: [
      ["clause", ["Trained 4 new hires"]],
      ["clause", ["rewrote the importer"]],
      ["result", ["cutting import time from 2 hours to 5 minutes"], 1],
    ],
    traps: [
      {
        says: "says the other thing done is what cut the time",
        parts: [
          ["clause", ["Trained 4 new hires"]],
          ["clause", ["rewrote the importer"]],
          ["result", ["cutting import time from 2 hours to 5 minutes"], 0],
        ],
        caught: "judge",
      },
    ],
  },
  { line: "Helped lead the migration and the rollout", expect: "qualified" },
  { line: "Did not manage the budget but ran the roadmap", expect: "qualified" },
  // Typed with an accent and with an opening quotation mark where the apostrophe belongs.
  { line: "Didn\u00B4t manage the budget but ran the roadmap", expect: "qualified" },
  { line: "Wasn\u2018t on the on-call rota but wrote every runbook", expect: "qualified" },
  // A listed phrase with a hyphen for its space.
  { line: "AWS Solutions Architect certification in-progress and Terraform Associate passed", expect: "qualified" },
  // Something still under way beside something done.
  { line: "PMP certification ongoing and Certified ScrumMaster completed in 2024", expect: "qualified" },
  { line: "Built services in Python or Go and deployed them weekly", expect: "qualified" },
  { line: "Proposed a redesign of billing, cutting costs by 20%", expect: "qualified" },
  { line: "Reduced latency by up to 40% and doubled throughput", expect: "qualified" },
  { line: "Was part of the team that rebuilt search and shipped it", expect: "qualified" },
  { line: "Planning to migrate 40 services and retire the old cluster", expect: "qualified" },
  { line: "Built the API", expect: "length" },
  { line: "Managed a team of 12 engineers across 3 offices", expect: "one_claim" },
  { line: "Maintained the payments ledger for 4 years", expect: "one_claim" },
];
