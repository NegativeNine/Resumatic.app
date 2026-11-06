# Preserving a start date when the end is unknown

This is a proposed migration, not an enabled feature. Today a role with a start date and a null end means “Present” in the public API and all resume renderers. The extraction verifier and LinkedIn import therefore discard a supported start when the end is unknown. That loses information, but prevents an unknown end from becoming a false claim of current employment. Do not remove that check until the complete compatibility boundary below is implemented and verified.

## Proposed representation

Add an explicit end-status value to persisted roles and resume/share snapshots, distinguishing `current`, `ended`, `unknown`, and `legacy_implicit`. Store the start and end dates independently. New extracted roles may set `current` only when the full source evidence explicitly supports ongoing status; a start by itself yields `unknown`, and a supported end yields `ended`. Continue rejecting ambiguous ranges and inverted dates. LinkedIn rows use the same rule: a missing end is unknown, not current. A seasonal date such as “Summer 2020” may retain the supported year without inventing a month or an end year.

For new manual roles, the form must ask whether the role is ongoing, ended, or the end is unknown, and validate any date/status combination. A legacy write that omits the new field has the old meaning: a start with no end means current. New writes must never infer `current` solely from a null end. Keep user-entered dates as user claims and extracted dates tied to their original evidence.

Add a SQLite migration for the roles table and propagate the field through extraction commits, role reads and edits, generation input snapshots, resume composition and recency sorting, data export, move/restore pages, coach shares, and MCP. Existing rows with a start and no end use `legacy_implicit`, preserving their prior rendering without claiming that their original source explicitly said “Present.” Existing immutable resume and share JSON lacks the field: its reader must apply the legacy interpretation without silently rewriting historical versions. New snapshots must always include the explicit status. Cache keys and versioned exports must preserve the existing bytes for old resume versions and render new versions using their saved status.

## Compatibility and rollout gate

Adding an optional field alone is unsafe: existing web bundles and connected MCP clients interpret `(startDate, null)` as current, even if a new server also sends `unknown`. A stale client could show or export “Present” for an unknown-end role. Old Worker, Workflow, or Vault versions can also read and write the old shape while a new version is deployed. A local schema or UI test cannot prove those versions have drained.

Use an explicit versioned representation or negotiated capability for every consumer of role dates, including `/api/roles`, resume JSON, account export, coach-share snapshots and MCP. Default legacy responses must conservatively hide the start date for new `unknown` records when the legacy representation cannot express it; they must not emit a start/null pair for such records. New clients must verify that the server actually supports the new representation before sending or relying on it. PDF, DOCX and HTML previews are server-rendered and must use the saved status; do not reuse a cached artifact made under a different interpretation.

Deploy readers and conservative legacy projections first. Keep production and extraction from creating start-only `unknown` records until old readers and writers, including in-flight Workflows and rollback paths, are demonstrably fenced. A feature flag alone does not establish that old code or stale browser bundles are absent. Establish and test a provider-backed version/drain and rollback procedure before enabling writes; keep the change disabled if that cannot be proven. MCP is a public integration boundary: document the new schema and make its legacy projection safe for clients that ignore unknown fields.

## Verification needed

- Verify quoted current, dated ended, start-only unknown, end-only, absent, seasonal, ambiguous multi-role, reversed and multilingual cases through every extractor and LinkedIn import. No unknown end may print “Present.”
- Test new and old API/client combinations, including a stale browser, an MCP client that ignores new fields, an older Workflow finishing after deployment, mixed Vault/Worker versions, and rollback. Legacy responses for new unknown records must not imply current employment.
- Migrate old databases with no dates, explicit past dates and old start/null roles. Compare legacy resume/share snapshots, cached PDF/DOCX, export, restore and transfer before and after migration; immutable versions must remain stable.
- Confirm that role edits, confirmed snapshots, generation, chat refinement, shares and both renderers preserve the explicit status. Verify same-version cache behavior, sorting and user corrections.
- Run the extraction promotion set and a real staging lifecycle after the rollout gate is established. The current synthetic harness highlights the loss but does not prove extraction quality or deployed compatibility.
