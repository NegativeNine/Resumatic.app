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

Model calls require explicit positive `EVAL_BUDGET_USD` and integer `EVAL_MAX_CALLS`. The Node model adapter reserves a conservative known-price bound before each HTTP attempt, including schema retries. Unknown prices require `EVAL_MODEL_PRICES` with input/output USD per million tokens. `CF_ACCOUNT_ID`, `CF_AI_TOKEN` and `AI_GATEWAY_ID` are also required. Missing configuration produces `pending` and no live calls.

```sh
node scripts/validate-config.mjs --purpose eval --report eval-preflight.json
npm run evals
npm run eval:extract -- --strategy=llm:default,clairic --split=dev --repeat=3
```

Use the extraction CLI's offline mode for harness development; it is not a model-quality result. Keep real consenting-user fixtures outside Git. Promotion reports must name model IDs, prompt hashes, split and repetition count. Held-out promotion results cannot be replaced by development results or hand-picked examples.

`MODEL_TRANSCRIBE` is optional. Configuring a model does not accept its license. For example, the Workers AI Llama vision model requires an operator to accept its terms before its first image request. Keep OCR unavailable until that step and a budgeted image check are complete. Image-derived proposals have weaker evidence and must retain that label.

```sh
node scripts/validate-config.mjs --purpose e2e --report e2e-preflight.json
npm run e2e:staging
node scripts/audit-deletion.mjs --manifest deletion-manifest.json --report deletion-audit.json
```

The staging E2E requires `STAGING_URL`, `TEST_SIGNIN_KEY`, and explicit positive `EVAL_BUDGET_USD` and `EVAL_MAX_CALLS`. Before model calls it freezes those lifetime limits in the synthetic test Vault; the independently configured daily cap also applies. The run fails closed if the test-only budget endpoint is unavailable. The E2E records the Vault run ledger before deletion and distinguishes account access revocation from storage erasure. An upload whose acknowledged R2 put finishes after Vault closure is deleted when the Vault authoritatively rejects completion as gone; ambiguous RPC failures retain the key to protect already-committed sources. This cleanup is best effort: a Worker crash or unknown R2 outcome can leave a late write, so it does not prove quiescence. The audit additionally needs Access service-token credentials. Its Workflow probe checks every supplied ledger ID, including superseded attempts, but cannot independently prove that the captured inventory is complete. Therefore, even all-zero counters remain pending until an independent complete-inventory attestation exists; missing counters, an unavailable endpoint, or an incomplete retention review also remain pending.

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
| Extraction | `trapLeaks: 0`, `unsupportedClaims: 0`, `failureRate < 0.01`, positive `evaluatedUploads`, `factRecall >= 0.85`, `factPrecision >= 0.95` (rates between 0 and 1) |
| Grounding | `unsupportedClaims: 0`, positive `evaluatedLines` |
| Latency | positive `p95Seconds < 90`, positive `sampleSize` |
| Security | `openHighFindings: 0` |
| Beta operations | `quietDays >= 14` |

`ats` evidence also includes `syntheticPdfPassed: true`, `syntheticDocxPassed: true`, `externalParsersTested` (at least two), and `unresolvedFailures: 0`. Run `node scripts/ats-smoke.mjs --pdf synthetic-resume.pdf --docx synthetic-resume.docx --markers synthetic-markers.json --report ats-smoke-report.json` on actual synthetic exports. The markers JSON must contain nonempty `name`, `email`, `employer`, `title`, `accomplishment`, and `skill` strings. The smoke report contains only field names and booleans; it confirms text presence, not accurate reading order or ATS interpretation. Inspect both exports in at least two independent ATS parsers, record their results, and link that report separately before marking the `ats` check passed.

`node scripts/check-release.mjs` validates the evidence envelope; it does not manufacture or independently certify the linked reports. The reviewer must inspect those reports, the sample adequacy and the retention conclusions. Production deployment also rejects a staging test secret and an active maintenance fence.

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
