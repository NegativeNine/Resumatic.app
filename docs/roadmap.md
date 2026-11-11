# Product roadmap

Reconciled on 10 November 2026 from the current PRs and the owner's remaining-work list. This is the repository copy. The roadmap page on claude.ai was brought into line with it the same day: capability statuses, the order of work, and a new board for what is in review and the taxonomy pipeline.

## Open delivery work

| Work | Status | Next dependency |
| --- | --- | --- |
| Word reading | #24 merged; paragraph-preserving DOCX conversion retained | Continue checking real uploads |
| Muse Ember generation/extraction and Clef decisions | #25 open; deployed to staging | Merge before #28 |
| Qwen embeddings and Clef relevance | #27 open, based on #25; deployed to staging | Keep the task-aware query/document inputs and per-vault embedding migration |
| Coach accounts and client list | #26 open | Review and merge; accounts do not include comments or wording suggestions |
| Taxonomy builder and lookup | #28 open, based on #25 | Real combined build now passes locally after the crosswalk preamble fix; remote D1 loading and vector indexing remain |
| Shared-copy title test | #29 open | Wait for the asynchronous title effect in the test |
| The record: parts of a line, tags and links | #30 open, based on #28 | Nothing writes or reads it yet. It and #26 each add the vault's next migration: whichever merges second is rebased to come after the other, and the two branches are not deployed to one environment before then |
| Dividing a line into its claims | #31 open, based on #30 | Off by default, and kept in shadow where switched on. The eval against the real models needs credentials and has not been run; nothing has been measured |
| Finding what an upload says again | #32 open, based on #31 | Off by default; notes identical roles and facts in shadow with no model, and merges nothing. Offers of different wordings, which need the judge, are not built |
| Two wordings of one thing | #33 open, based on #32 | Off by default; asks the judge about likely pairs and keeps each answer as an offer in shadow. The eval against the real judge needs credentials and has not been run |
| Preferences | #NN open | Kept in the vault and read only by the owner's form and export. Work authorisation is not stored. Adds a vault migration, the first of the four that follow coach accounts (preferences, sensitive facts, comments, suggested wording); only that integrated order is deployed |

An open PR or a local check is not a claim of production release acceptance. The [release status](seeker-release-status.md) records the broader acceptance work.

## Now: still to build

- Comments on a shared copy.
- Suggested wording on a shared copy.
- Fit preview through connected apps.
- Sensitive facts: mark a fact so it is never written into a resume, shared, or shown to an app.
- Preferences: place, job types, availability and a pay floor, kept in the vault. In review as #NN.

The last two were on the roadmap as Now from the start and do not depend on tagging. They were left off the first version of this list by mistake.

## Taxonomy pipeline work

The [pipeline design](taxonomy-pipelines-design.md) is agreed. The real-data build's [manifest](taxonomy-build-2026-11-10.json) is available, and the vault can hold parts, tags and links ([record.md](record.md)); no reading or tailoring pipeline uses either yet.

1. Load the versioned taxonomy into staging and build its vector index.
2. Add evidence, parts, tags and links without changing existing records. In review as #30.
3. Evaluate splitting, tagging and duplicate matching in shadow, using consented labelled examples. Splitting is in review as #31 ([splitting.md](splitting.md)), and matching as #32 and #33 ([merging.md](merging.md)); none has been run against the real models. Tagging is not started and waits for the taxonomy in staging.
4. Add owner review of parts, tags and merge proposals.
5. Add matching and coverage by concept, retaining evidence checks and similarity fallback.
6. Add skills with years only where skill-use intervals are evidenced or owner-confirmed; role dates alone are insufficient.
7. Add the private card preview from confirmed tags. Its sharing rules still need an explicit decision.

Skills with years and the card preview depend on tagging and belong in this pipeline sequence. Missing or uncertain tags remain unknown; they do not establish missing experience.

The owner agreed the design and its three starting rules on 10 November 2026: qualified lines stay whole; coaches see the original line; only identical wording in a verified identical role merges automatically. They are recorded under "Decided" in the design.
