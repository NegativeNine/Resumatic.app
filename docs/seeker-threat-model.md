# Job seeker threat model

Scope: accounts with Google sign-in, career uploads and facts, generated outputs, billing, coach snapshots, connected MCP apps, erasure and administrative recovery. This is a repository threat model and test plan; an independent security assessment remains a release requirement.

## Assets and trust boundaries

Career text and original uploads are private to one Vault. The Worker authenticates users and validates requests; the Vault independently checks ownership, session generation, security epoch and open state. The Directory is an identity and administration control plane and is not called by `/api/*` data requests. Model responses, uploaded documents, job descriptions, OAuth client metadata and browser-submitted selections are untrusted inputs.

Model prompts and outputs may cross the configured model-provider boundary. OAuth KV contains encrypted authorization props, client records and bearer-token records; the Vault contains the authoritative local permissions. Stripe holds payment information. Browser Run receives escaped rendering data. Analytics and alert receivers receive metadata only.

| Threat | Control to preserve | Evidence / adversarial check |
| --- | --- | --- |
| Read another account through a guessed ID | Verified session selects Vault; every owner RPC checks owner, generation and epoch | Cross-user route and Vault RPC tests; inspect exports for unauthenticated methods |
| Resume instructions become career facts | Common quote/span verification, claim checks, injection cases, user confirmation | Held-out trap leaks zero; adversarial real-model tests remain required |
| Model writes unsupported claims | Confirmed input snapshots, cited lines, deterministic checks, independent judge, checked fallback | Grounding regression and seeded fabrication catch reports |
| User edit looks model-verified | Exact proposed text is checked against captured confirmed facts by deterministic checks and an independent judge before a new version is saved. Detached historical edits are blocked from rendering and coach sharing; owner history remains available | Verify accepted, rejected, stale and historical edits across exports and shares; validate on real models |
| Upload parser resource exhaustion | Format/size/page limits; bounded archive expansion and Markdown length | Malformed/truncated ZIP/PDF cases and deployed CPU/memory measurements |
| Consent forgery or account switching | Library one-time browser-bound consent plus an account/epoch-bound HMAC cookie; exact Origin on POST | Real-provider protocol integration rejects cross-origin form and invalid state |
| Hostile OAuth client metadata injects HTML | Escape name/domain/redirect host; no remote logo; restrictive consent CSP and no framing | Consent test registers a script-shaped name and verifies escaping |
| MCP token has wrong audience or excessive scope | OAuth resource validation, explicit scope intersection, per-tool local grant gate | Read-only token does not expose generation; scope and client substitution tests |
| Revoked OAuth token still visible through eventual KV | Strongly consistent local grant checked at request and tool time; token refresh also checks local state | Leave token KV intact, revoke local grant, verify access and refresh fail immediately |
| MCP access survives sign-out, deletion or restore | Generation, security epoch, open-state checks; expiry on each call | Change gen/epoch/closed state and verify old claims fail |
| Coach bearer leaks through request URLs | Token in URL fragment, removed before rendering; POST exchange; separate HttpOnly cookie | Token tests verify no query string and purpose isolation; inspect proxy logs in staging |
| Coach receives future edits or private evidence | Owner selects IDs; Vault loads fixed fact snapshots and exact resume versions; explicit field allowlist | Mutate source objects after grant creation; stored snapshot stays unchanged; quotes/private notes absent |
| Revoked/expired coach cookie remains useful | Grant and epoch lookup on every read; expiry independent of alarm; copied content cleared at revoke | Exact expiry boundary and immediate revocation tests |
| Stripe forgery, rotation or replay | Exact-byte HMAC, multiple v1 signatures, timestamp tolerance, durable event/invoice idempotency | Raw-body/UTF-8/multi-signature tests; reordered event test-mode exercise |
| Delinquent subscription grants fresh quota | Current subscription reconciliation plus paid invoice period; no trial entitlement | Paid/unpaid period tests, pending invoice and scheduled-cancel exercise |
| Retry charges or starts generation twice | Durable request keys, run state and per-step attempt/spend records | Concurrent generation, duplicate HTTP request, workflow failure and retry tests |
| Logging or Workflow errors capture career data or credentials | Fixed error codes and reviewed messages at Workflow step boundaries; explicit metadata events; gateway bodies/cache disabled | Inject sensitive synthetic exceptions and inspect step errors; run a deployed canary across Worker, Gateway, Workflow and Logpush outputs |
| Erasure races a running operation | Close first, terminate/reconcile runs, sweep prefixed R2, delete Vault, delayed second sweep | Deletion audit checks SQLite, Directory, R2, OAuth and active Workflow state |
| Restore revives credentials or discarded work | Fence outside restored SQLite; fresh security epoch, revoke grants, preserve live billing/usage, cancel historical work | Staging restore drill before enabling operator restore; no deleted-account restoration |

## Coach and connected-app limits

A coach grant shares a fixed selection for at most seven days, with at most 100 facts, 20 resume versions and one MiB of copied content. Contact fields already printed on a selected resume are included. A recipient can copy what they can read; revocation ends future server access and cannot erase the recipient's copies. Coach access has no write path and never gains access to subsequently created content.

MCP read access exposes confirmed facts and finished resumes, not original files, evidence quotes or private application notes. Generation permission is separately selected and uses the same quota as the web application. The jobs permission is selected separately too: it lists saved jobs (title, company, the start of the posting, link, status and each resume's ID, never notes or the whole posting) and adds a job from its description. A posting a connected app supplies is untrusted input, as a pasted one is. Access without offline permission lasts at most one hour; approved offline access lasts at most thirty days. Every consent is explicit; remembered or silent consent is disabled. A reauthorization creates its own local grant and does not silently extend another grant.

OAuth KV remains eventually consistent. The local gate establishes immediate application revocation; remote credentials are subsequently removed with retryable cleanup. Deletion audit counts both grant and token keys, including orphan tokens. OAuth client registration records are shared application metadata and are not deleted merely because one user disconnects that client. Short-lived consent transactions contain the client authorization request, not the user's career content.

## Before public launch

An external tester should exercise Google account-linking/session boundaries, OAuth CSRF and redirect validation, private-network metadata URLs, share links through real browser navigation, upload expansion limits, billing webhook reordering, and deletion/recovery races. Do not call a local stand-in or an unconfigured service a passing external test. Record findings and fixes against the release commit, and require zero open high-severity findings.

Use synthetic identifying canaries to check every enabled log destination. Confirm platform retention for Workflow state, gateway/Worker logs and recovery history after deletion. The script's `retentionReviewed` field is an explicit operator conclusion; zero live-store counters alone do not settle historical retention.

References: [OAuth provider consent controls](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md), [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [Stripe webhook security](https://docs.stripe.com/webhooks).
