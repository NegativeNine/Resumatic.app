# Product roadmap

Reconciled on 10 November 2026 from the current PRs and the owner's remaining-work list, and brought up to date on 11 November 2026: the open stack (#25 to #33), the review fixes to it and three of the five Now features landed together in #34, and the last two Now features, the review fixes to those three, tagging in shadow and a batch of hardening fixes landed in #35. On 12 November the unblocked Next work landed together in #36: paste text as a source, the application kit and saved answers, email notices, the owner's card preview with the re-identification harness, the taxonomy vector index with vector candidates in tagging, and the marketplace spec, pilot plan and decision memos. This is the repository copy of the roadmap page on claude.ai.

## Open delivery work

| Work | Status | Next dependency |
| --- | --- | --- |
| Word reading | #24 merged; paragraph-preserving DOCX conversion retained | Continue checking real uploads |
| Muse Ember generation/extraction and Clef decisions | #25 merged in #34; on staging | The live eval: the first pilot cannot start within the 50 weighted attempts authorised against the typed-decision judge (it needs 66). Authorise more, or choose a smaller case |
| Qwen embeddings and Clef relevance | #27 merged in #34; on staging | Keep the task-aware query/document inputs and per-vault embedding migration |
| Coach accounts and client list | #26 merged in #34, with six review fixes | The take-up writes to two vaults and is not atomic; the page offers the add again |
| Taxonomy builder and lookup | #28 merged in #34, with review fixes. Rebuilt from the same downloads on 11 November ([manifest](taxonomy-build-2026-11-11.json), version `esco-1.2.1+onet-31.0+3f810824`) and loaded into a D1 database on the staging account, its counts checked | The index is structurally ready on staging; semantic precision and rollout measurements remain |
| Shared-copy title test | #29 merged in #34 | |
| The record: parts of a line, tags and links | #30 merged in #34 | Its migration comes before coach accounts' |
| Dividing a line into its claims | #31 merged in #34 | Off by default, and kept in shadow where switched on. The focused real-judge smoke refused the bad split; full model evals and quality measurement remain |
| Finding what an upload says again | #32 merged in #34 | Off by default; notes identical roles and facts in shadow with no model, and merges nothing |
| Two wordings of one thing | #33 merged in #34 | Off by default. Focused real-judge controls passed; full evals and quality measurement remain. Unknown reverse judgements now decline the offer |
| Preferences | Merged in #34; review fixes in #35 | Kept in the vault and read only by the owner's form and export. Work authorisation and remote work are not stored |
| Sensitive facts | Merged in #34 | A mark on a fact and its words. Marking a role, and finding sensitive facts for the person, are not built. The embedding model still receives a marked fact's words on an edit or a rebuild |
| Comments on a shared copy | Merged in #34; review fixes in #35 | A page loaded before #35 marks every comment seen until it is reloaded; the old route can go once old pages are gone |
| Suggested wording on a shared copy | Merged in #35 | Adds the vault's next migration, the fourth of four after coach accounts, directly after comments'; only that order is deployed. Accepting is the owner's own verified line edit, so the manual-edit release blocker holds it. Real sign-ins on both sides and the real judge on suggested wording are owed |
| Fit preview through connected apps | Merged in #35. No migration | Deployed before connected apps are switched on anywhere; then MCP in staging and a real client |
| Hardening fixes | Merged in #35 | Denial and intention checks read any apostrophe; "upto" is a bound; cleaning keeps a star or backtick set off by spaces; an expired connected-app grant is cleared on time; direction overrides are stripped from postings. The shadow stamps these change are raised to /3 |
| Tagging facts, parts and roles with taxonomy concepts | Merged in #35; #43 adds verified standalone parts and an ephemeral exact-input job-requirement helper | Off by default, refused in production configuration, and inert without a wholly loaded taxonomy. No vault migration. The full eval against the real judge has not been run; the focused smoke failed its positive C++ case. No quality measurement or model-tag rollout is approved |
| Vector index and vector candidates | Merged in #36. No vault migration; one Directory migration (operator spend), after which production cannot be rolled back past this release | The index is built and structurally verified on staging ([report](taxonomy-index-2026-11-14.json)); vector precision, its floor and caps still need measurement on lines given with consent; the operator-only build switch permits reference indexing while upload tagging stays off |
| Private card preview and re-identification test | Merged in #36. No migration | Off by default, refused in production configuration, needs a wholly loaded taxonomy. No migration. No occupation or skills on real vaults until owner review confirms tags, only a band from job dates. Harness rates are synthetic; Gate 3's real test, counsel and the sharing rules remain |
| Email notices | Merged in #36. The vault's last migration, after saved answers' | Off by default and refused in production. A sender domain onboarded to Cloudflare Email Service, then a real inbox in staging; the DPA naming the service and EU-region sending are owed |
| Paste text as a source | Merged in #36. No migration | Text pasted from real word processors, PDF viewers and browsers checked in staging; the extraction eval has no pasted brag documents or reviews yet |
| Application kit and saved answers | Merged in #36. Adds a vault migration directly after suggested wording's | Matching by the judge is off and refused in production; it has not been run against the real judge. Submission and a queue across jobs are not built |
| Redesign stage 1: the plain identity | `redesign/01-identity`, based on main at 78502c9. No migration | Stage 2 builds on it; server wording and deferred labels move with the room stages (`docs/redesign-words.md`) |
| Redesign stage 2: the shell | `redesign/02-shell`, based on `redesign/01-identity`. No migration | Stages 3–7 build on it, each inside its own marked block, and replace their routes' screens |
| Redesign stage 3: Today | `redesign/03-today`, based on `redesign/02-shell`. No migration | Merges first of stages 3–7 |
| Redesign stage 4: Facts | `redesign/04-facts`, based on `redesign/02-shell`. No migration | To check, All facts, Skills and Your files; the Facts room's server sentences; private in place of sensitive |
| Redesign stage 5: Jobs and a job's page | `redesign/05-jobs`, based on `redesign/02-shell`. No migration | Merges after stage 4; board copy unchecked (question 1) |
| Redesign stage 6: Sharing and Account | `redesign/06-sharing`, based on `redesign/02-shell`. No migration | Merges after stages 4 and 5; consent page, export, share and reminder sentences changed with their tests |
| Redesign stage 7: outside | `redesign/07-outside`, based on `redesign/02-shell`. No migration | Landing copy pending the owner's review |
| Redesign follow-up: one set of states, no dead CSS | `redesign/08-polish`, based on main at d9d2d82. No migration | Owner's answers on a cancelled file's mark (question 1) and the board's quota sentence (question 2) |
| Owner review of identical copies | Merged in #39: an explicit grouping action, separate/rejoin controls, source quotes retained, stale changes refused. No migration | On in staging, off by default behind `IDENTICAL_REVIEW_ENABLED` and refused in production; real-owner usability remains to check. Model parts, tags and semantic offers remain hidden |
| Owner review of model proposals | Merged in #40; reviews existing non-shadow parts, tags and semantic fact offers with stale-decision checks | Off behind `RECORD_PROPOSAL_REVIEW_ENABLED`; never promotes shadow results. Real-model quality and review bars remain |
| Owner-confirmed skill periods | Merged in #46 ([design and limits](skill-years.md)); overlap-aware conservative totals, explicit-only resume selection and full lifecycle support. Vault migration38 follows email notices | Off behind `SKILL_YEARS_ENABLED`, refused in production pending staging verification. Broader policy alternatives remain open; no card years |
| Concept retrieval and private coverage | Merged in #47 ([design and limits](concept-tailoring.md)); keeps embedding candidates, adds bounded concept hints, judges whole requirements and preserves explicit dated skill selections | Off behind `TAILOR_CONCEPTS_ENABLED`; real-model and consented quality evaluation remain. Coverage is excluded from coach, printable and MCP projections |
| Live staging deployment guard | Merged in #42; `deploy:staging` reads and preserves live settings, refuses failed reads/builds/artifact writes or changed bindings | Live guarded deployment verified. Deliberate configuration changes and release acceptance retain their own preflight |
| Download integrity | #44 rechecks resume evidence/privacy after rendering and cache access; #45 checks document evidence/version/session while preserving private owner downloads | Local runtime races and full CI passed. Protected historical source provenance is a separate unfinished protocol |
| Focused real-judge smoke | [14 November results](evals/pipeline-smoke-2026-11-14.json): eight settled Clef requests / 48 weighted attempts. The bad split, equivalent-wording control and stronger-credit refusal passed | Tagging's positive C++ use case failed alongside correctly declined denial/intention cases. Tagging remains off. This does not complete the full evals, Muse proposal testing or consented quality measurements |

The vault migrations after coach accounts are, in order: preferences, sensitive facts, comments, suggested wording (two columns on the comments' table), saved answers and application kits (three tables), email notices (one table), and owner-confirmed skill periods (#46, migration38). Keep that order for deployment. The source-proof prototypes have no registered migration on main.

A merged PR or a local check is not a claim of production release acceptance. The [release status](seeker-release-status.md) records the broader acceptance work.

## Now: still to build

Nothing. All five Now features are merged: preferences, sensitive facts and comments on a shared copy in #34; suggested wording and the fit preview for connected apps in #35, with the review fixes to the first three. What each still owes before release (real sign-ins on both sides, a real MCP client, the real judge) is in the table above and in the [release status](seeker-release-status.md).

## Next: built this round

Everything on the Next list that needed no outside provider and no owner decision is merged in #36. The owner-confirmed interval path for skills is now built in #46, and gated proposal review in #40. Their broader policy and measurement decisions remain open. Provider or decision work still includes job search (a licensed listings provider), sending applications (a way to submit them), live coach access (the threat model), review measurement bars, and who may see the card.

## Taxonomy pipeline work

The [pipeline design](taxonomy-pipelines-design.md) is agreed. The rebuilt taxonomy ([manifest](taxonomy-build-2026-11-11.json)) is loaded on staging, and the vault can hold parts, tags and links ([record.md](record.md)); nothing uses either except the shadow stages below, switched on nowhere.

1. Load the versioned taxonomy into staging (done on 11 November) and build its vector index (the build and vector candidates are merged in #36, in shadow).
2. Add evidence, parts, tags and links without changing existing records. Merged in #34.
3. Evaluate splitting, tagging and duplicate matching in shadow, using consented labelled examples. Splitting ([splitting.md](splitting.md)) and matching ([merging.md](merging.md)) are merged in #34; the focused real-judge smoke has run, but the full suites and consented quality measurements remain outstanding. Tagging of facts and roles is merged in #35 ([tagging.md](tagging.md)); it is switched on nowhere, including staging, where the taxonomy it reads is bound, and failed its positive C++ control in the focused real-judge smoke.
4. Owner review of parts, tags and semantic fact offers is built in #40 behind `RECORD_PROPOSAL_REVIEW_ENABLED`, which stays off. It accepts existing non-shadow proposals only, retains rejected-part history for undo, and never promotes shadow results. Measurement is still required before enabling it.
5. Matching and coverage by concept is merged in #47, retaining evidence checks, the existing embedding candidates and unknown fallback. It remains off pending quality evaluation.
6. Owner-confirmed skill-use intervals and dated totals are merged in #46 and remain off. Role dates never supply skill experience; broader evidence-policy alternatives remain unresolved.
7. Add the private card preview from confirmed tags. Its sharing rules still need an explicit decision. The owner-only preview is merged in #36; publishing is not built.

### 14 November validation

The staging D1 counts were checked again: 49,438 concepts, 207,939 labels and 265,342 relations, with the complete `3f810824` manifest. The bound Vectorize index was initially empty. Its reference-only build is now complete for all 29,981 eligible concepts, with `TAXONOMY_INDEX_BUILD_ENABLED` separate from upload tagging. The [readiness report](taxonomy-index-2026-11-14.json) records the complete manifest, 29,982 stored vectors including the manifest, matching bindings and exact filtered self-match scores of 1.0. Vectorize defaults to approximate scores; #41 requests exact scoring for verification rather than lowering the threshold. Semantic quality remains unmeasured.

The [focused synthetic smoke](pipeline-smoke.md) made real Workers API calls with the production Clef judge. It is deliberately smaller than the full eval suites and cannot approve rollout. The failed positive tagging control is retained in the report rather than counted as a pass from universal refusals. A further paid diagnostic run needs an additional budget; the first run has reserved 48 of its 50 weighted attempts.

Semantic offers now require a settled answer in both directions. A missing, repeated or malformed judge answer means unknown and yields no offer (`entailment/4`). Deterministic check refusals still establish a negative direction. The owner review increment exposes only deterministic identical copies; the model review stages retain their existing measurement gates.

Skills with years and the card preview depend on tagging and belong in this pipeline sequence. Missing or uncertain tags remain unknown; they do not establish missing experience.

The owner agreed the design and its three starting rules on 10 November 2026: qualified lines stay whole; coaches see the original line; only identical wording in a verified identical role merges automatically. They are recorded under "Decided" in the design.

## Decisions waiting

Each memo states the question, what it blocks, the options, a recommendation, what changes once it is decided and who decides.

- [Live read-only access for a coach](decisions/live-coach-access.md)
- [A job listings provider for search](decisions/job-search-provider.md)
- [What counts as years of using a skill](decisions/years-per-skill.md)
- [The bars before parts, tags and offers are shown for review](decisions/review-bars.md)
- [Who may see the private card](decisions/card-sharing.md)

### Delivery and acceptance on 14 November

The local Chrome interface smoke passed with synthetic API stand-ins, and local PDF/Word text checks passed. These are interface and rendering checks, not real Google sign-in, Browser Run, model-quality, independent ATS or beta acceptance. The actual staging service separately passed health, Google redirect, binding preservation and taxonomy-index checks after guarded deployment.

The [source-proof protocol](source-proof-plan.md) remains unfinished. Protected receipt, authority and manifest components are being tested in isolated branches; they are not activated or deployed, and do not remove the manual-edit or deletion-inventory release blockers. Owner inspection and account data export remain distinct from a claim of publication provenance.
