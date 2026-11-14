# Concept-aware tailoring and coverage

`TAILOR_CONCEPTS_ENABLED=true` opts a new generation into concept retrieval and independent requirement coverage checks. It is off by default, is not enabled by this change, and production configuration refuses it until measured. Without the flag or a wholly loaded taxonomy, the existing embedding/reranker path remains the fallback. No Vault migration is added.

## Inputs and freshness

A new resume or document captures at most 2,048 confirmed, nonshadow tags beside its existing immutable input snapshot. Only already-usable facts are eligible. A part's tag additionally needs a confirmed, nonshadow split and a clause or result on the current parent line. Mention parts are excluded. The captured hint records the tag's decision stamp and taxonomy version, the original fact's words/revision, and the part's split identity, ranges and words.

Before each model reservation and before committing output, the Vault rechecks every captured fact through the publication evidence/incarnation guard and rechecks captured tag and split decisions. A deleted or rejected tag, changed split, edited source fact or newly private source stops the run. This does not establish historical source provenance, which remains subject to the separate source-proof plan.

The requirement helper keeps each original requirement's exact ID, text and order, including explicit unknown entries for declined, capped or failed lookups. These are hints about the posting, never claims about the applicant. Only hints and fact tags stamped with the same loaded taxonomy version participate in concept matching.

## Selection and coverage

For every requirement, normal embedding retrieval still contributes up to eight deduplicated candidates. Up to four additional candidates may come from exact concepts or direct parent/child links; at most 12 candidates are reranked. A hierarchy link is only a reason to retrieve a fact and never evidence that the applicant meets a requirement.

Coverage checks the **entire original requirement against whole-line evidence**, first with the existing deterministic claim checks and then the configured judge. Parts never become new quote records or replace the writer's fact IDs. A tag alone does not establish level, scope, duration or any other requirement. In particular, role start/end dates never provide years of skill use.

At most 240 coverage questions are asked for one selection. Missing, duplicate or malformed answers and questions beyond the cap remain unknown. If no supporting fact is found among completed checks, the private explanation says exactly that; it never says the person lacks experience. A missing requirement tag still runs embedding retrieval and independent evidence checks, and its concept mapping remains unknown even where a fallback fact supports the requirement.

The writer, deterministic checks, repair and final resume judge continue using the original captured facts and citations. Concept matches do not bypass them.

## Where explanations go

The versioned requirement decisions and coverage are stored privately with selection/document plans and finished owner views. The resume sidebar and owner's Fit preview show the source facts and distinguish supported, unknown and no supporting fact found. Historical versions retain their own explanations.

Taxonomy breadcrumbs are not added to printable `ResumeReport`, coach copies, MCP resume answers or connected-app fit answers. Those paths continue their explicit projections of original wording and permitted fact IDs. This does not decide who may see private-card or taxonomy data elsewhere.

## Verification still owed

Local regression tests exercise actual resume and fit Workflows, confirmed-part hints, default-off/shadow isolation, outward projections and stale decisions. Synthetic tests cannot establish model precision or recall. The isolated real-judge smoke already showed that the generic judge can decline a valid positive tagging control; no live model comparison or coverage-quality claim is made here. Keep the feature off until the relevant consented labelled evaluation and rollout checks pass.
