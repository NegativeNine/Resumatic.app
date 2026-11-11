# Product roadmap

Reconciled on 10 November 2026 from the current PRs and the owner's remaining-work list, and brought up to date on 11 November 2026 when the open stack (#25 to #33), the review fixes to it and three of the five Now features landed together in #34. This is the repository copy of the roadmap page on claude.ai.

## Open delivery work

| Work | Status | Next dependency |
| --- | --- | --- |
| Word reading | #24 merged; paragraph-preserving DOCX conversion retained | Continue checking real uploads |
| Muse Ember generation/extraction and Clef decisions | #25 merged in #34; on staging | The live eval: the first pilot cannot start within the 50 weighted attempts authorised against the typed-decision judge (it needs 66). Authorise more, or choose a smaller case |
| Qwen embeddings and Clef relevance | #27 merged in #34; on staging | Keep the task-aware query/document inputs and per-vault embedding migration |
| Coach accounts and client list | #26 merged in #34, with six review fixes | The take-up writes to two vaults and is not atomic; the page offers the add again |
| Taxonomy builder and lookup | #28 merged in #34, with review fixes. Rebuilt from the same downloads on 11 November ([manifest](taxonomy-build-2026-11-11.json), version `esco-1.2.1+onet-31.0+3f810824`) and loaded into a D1 database on the staging account, its counts checked | A vector index of the concepts |
| Shared-copy title test | #29 merged in #34 | |
| The record: parts of a line, tags and links | #30 merged in #34 | Its migration comes before coach accounts' |
| Dividing a line into its claims | #31 merged in #34 | Off by default, and kept in shadow where switched on. Not run against the real models; nothing has been measured |
| Finding what an upload says again | #32 merged in #34 | Off by default; notes identical roles and facts in shadow with no model, and merges nothing |
| Two wordings of one thing | #33 merged in #34 | Off by default. Not run against the real judge. Which further words belong on the closed list of qualifying words is a starting rule to set once offers are measured |
| Preferences | Merged in #34 | Kept in the vault and read only by the owner's form and export. Work authorisation and remote work are not stored |
| Sensitive facts | Merged in #34 | A mark on a fact and its words. Marking a role, and finding sensitive facts for the person, are not built. The embedding model still receives a marked fact's words on an edit or a rebuild |
| Comments on a shared copy | Merged in #34 | Suggested wording builds on its table |
| Tagging facts and roles with taxonomy concepts | Built and tested on branch `pipeline/05-tag`, based on #34; in review | Off by default, refused in production configuration, and inert without a wholly loaded taxonomy. No vault migration. The eval against the real judge has not been run and nothing has been measured; vector candidates, parts, postings, screens and any use of tags are not built |

The vault migrations after coach accounts are, in order: preferences, sensitive facts, comments. Suggested wording will add the next.

A merged PR or a local check is not a claim of production release acceptance. The [release status](seeker-release-status.md) records the broader acceptance work.

## Now: still to build

- Suggested wording on a shared copy. Designed; builds on comments.
- Fit preview through connected apps. Designed; builds on sensitive facts.

Built and merged in #34: comments on a shared copy; sensitive facts; preferences. A few low-severity review points on preferences and comments are still open: the test that keeps preferences unread does not see a second way into the store from inside the Vault; marking comments seen can mark one that arrived after the list was read; after a copy ends under a coach, the page still says they can comment until it is reloaded.

## Taxonomy pipeline work

The [pipeline design](taxonomy-pipelines-design.md) is agreed. The rebuilt taxonomy ([manifest](taxonomy-build-2026-11-11.json)) is loaded on staging, and the vault can hold parts, tags and links ([record.md](record.md)); nothing uses either except the shadow stages below, switched on nowhere.

1. Load the versioned taxonomy into staging (done on 11 November) and build its vector index (not started).
2. Add evidence, parts, tags and links without changing existing records. Merged in #34.
3. Evaluate splitting, tagging and duplicate matching in shadow, using consented labelled examples. Splitting ([splitting.md](splitting.md)) and matching ([merging.md](merging.md)) are merged in #34; none has been run against the real models. Tagging of facts and roles is built in shadow on branch `pipeline/05-tag` and in review ([tagging.md](tagging.md)); it is switched on nowhere, including staging, where the taxonomy it reads is bound, and has not been run against the real judge.
4. Add owner review of parts, tags and merge proposals.
5. Add matching and coverage by concept, retaining evidence checks and similarity fallback.
6. Add skills with years only where skill-use intervals are evidenced or owner-confirmed; role dates alone are insufficient.
7. Add the private card preview from confirmed tags. Its sharing rules still need an explicit decision.

Skills with years and the card preview depend on tagging and belong in this pipeline sequence. Missing or uncertain tags remain unknown; they do not establish missing experience.

The owner agreed the design and its three starting rules on 10 November 2026: qualified lines stay whole; coaches see the original line; only identical wording in a verified identical role merges automatically. They are recorded under "Decided" in the design.
