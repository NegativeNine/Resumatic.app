# Job seeker deployment and operations

This runbook covers the Google-only job seeker application. Repository implementation and local tests do not establish that a deployed service, model, payment or deletion audit has passed.

## Configure and provision

Production is the top-level `wrangler.jsonc` configuration. Staging is `env.staging`. Do not deploy production using `--env production`.

```sh
npm ci
npm run typecheck
npm test
node --test scripts/config.test.mjs
npm audit --audit-level=high
node scripts/setup.mjs staging
```

The setup command above prints a local plan. It makes no external request. After reviewing the configured account, bucket and gateway, an operator can use `scripts/setup.sh staging --apply --secrets`. `--apply` creates missing resources and updates the gateway to authenticated access, caching off and logging off. Existing resources are reused. The optional `--secrets` flag requires an interactive terminal and writes Worker secrets; values are never printed by the script. Run the corresponding production command only against the reviewed top-level configuration.

Set the real Google client, Access team/audience, Cloudflare account and gateway identifiers in the selected configuration. Store the session key, Google secret and model access token as Worker secrets. The staging-only `TEST_SIGNIN_KEY` must never exist in production. Verify the Google redirect URL against the deployed origin. The setup script also prints the GitHub environment secret names; Worker secrets and GitHub secrets are separate.

When connected apps are enabled, provision the `OAUTH_KV` namespace. Setup prints its identifier; place that identifier in the selected environment's binding. Configure `APP_ORIGIN` as an exact HTTPS origin, `MCP_ENABLED=true`, and the `global_fetch_strictly_public` compatibility flag. Configure `MCP_ALLOWED_ORIGINS` only for browser clients that need cross-origin MCP access; it is a comma-separated list of exact HTTPS origins. Native clients without an Origin header still work. Keep OAuth storage configured during deletion cleanup even if new connections are disabled.

```sh
node scripts/validate-config.mjs --environment staging --purpose deploy --report config-report.json
```

The preflight reports `ready` or `pending`; readiness is configuration evidence only. Gateway payload headers do not control every logging destination. Inspect gateway logs, Worker logs and any Logpush configuration using synthetic data before allowing real career uploads. Leave body collection and caching disabled. Model recordings must also contain synthetic data only.

Deployment and staging lifecycle preflight require a finite positive `DAILY_SPEND_CAP_USD` in the selected Worker configuration. The committed value is zero, so paid work remains disabled until the operator sets a cap. Bind all four per-Vault Workflows (`DISTILL`, `TAILOR`, `DOCUMENTS`, `REEMBED`). The public production workflow also refuses configured restore fences; maintenance deploys follow the fenced replacement procedure below.

## Billing configuration

Billing stays disabled unless `BILLING_ENABLED=true` and all required values are valid. Provide `APP_ORIGIN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, an explicit `STRIPE_API_VERSION`, and `BILLING_PLANS_JSON`:

```json
{"free":{"generationLimit":3},"paid":[{"id":"pro","priceId":"price_REPLACE","generationLimit":50}]}
```

The numbers are an example deployment configuration, not a pricing decision. Use allowlisted recurring Stripe prices. `generationLimit` covers all generated outputs. There are no trials. An active subscription alone does not grant paid access: a settled invoice must establish the paid period. A scheduled cancellation preserves access through the paid end date; delinquency does not create a new quota period. Configure the Stripe portal for payment details and cancellation. Enable plan switching only after its proration and entitlement behavior has a separate tested policy.

Webhook verification uses the exact request body, all `v1` signatures and a five-minute timestamp window. Reconciliation uses current Stripe state; delivery timestamps do not order subscription events. Duplicate delivery must preserve the settled invoice and quota bucket. Validate checkout, cancellation, duplicate and reordered events in Stripe test mode, then attach evidence from one live payment and cancellation to the release gate.

Checkout keeps a durable server-generated intent and recovers a lost response by its Stripe metadata. Cancel a pending checkout before changing its plan. A confirmed expired session receives a fresh key; a creation with an unknown outcome older than 23 hours requires operator reconciliation and cannot start another payment. Resolve the original Stripe session and customer before clearing any intent. Account deletion expires open checkout sessions, cancels subscriptions and verifies their current state during both deletion sweeps; missing billing credentials or a remote failure keeps deletion pending.

An unknown customer creation older than 23 hours also blocks automatic deletion recovery, because Stripe may have pruned its idempotency key. Locate the original customer in Stripe using `metadata.account_uid`, inspect all matches and resolve any duplicate customers or subscriptions. The Access-protected `POST /admin/vaults/:id/billing/customer` accepts `{ "customerId": "cus_..." }`; the server verifies the customer metadata against the Vault owner before recording it. This repair records one verified association, not proof that other matching Stripe customers were cleaned up. The operator must resolve all duplicates before accepting deletion evidence.

Stripe cleanup cancels future billing and expires pending payment links. It does not erase Stripe customer, invoice or payment records. Retention of those external records, Workflow history, gateway metadata and storage recovery history remains a separate review even after application-store counters reach zero. Keep the deletion acceptance check pending until that review states the applicable retained stores and windows.

## Live model and staging checks

Cloudflare catalog IDs are exact: the defaults use `anthropic/claude-haiku-5.5` and `anthropic/claude-sonnet-5.5`, not the hyphenated provider-native names. See Cloudflare's [Haiku](https://developers.cloudflare.com/ai/models/anthropic/claude-haiku-5.5/), [Sonnet](https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-5.5/) and [catalog lookup](https://developers.cloudflare.com/agents/models/ai-sdk/) documentation. The unified [chat completions endpoint](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) accepts third-party models, but the Claude model pages show the native Messages request format; validate the actual gateway translation and JSON responses in the budgeted staging run. Local tests do not establish interoperability or schema compliance.

The default judge `openai/gpt-5` is scheduled for removal on December 11, 2026, according to [OpenAI's deprecation notice](https://developers.openai.com/api/docs/deprecations/). Choose and evaluate a replacement before that date. OpenAI recommends GPT-5.6 Sol, which [Cloudflare lists as Responses-only](https://developers.cloudflare.com/ai/models/openai/gpt-5.6-sol/), so it needs a Responses-format request rather than the existing Chat Completions format.

The shared model adapter has an **opt-in**, locally tested Responses path for `openai/gpt-5.6-sol`. It sends `store: false` and retains the gateway's payload-log and cache controls. It also requests OpenAI's `prompt_cache_options: { mode: "explicit" }` with no breakpoints to disable the provider's separate implicit prompt cache; [OpenAI documents this opt-out](https://developers.openai.com/api/docs/guides/prompt-caching/). Cloudflare's pass-through of this option has not been verified: confirm it and provider retention before processing career text. It is not the default judge: evaluate its output, failure handling, retention and latency through the configured gateway before selecting it. This model is intentionally absent from the built-in price table: its [Cloudflare pricing](https://developers.cloudflare.com/ai/models/openai/gpt-5.6-sol/) varies by input length and includes a separate cache-write rate, which the two-number table cannot represent exactly. Supply a current, conservative upper-bound override through `MODEL_PRICES_JSON` for the Worker and `EVAL_MODEL_PRICES` for evals, with the existing provider billing controls and daily price review. Local tests do not verify gateway compatibility, provider retention or final invoicing.

Model calls require explicit positive `EVAL_BUDGET_USD` and integer `EVAL_MAX_CALLS`. The Node model adapter reserves a conservative known-price bound before each HTTP attempt, including schema retries. Unknown prices require `EVAL_MODEL_PRICES` with input/output USD per million tokens. `CF_ACCOUNT_ID`, `CF_AI_TOKEN` and `AI_GATEWAY_ID` are also required. Missing configuration produces `pending` and no live calls.

```sh
node scripts/validate-config.mjs --purpose eval --report eval-preflight.json
npm run evals
npm run eval:extract -- --strategy=llm:default,clairic --split=dev --repeat=3
```

Per-format extraction routing is opt-in. `EXTRACTOR_BY_FORMAT` is a JSON object whose optional keys are `pdf`, `docx`, `linkedin`, and `ocr`, and whose values are valid extractor IDs, for example `{"pdf":"clairic","docx":"llm:default"}`. This example is configuration syntax, not a recommendation. An unmapped format uses `EXTRACTOR`; the configured vault-hash experiment still overrides the format default for its challenger cohort. All routes are validated, and a source's chosen strategy is pinned when its upload is committed, including across Workflow retries and later deployment changes. Do not set format routes until the corresponding real-format evaluation has met its promotion gates.

Conversion-quality warnings are heuristics, not a determination that a file was read correctly. Cloudflare's documented Markdown conversion response does not provide a PDF page count, so ordinary PDF page counts remain unknown. OCR sources record the number of page images actually submitted, not a claim about the original PDF's total pages; sparse-text checks can use that known image count. Calibrate the thresholds with the real dataset before relying on them for format-specific decisions.

Use the extraction CLI's offline mode for harness development; it is not a model-quality result. Keep real consenting-user fixtures outside Git. Promotion reports must name model IDs, prompt hashes, split and repetition count. Held-out promotion results cannot be replaced by development results or hand-picked examples.

Extraction retains the full source line for non-skill facts and merges proposals on the same line and role. Skills require a complete item under a same-line or immediately preceding `Skills` or `Technical skills` heading and no detected qualifier on the relevant nearby lines. LinkedIn skills use parser-identified CSV cells. These conservative rules can miss skills in other layouts and merge distinct facts; their English qualifier checks do not prove meaning or cover all languages or multiline context. Measure their effect and audit unsupported claims on the held-out dataset before promotion.

`MODEL_TRANSCRIBE` is optional. Configuring a model does not accept its license. For example, the Workers AI Llama vision model requires an operator to accept its terms before its first image request. Keep OCR unavailable until that step and a budgeted image check are complete. Image-derived proposals have weaker evidence and must retain that label.

```sh
node scripts/validate-config.mjs --purpose e2e --report e2e-preflight.json
npm run e2e:staging
node scripts/audit-deletion.mjs --manifest deletion-manifest.json --report deletion-audit.json
```

The staging E2E requires `STAGING_URL`, `TEST_SIGNIN_KEY`, and explicit positive `EVAL_BUDGET_USD` and `EVAL_MAX_CALLS`. Before model calls it freezes those lifetime limits in the synthetic test Vault; the independently configured daily cap also applies. The run fails closed if the test-only budget endpoint is unavailable. The E2E records the Vault run ledger before deletion and distinguishes account access revocation from storage erasure. An upload whose acknowledged R2 put finishes after Vault closure is deleted when the Vault authoritatively rejects completion as gone; ambiguous RPC failures retain the key to protect already-committed sources. This cleanup is best effort: a Worker crash or unknown R2 outcome can leave a late write, so it does not prove quiescence. The audit additionally needs Access service-token credentials. Its Workflow probe checks every supplied ledger ID, including superseded attempts, but cannot independently prove that the captured inventory is complete. Therefore, even all-zero counters remain pending until an independent complete-inventory attestation exists; missing counters, an unavailable endpoint, or an incomplete retention review also remain pending.

An operator can compare a synthetic E2E manifest with currently visible provider instances using `node scripts/compare-workflow-inventory.mjs --environment staging --manifest deletion-manifest.json --max-instances 250 --report provider-inventory.json`. Configure `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `STAGING_URL`; the configured account and manifest origin must match. Use a narrowly scoped read-only token and do not put credentials in the manifest or command line. This read-only diagnostic lists all visible instances of the four per-vault Workflows and fetches each instance's simple metadata, including its parameters, to attribute instances to the vault. It makes up to one detail request per visible instance and stops at the explicit bound. Provider responses may transiently include other users' data in memory; the report contains only IDs, counts and fixed codes, with no payloads. An unattributed instance, missing ledger ID, unexpected instance or parameter mismatch needs review. Cloudflare's [list](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/list/) and [detail](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/get/) APIs do not establish a complete, quiescent snapshot. Results always remain pending: they do not settle unknown creates, inspect fleet Workflow step state, prove retention expiry or clear any deletion fence. Fleet re-embedding steps can themselves retain vault and run IDs, so include them in the retention and erasure review.

Workflow dispatch is fenced before external creation so closing or moving a vault waits for acknowledged in-flight creates. A rejected or interrupted create has an unknown outcome; a missing or terminal instance observed once does not establish that a delayed create cannot still arrive. For an open vault with a starting run, the alarm can retry creation with the same instance ID at most three times with persisted backoff. Before the first retry it installs a separate permanent uncertainty fence. Neither a successful retry, a duplicate response, nor an acknowledgement from the original call clears that fence. A SQLite trigger also prevents older unconditional cleanup from deleting the original marker while the retry fence exists. These protections require deployed validation; older code may bypass them, so do not rely on mixed-version recovery without proving old instances have drained.

The retry can restore work but does not resolve erasure, move or cancellation. Deletion and maintenance remain pending while any marker exists, and cancellation remains pending even if one lookup reports the instance absent or terminal. The migration conservatively marks every historical Workflow run and legacy source/resume run ID, including terminal runs; affected accounts require a future provider-verified reconciliation procedure before deletion or transfer can finish. No operator override exists today. The application reports an unconfirmed start after 30 seconds while a starting run retains a marker. Initial dispatch schedules an alarm before creation, but an interruption during alarm scheduling can still leave a marker requiring operator attention. Retrying may lead to additional provider processing or model attempts; local attempt reservations enforce configured application spend limits but do not guarantee a provider invoice ceiling or that a model is called only once. Confirm same-ID uniqueness, post-create visibility, billing controls and mixed-version behavior against the live provider before rollout, and keep Workflow inventory and erasure audits pending.

Directory initialization attempts are also fenced before cross-object calls, and account state is rechecked after acknowledgement. A sign-in or replacement preparation can retry initialization for the same persisted vault and owner after an unknown outcome; concurrent attempts share one call. The earlier attempt's marker becomes permanently sticky before a retry, and an acknowledgement from this code does not clear it. A SQLite trigger also prevents an older unconditional delete from removing a sticky marker; it is verified locally and must be tested on the deployed platform. Older code may bypass the fence altogether, so do not rely on recovery across a mixed-version deployment without first proving older instances have drained. This may restore access but deletion or transfer remains blocked until a provider-verified reconciliation procedure exists. The migration conservatively fences **all** existing vaults, replacement targets and retired vaults. Historical orphaned attempts whose Directory rows have already been removed cannot be inventoried by this migration. Any future partial-erasure path also needs a durable checkpoint for a crash between `destroy()` and the Directory's state update; treating an empty vault as closed without that evidence can hide a late initialization. These limits remain release blockers.

Workflow calls must identify an existing run with the correct kind and target. Calls from older in-flight Workflow code that lack this identity, or refer to legacy rows without a run ledger, fail closed even when a previously completed step is replayed. Such interrupted work needs a fresh run after reconciliation; upgrading the Worker alone does not migrate an in-flight execution or resolve its dispatch fence. Preserve old deployments until a staged upgrade and recovery plan has been verified.

## Metrics, alerts and abuse limits

Bind `METRICS` to the selected Analytics Engine dataset and use `METRICS_DATASET` for alert queries. Workflow metrics use `blob1..5` for run ID, step, route, model and outcome; `double1..4` for milliseconds, input tokens, output tokens and integer micro-USD. HTTP metrics use step `http` and a bounded route category. Neither shape contains career text, filenames, IP addresses, raw URLs or credentials.

Completed-run latency uses a separate `run_total` event. The dashboard aggregates end-to-end p50/p95 by run kind and model-attempt p50/p95 by route and model. Alert and cost queries exclude `run_total` so totals do not count model work twice. Unknown cost remains visible instead of being reported as zero. Verify these query shapes against the deployed dataset before accepting latency or spend evidence.

To enable the fifteen-minute alert job, set `ALERTS_ENABLED=true`, `CF_ANALYTICS_TOKEN` with Account Analytics Read, `ALERT_WEBHOOK_URL`, and `ALERT_SPEND_USD_PER_15M`. Optional thresholds are `ALERT_FAILURE_RATE` and `ALERT_HTTP_5XX_RATE` (defaults 0.05), and `ALERT_MIN_ATTEMPTS` (default 20). Unknown model cost raises a separate alert. The webhook receives only window totals and error-category codes. Disabled alerts make no network request. Alerts can repeat while a threshold remains breached; operational acknowledgement belongs in the configured receiver.

Queries weight rows by `_sample_interval`; these are sampled operational measurements, not a billing ledger. Quota and spend reservations in the Vault remain authoritative. The profile, role, and fact reads retry at most twice on transient retryable Durable Object errors, recreating the stub each time; overloaded errors are never retried. The `AUTH_LIMIT` and `WRITE_LIMIT` bindings limit bursts per Cloudflare location. Authenticated writes use the user ID; guest authentication/OAuth requests use an HMAC of the IP address. Shared networks can still hit a guest limit. Missing optional bindings skip burst protection, so configure them before public launch.

## Interview answer provenance

Answers to generated experience questions are saved as confirmed user-authored facts, without consuming an output credit. The vault also retains the originating question and the exact original answer as history. Editing the fact changes the claim used for generation; the original answer remains visible as history and is never used to override the correction. Interview provenance is included in the owner's data export and fenced replacement transfer, excluded from coach shares and MCP tools, and removed with the vault.

## Release evidence

CI runs local type checks, tests, build and dependency auditing. `LIVE_EVALS_ENABLED` and `STAGING_DEPLOY_ENABLED` opt in the respective GitHub jobs. Missing live evidence cannot pass production promotion.

The manual production workflow reads `RELEASE_EVIDENCE_JSON` from the protected production environment. Each required check has `status: "passed"`, the exact candidate commit SHA, and an HTTPS `reportUrl`: `models`, `googleSignin`, `extraction`, `grounding`, `ats`, `stagingE2e`, `billing`, `security`, `deletion`, `latency`, `betaOperations`. Additional measurements are required:

| Check | Required measurements |
| --- | --- |
| Extraction | `trapLeaks: 0`, `unsupportedClaims: 0`, `failureRate < 0.01`, at least 15 held-out `evaluatedUploads`, `factRecall >= 0.85`, `factPrecision >= 0.95` (rates between 0 and 1), and the complete full-corpus `promotion` aggregate described below |
| Grounding | `unsupportedClaims: 0`, positive `evaluatedLines` |
| Latency | positive `p95Seconds < 90`, positive `sampleSize` |
| Security | `openHighFindings: 0` |
| Billing | `testModePassed: true`, `livePaymentPassed: true`, `liveCancellationPassed: true` |
| Beta operations | `quietDays >= 14` |

`ats` evidence also includes `syntheticPdfPassed: true`, `syntheticDocxPassed: true`, `externalParsersTested` (at least two), and `unresolvedFailures: 0`. Run `node scripts/ats-smoke.mjs --pdf synthetic-resume.pdf --docx synthetic-resume.docx --markers synthetic-markers.json --report ats-smoke-report.json` on actual synthetic exports. The markers JSON must contain nonempty `name`, `email`, `employer`, `title`, `accomplishment`, and `skill` strings. The smoke report contains only field names and booleans; it confirms text presence, not accurate reading order or ATS interpretation. Inspect both exports in at least two independent ATS parsers, record their results, and link that report separately before marking the `ats` check passed.

For a local renderer check before staging is available, set `LOCAL_CHROME_BIN` to an absolute path to a compatible Chromium executable and run `npm run check:render-local`. It renders fixed synthetic data through the actual HTML and DOCX templates and checks text in both files, then removes its temporary files. The local browser runs with its sandbox disabled for this fixed synthetic input; do not supply private user data. This is not Browser Run evidence or an ATS parser assessment and cannot satisfy the release gate.

For extraction, copy the complete JSON object returned by the final audited `--promote` assessment into `extraction.promotion`. It must have `mode: "human-audited"`, `profile: "full"`, a winner, no pending ranking, and an eligible winning result with at least 15 held-out cases, 50 distinct audit sample keys, at least 50 reviewed facts and priced usage. The top-level extraction measurements must exactly match that winning result. Supply `extraction.priceOverrides` as the same model-price override object used by the evaluation, or `{}` if none was used. The release check recomputes the configuration hash from the current checkout using the promotion's tested environment and those overrides; it also checks that the production model IDs match the tested IDs and every configured default, format or experiment extractor is an eligible strategy in that assessment. A staging assessment is acceptable when these checks pass. The `full` assessment separately requires a 40-case dataset with at least 20 synthetic and 20 consented real cases, independent labeling, and review of judge/human disagreements. A Round 1 or exploratory pilot report cannot satisfy the release gate.

The standalone strategy assessment measures PDF/DOCX converted text. Its aggregate eligibility does not establish the quality or grounding of LinkedIn import, OCR transcription, or a particular format-specific route. Keep those routes pending until their own end-to-end cases have been evaluated and reviewed; changing their implementation invalidates the configuration hash but a matching hash alone is not route-specific quality evidence.

`node scripts/check-release.mjs` validates the evidence envelope, copied aggregate and checked-in extraction configuration; it does not fetch or authenticate linked reports or independently certify the dataset, price overrides or human attestations. The reviewer must inspect those reports, the actual deployed configuration, sample adequacy and retention conclusions. Before deployment the workflow rejects production secret names that could shadow the checked-in `MODEL_*` or extractor route variables, as well as the staging test secret and an active maintenance fence. It cannot prevent an out-of-band configuration change after that check.

The billing fields are operator attestations and do not independently verify Stripe transactions; the linked report must substantiate the test-mode flow, live payment and cancellation. The deletion audit currently cannot prove its Workflow inventory complete. The release check shares that audit capability and remains pending with `DELETION_INVENTORY_AUDIT_UNAVAILABLE` even if deletion is marked passed. Resolving this requires an implemented, independently verifiable complete-inventory audit and its review, not an environment flag or a manually edited status.

Official references: [OAuth authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Analytics Engine SQL and sampling](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), [Stripe webhooks](https://docs.stripe.com/webhooks).

## Fenced vault replacement

`scripts/move-vault.mjs --source <vault-id> --operation <stable-operation-id>` prepares a replacement and exits pending with both IDs. Deploy `RESTORE_FENCE_IDS` containing both the source and replacement before rerunning the same command with `--copy-and-cutover`. Both requests require `APP_ORIGIN` and Access service-token credentials. The script streams checksum-verified pages directly between the protected endpoints; it does not write career text to local files. The server applies current security, billing and usage checkpoints, copies R2 and then swaps the Directory pointer. Keep the source fenced through its deletion audit and the replacement fenced through verification. A retry uses the same operation ID. There is no direct production SQLite rewind in this workflow; never use an old snapshot to revive revoked credentials or a deleted account.

## Uploads and embedding rebuilds

Upload reservations persist the metadata/body digest and a unique R2 key before writing bytes. Retries recover the same source; conflicting metadata fails before replacing an object. Uncertain writes retain their reservation, and cleanup first permanently expires a pending intent. Validate interrupted upload and deletion races against staging R2 before accepting this as live evidence.

Embedding rebuilds stage vectors per Vault while serving the previous generation, then activate only a complete generation. Fleet dispatch must use stable run IDs, bounded batches and the same model-budget reservations; failures stay resumable. Run a small staging canary and verify generation activation, cancellation and account deletion before starting a fleet rebuild. Rebuilding embeddings is a paid model operation and needs an explicit configured budget.

## Directory capacity rollout

First deploy the home-claim routing code with `DIRECTORY_SHARDS=1`, and retire older Worker versions that lack that protocol. Only then set `DIRECTORY_SHARDS=16`. Existing global user IDs remain global; new shard-prefixed user IDs permanently identify their home. Returning the setting to `1` disables placement of new users into shards; it does not move existing users. Admin listings must still query all seventeen Directory objects after rollback. Do not change the fixed shard count to a different number.

### Extraction experiment feedback

`GET /admin/vaults/:id/extraction-feedback` returns one metadata-only record for each source whose observation began after the feedback migration. It reports the extractor and counts of proposed facts, facts ever confirmed, rejected or edited during the seven days after the source was created, and user-added facts in that period. The confirmation, rejection and edit counts can overlap when a user changes a decision. A manually added fact is attributed once to the most recent observed upload within seven days; this association measures timing, not causation. `windowComplete` identifies sources whose seven-day observation has finished. Existing sources are deliberately not backfilled because their original review timestamps are unknown. The feedback ledger is copied with a fenced vault replacement and erased with the vault.
