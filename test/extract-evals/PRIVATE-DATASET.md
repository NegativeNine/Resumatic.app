# Private extraction evaluation

The checked-in source fixtures exercise file construction only. Promotion requires a separate, consented corpus and actual, independently labeled conversion output. This workflow never loads private material from Git, prints résumés to the console, or makes a model call without the existing explicit live budget and call cap.

Create a private staging directory **outside the repository**, owned by the operator with mode `0700`; make every manifest, source, converted text, label, consent receipt, adjudication receipt, and audit file owner-only (`0600`). Copy approved files from the private R2 bucket into that directory through an access-controlled channel; this tool does not fetch from R2. Store or destroy staging files according to the consent and retention policy. A symlink or hard link to the checkout or outside the private directory is rejected.

Create `manifest.json` with the following structure. `case-*`, reviewer IDs and receipt references must be opaque random identifiers, never names or email addresses. Replace each hash with the SHA-256 of the exact referenced file.

```json
{
  "version": 1,
  "profile": "round-1",
  "cases": [{
    "id": "case-0123456789abcdef",
    "split": "holdout",
    "origin": "real",
    "format": "pdf",
    "language": "en",
    "layout": "single-column",
    "source": {"path": "files/01.pdf", "sha256": "<64 lowercase hexadecimal characters>"},
    "markdown": {"path": "converted/01.md", "sha256": "<64 lowercase hexadecimal characters>"},
    "gold": {"path": "labels/01.json", "sha256": "<64 lowercase hexadecimal characters>"},
    "referenceDate": "2026-11-05",
    "consent": {"granted": true, "scope": "model-evaluation", "receiptRef": "consent_opaque_01", "evidence": {"path": "consent/01.txt", "sha256": "<64 lowercase hexadecimal characters>"}},
    "labeling": {"labelerIds": ["labeler_opaque_01", "labeler_opaque_02"], "adjudicated": true, "evidence": {"path": "adjudication/01.txt", "sha256": "<64 lowercase hexadecimal characters>"}},
    "conversion": {"provider": "staging_conversion", "date": "2026-11-05", "pdfMetadataDisabled": true, "evidence": {"path": "conversion/01.json", "sha256": "<64 lowercase hexadecimal characters>"}}
  }]
}
```

For synthetic cases set `origin` to `synthetic`, `consent` to `null`, and labeling `evidence` to `null`; source hashes and distinct labeler identifiers are still required. A real case requires a nonempty consent receipt and adjudication evidence, both hash-verified. Receipt contents remain private. The manifest is a trusted operator attestation; a hash does not itself prove consent or the independence of reviewers. Do not include a duplicate document or duplicate converted text in either split. The `round-1` profile needs at least 30 distinct cases: 20 synthetic, 10 real, 20 development and 10 held-out. The `full` profile needs at least 40: 20 synthetic, 20 real, 25 development and 15 held-out. Each held-out split needs at least three real and three synthetic cases, both PDF and DOCX, and instruction traps in at least three distinct cases. A Round 1 winner is a beta choice, not full-corpus or launch evidence.

Each case has a separate, nonempty structured JSON attestation. A consent file contains `version: 1`, `caseId`, `sourceSha256`, `granted: true`, `scope: "model-evaluation"`, and the matching `receiptRef`. A real-case adjudication file contains `version: 1`, `caseId`, `sourceSha256`, `markdownSha256`, `goldSha256`, the two `labelerIds`, and `adjudicated: true`. Every conversion file contains `version: 1`, `caseId`, `sourceSha256`, `markdownSha256`, the matching `provider` and `date`, `pdfMetadataDisabled: true`, `sourceReadable: true`, and `conversionReviewed: true`. These bind the operator's statements to the exact files; maintain the actual consent and review records privately. PDF structure and the required DOCX archive entries are also checked, but those checks and these attestations are not independent proof that a real conversion or consent occurred.

`gold` is JSON with `roles`, `facts`, and `traps` arrays as defined in `score.ts`. Its IDs must be opaque strings of at least eight characters. Spans are zero-based, half-open UTF-16 offsets into that case's **actual frozen converted Markdown**, not the original synthetic reference text. Facts may reference an existing role ID or null. Both labelers and the adjudicator must review the actual conversion and any ambiguities before the manifest says `adjudicated: true`. PDF metadata must be disabled for the conversion.

When a role is explicitly ongoing, label it with `current: true`, a known `start`, and `end: null`. The scorer then checks that the predicted role actually renders as current. Leave `current` absent when an end date is unknown; an absent end alone is not evidence of an ongoing role. A role cannot be labeled current and have a dated end.

When the source explicitly states a start and the end is unknown, label `unknownEnd: true`, the known `start`, and `end: null`. The scorer then distinguishes the unknown-end representation from an incorrectly ongoing role. Do not label the same role both current and unknown-ended.

Label each skill as its own `skill` fact, with its span covering the exact skill name rather than the full list. The scorer compares the proposed skill text with that literal span and requires the span to lie within the proposal's source evidence; it also reports skills precision, recall and F1. The broader evidence line is retained for qualifier checks. Missing skill labels distort overall precision and recall, so reviewers must label every in-scope skill.

## Run and audit

An offline, no-model dry run validates the corpus and exercises scoring:

```sh
npm run eval:extract -- --private-dataset=/absolute/private/staging --split=dev
```

A live run requires configured model credentials, explicit positive `EVAL_BUDGET_USD` and integer `EVAL_MAX_CALLS`, verified shared accounting, and provider-side spending bounds. Live dispatch remains blocked until those safeguards are established. Price overrides in `EVAL_MODEL_PRICES` must match the later promotion assessment. After obtaining separate authorization for the full run, use the private held-out corpus:

```sh
npm run eval:extract -- --live --private-dataset=/absolute/private/staging --strategy=llm:default,clairic --split=holdout --repeat=3
```

This is the full held-out evaluation, not the authorized one-case pilot below; do not run it against the pilot authorization.

The public `extract-report.json` is metadata only and includes the run ID and the SHA-256 of a private snapshot in `evaluation-snapshots/<run-id>.json`. That owner-only snapshot contains sensitive proposed text and evidence for human review; do not commit or publish it. An offline assessment with no audit reports pending status and a deterministic `sampleSeed` and list of 50 `sampleKeys` per strategy, derived from the manifest hash, tested configuration, snapshot hash and candidate keys. Look up those keys in the private snapshot; reviewers must examine those samples, examine every judge/human disagreement, and adjudicate disagreements. Do not cherry-pick a different 50. This reproducibility does not by itself establish impartial sampling: an operator could generate multiple runs and select among them. Have an independent reviewer verify the source data, run selection, seed and audit.

```sh
npm run eval:extract -- --private-dataset=/absolute/private/staging --promote=<run-id>
```

Save an owner-only `audit.json` under the private directory, binding it to the **exact** snapshot hash, manifest hash, and configuration hash printed by the assessment. Each `candidateKey` must refer to a snapshot item. Use a distinct `adjudicatedBy` identifier whenever a reviewer disagrees with the model judge.

```json
{"version":1,"snapshotSha256":"<snapshot SHA-256>","manifestHash":"<manifest SHA-256>","configurationHash":"<configuration SHA-256>","allDisagreementsReviewed":true,"records":[{"candidateKey":"<sample key>","verdict":"supported","levelVerdict":"supported","reviewerId":"reviewer_opaque_01","adjudicatedBy":null}]}
```

This excerpt shows one record; a complete audit has at least the 50 selected unique facts per strategy plus all disagreements. It also needs a `levelVerdict` for every fact with a non-null ownership level that is unmatched or whose matching gold level is null. Review the recorded level against the source, not just the fact text. The candidate key binds the level as well as the quote, so two levels on the same text are distinct. The final assessment makes no model calls:

```sh
npm run eval:extract -- --private-dataset=/absolute/private/staging --promote=<run-id> --audit=audit.json
```

A winner is returned only when the full dataset and audit evidence are present, the current strategy/code/model/price configuration matches the tested configuration, every held-out run is accounted for, scores and verdict counts are independently recomputed from the snapshot, recall is at least 85%, precision is at least 95%, there are zero instruction leaks, unsupported claims and ownership-level inflations against matched labeled facts, failure rate is below 1%, and spend is priced. Level inflation is checked separately because the entailment judge sees fact text and quote, not the level stored with the fact. For unmatched or null-gold facts with a non-null level, promotion requires a separate human-supported level verdict; a missing verdict is pending and an unsupported verdict fails. Aggregate `levelUnverified` and `levelReviewed` counts make this coverage visible. Eligible strategies rank by mean review cost, then mean measured cost and p95 latency; missing data stays pending. The human attestations must be reviewed by an authorized operator before any deployment.

## One-shot initial staging pilot

The authorized initial exploratory pilot is separate from the held-out bake-off. It exercises **one** synthetic development extraction case with one explicitly selected strategy and **one** synthetic tailoring case. It cannot promote an extractor, and it does not replace the complete Round 1 comparison. The current user-authorized ceiling is **$10 and 50 model API attempts combined**. Each suite gets $5; with `llm:default`, extraction gets 12 reserved attempts and tailoring gets the remaining 38. A gateway call reserves six possible upstream attempts, so the previous 25/25 split could not complete two tailoring cases. Schema retries and failed attempts reserve before each request and are not refunded.

Live pilot execution remains **disabled**: the configured staging URL is not yet independently bound to the same account and Durable Object namespace used by the Worker. The real Node adapter refuses its shared reservation before any provider request, and the one-shot script stops before creating its local campaign marker. Do not remove this guard until that identity binding and provider-side cost bounds are verified end to end. A pending reservation left by a crashed process stays charged; it is not automatically frozen.

Once the guard is replaced by verified identity checks, configure the staging account and gateway, choose explicitly either the checked-in synthetic corpus or the private consented dataset described above, set current model prices in `EVAL_MODEL_PRICES` for any configured model not in the checked-in price table, and independently check the provider's current prices and available spend controls. Set `EVAL_PRICE_REVIEW_DATE` to the UTC date of that review. After independently verifying a provider-side billing control no larger than the authorized budget applies to **both** the unified gateway and direct Workers AI REST calls, record the operator attestation using `EVAL_BILLING_GUARD_SCOPE=all-model-paths`, `EVAL_BILLING_GUARD_USD=10` (or its lower actual cap), and `EVAL_BILLING_GUARD_REVIEW_DATE` set to today’s UTC date. The script checks these values but cannot independently verify them; a gateway-only limit is insufficient. The planned one-shot command is:

```sh
node scripts/first-staging-evals.mjs --live --synthetic --strategy=llm:default --budget-usd=10 --max-calls=50
```

For a private-data pilot, replace `--synthetic` with `--private-dataset=/absolute/private/staging`; the two modes are mutually exclusive. Even with a private dataset, the pilot selects one synthetic development case. It uses Node.js 22 or later, including the built-in SQLite API. The pilot validates the staging account and gateway against the staging configuration, the chosen corpus, all potentially used model prices, and the authorized limits before making a provider request. It runs one explicitly selected Vitest file at a time and uses an owner-only transactional ledger under `~/.local/state/resumatic/first-staging-evals-budget.sqlite`. All test workers, schema retries, restarts, and concurrent launches on that host reserve against the same ledger. The fixed campaign marker is never reset automatically, even if a child process crashes, and a second launch fails closed. An interrupted or incomplete run requires reconciliation and a new authorization before another campaign. The ledger and private candidate snapshots contain sensitive operational metadata and must not be committed.

For the default strategy, 12 attempts cover one extraction call and one judge call with the conservative six-attempt reservation. The tailoring allocation covers four chat calls, two embedding calls, and up to 12 reranker calls if no schema retry or repair is needed. Other strategies reserve 15 attempts for Clairic, plus six if the judge add-on is used, leaving the rest for tailoring; a minimum 26 tailoring attempts is required by preflight. A model may return more role sections or requirements, require a schema retry or repair, or incur higher charges than estimated. The pilot can therefore exhaust its allocation and stop incomplete; it is not a guaranteed complete test of all cases.

The REST adapter currently accounts for Workers AI usage from `result.usage`. The published [BGE-M3](https://developers.cloudflare.com/workers-ai/models/bge-m3/) and [reranker](https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/) pages do not establish that field for every REST response. If it is absent or cannot be priced, the shared ledger freezes and the one-shot pilot stops incomplete; it cannot safely be restarted without reconciliation and a new authorization. The offline budget scenario supplies synthetic usage, so its success does not establish the live response shape. Do not override or estimate missing usage to bypass the freeze.

The reservation uses the reviewed model price table, four tokens per UTF-8 byte of the complete serialized payload (including the schema), an additional 4,096 input tokens, the configured output-token maximum, and a multiplier for extraction passes. These are deliberately conservative estimates; provider-added internal prompts or charges can exceed them. Gateway requests explicitly set `cf-aig-max-attempts: 1`, but until its retry semantics are verified each gateway request reserves **six** possible upstream attempts and six times their cost (one initial attempt plus the documented maximum of five retries). Workers AI REST requests bypass the gateway; each client retry reserves separately, and Clairic conservatively counts a potential pass for each requested field. Cloudflare describes its own gateway spend limits as best-effort estimates, and the Workers AI REST calls used by the runner do not pass through that gateway. Neither local reservations nor gateway estimates prove an absolute provider invoice ceiling if pricing, internal attempts, or token accounting differ from those bounds. Verify the applicable provider-side billing controls and prices before running; if an absolute billed-cost ceiling cannot be established, keep the pilot pending. The marker applies on this host only; do not launch the same authorization on another host. Real-format conversion, separate human audit, complete Round 1 comparison, and all launch evidence remain pending after this pilot.
