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

## Run and audit

An offline, no-model dry run validates the corpus and exercises scoring:

```sh
npm run eval:extract -- --private-dataset=/absolute/private/staging --split=dev
```

A live run requires configured model credentials and explicit, positive `EVAL_BUDGET_USD` and integer `EVAL_MAX_CALLS`. Price overrides in `EVAL_MODEL_PRICES` must be the same when later assessing promotion. Explicitly authorize the provider calls and use a held-out split for promotion:

```sh
npm run eval:extract -- --live --private-dataset=/absolute/private/staging --strategy=llm:default,clairic --split=holdout --repeat=3
```

The public `extract-report.json` is metadata only and includes the run ID and the SHA-256 of a private snapshot in `evaluation-snapshots/<run-id>.json`. That owner-only snapshot contains sensitive proposed text and evidence for human review; do not commit or publish it. An offline assessment with no audit reports pending status and a deterministic `sampleSeed` and list of 50 `sampleKeys` per strategy, derived from the manifest hash, tested configuration and candidate keys. Look up those keys in the private snapshot; reviewers must examine those samples, examine every judge/human disagreement, and adjudicate disagreements. Do not cherry-pick a different 50. This reproducibility does not by itself establish impartial sampling: have an independent reviewer verify the source data, seed and audit.

```sh
npm run eval:extract -- --private-dataset=/absolute/private/staging --promote=<run-id>
```

Save an owner-only `audit.json` under the private directory, binding it to the **exact** snapshot hash, manifest hash, and configuration hash printed by the assessment. Each `candidateKey` must refer to a snapshot item. Use a distinct `adjudicatedBy` identifier whenever a reviewer disagrees with the model judge.

```json
{"version":1,"snapshotSha256":"<snapshot SHA-256>","manifestHash":"<manifest SHA-256>","configurationHash":"<configuration SHA-256>","allDisagreementsReviewed":true,"records":[{"candidateKey":"<sample key>","verdict":"supported","reviewerId":"reviewer_opaque_01","adjudicatedBy":null}]}
```

This excerpt shows one record; a complete audit has at least the 50 selected unique facts per strategy plus all disagreements. The final assessment makes no model calls:

```sh
npm run eval:extract -- --private-dataset=/absolute/private/staging --promote=<run-id> --audit=audit.json
```

A winner is returned only when the full dataset and audit evidence are present, the current strategy/code/model/price configuration matches the tested configuration, every held-out run is accounted for, scores and verdict counts are independently recomputed from the snapshot, recall is at least 85%, precision is at least 95%, there are zero instruction leaks and unsupported claims, failure rate is below 1%, and spend is priced. Eligible strategies rank by mean review cost, then mean measured cost and p95 latency; missing data stays pending. The human attestations must be reviewed by an authorized operator before any deployment.
