# Source evidence proof: implementation and rollout plan

Status: **not implemented**. The Vault schema-version guard is only a rollout
prerequisite. It does not establish source provenance or close the output
paths listed below. Do not claim that the product verifies historical source
provenance until the full protocol and rollout have passed these checks.

The document DOCX route has a narrower saved-evidence guard: it checks the same
captured fact records and deterministic claims used by coach document sharing,
current confirmed fact/role inclusion and withdrawal, and an exact saved-version
fingerprint again before returning bytes. Privacy does not remove the owner’s
right to download their saved letter or preparation; coach delivery still
applies privacy withholding, and unavailable derived claims remain refused.
This closes that route's inspection-to-export bypass;
it does not supply protected source revisions, extraction receipts or an
activation floor, and does not change the status of this plan.

## The gap

Extraction checks a quote against the current converted Markdown when saving
it, but generation snapshots and published versions do not record its source
revision and offsets. Source revisions were not immutable when earlier
evidence was recorded. A matching quote and revision today therefore cannot
prove their historical association. Existing role edits also retain the old
source evidence without recording which fields the owner changed. Shares of
selected facts strip evidence, and document versions do not retain full source
proof. These limitations affect existing data even if the current rows match.

Source-span proof shows correspondence to a particular converted text. It does
not establish that a claim is entailed by the quote, that role fields are
correct, or that conversion preserved the uploaded document. OCR Markdown is a
model transcription and is not proof of what the original image says.
Continue to apply independent claim, role and injection checks; hold OCR
claims under a strict original-source guarantee unless the owner explicitly
re-attests them as user claims.

## Build and ship in order

1. Deploy the forward-schema refusal to every Worker and Durable Object
   instance and drain older writers. Establish an operational rollback floor
   that cannot deploy a binary lacking the guard. Test a forward-version vault
   against the deployed guarded binary. The guard cannot retroactively make an
   already-deployed older binary refuse newer schema versions. Cloudflare's
   Before hardening initialization of an otherwise unrecognized database,
   separately account for application SQL objects, KV data and alarms without
   overwriting any of them. Cloudflare's [SQLite storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
   says the platform-managed `__cf_kv` table can appear in the catalog; local
   workerd exposes `_cf_KV` and the alarm metadata table `_cf_METADATA`. Confirm
   real staging behavior rather than assuming every catalog object is app data.
2. Design the activation floor before adding enforcement. A transient Worker
   environment flag alone is insufficient: toggling it off, mixed deployments,
   replacement and point-in-time restore could bypass the protocol. Use a
   durable monotonic per-Vault activation marker with a compatible deployment
   floor and a restore/replacement fence outside the restored database. Keep
   activation opt-in until all following paths pass. Never lower an activated
   Vault's floor as a rollback shortcut.
3. Add protected source revisions and versioned extraction receipts. Capture
   source identity, revision identity, exact UTF-16 span, quote and item
   incarnation transactionally when newly extracted evidence is accepted.
   Reject invalid or mismatched source IDs, revision IDs, bounds, or slices.
   Protect against update, delete/reinsert and replacement, while preserving
   account destruction and an explicitly designed future source-erasure path.
   Fresh extraction must bind to protected text; don't backfill legacy receipts
   merely from a current match. Source text and proof remain in Vault storage,
   not Workflow results, shared responses, logs or metrics.
4. Capture the exact receipts with generation inputs, not by looking up the
   current IDs later. Validate before exposing inputs to models and again when
   committing a result after asynchronous work. Persist proof with each
   resulting version, including citations used by summary lines, sections,
   skills, and document units. Preserve and validate it through refinement,
   removal and legacy-review/finalization; do not silently turn old versions
   into proven ones. Separate explicitly owner-authored fact and role claims
   from extracted claims. Role edits and re-attestation must be explicit and
   usable in the review UI; old edits cannot be inferred from revision counts.
5. Enforce the same captured proof on every reuse and publication path:
   resume preview, PDF and DOCX; cached exports; cover-letter and interview
   generation and DOCX; coach share creation **and every read**, including
   separately selected facts; MCP fact search and resume reads; and any
   subsequent generation from saved versions. A private grant receipt must not
   expose quotes or source details to a coach. Historical grants and outputs
   without proof remain unavailable for publication until recreated or
   explicitly reviewed. Preserve owner-only inspection and account data export.
6. Extend replacement transfer to carry the protected source records,
   receipts and activation floor in dependency order. Validate the destination
   before activation and preserve its fencing against old writers. Grants are
   already excluded from transfer and must stay unavailable on the replacement.
   Define restore behavior against a floor held outside the restored state;
   a PITR restore cannot silently lower protection. Refuse incompatible or
   incomplete imports rather than reconstructing missing receipts.
7. Add adversarial tests for source/revision mutation and replacement, Unicode
   offsets, cross-source and stale IDs, selected skills and roles, owner edits,
   in-flight workflows, role/fact delete-recreate, consented user claims,
   every output route, grant expiry/revocation, legacy owner access and holds,
   transfer, restore, downgrade and interrupted migrations. Verify that no
   proof or career text enters Workflow results, logs or external responses.
   Run staging end to end and independently audit the coverage before enabling.

The full change is estimated at 10–15 engineer-days, including cross-path tests
and rollout validation; actual duration depends on review UX and deployment
fencing. This is an engineering estimate, not a release commitment.
