# Marketplace technical specification

**Status: a specification. None of it is built, and none of it is to be built before the gates under "Preconditions" are met.**

It is the marketplace revision of the technical architecture that the [design review](design-review-2026-11.md) asked for ("What the technical architecture still needs for the marketplace", lines 217 to 227). Product behaviour comes from the [system design](system-design.md) ("Recruiter marketplace" to "Trust, safety and compliance", lines 280 to 505, and the marketplace schemas, lines 688 to 859). This document says how that behaviour fits the seeker product as it is built. Statements about law are questions for counsel, marked **Counsel**. Choices only the owner can make are marked **Owner**. Parts that rest on work being built this round are marked **This round**.

Written on 11 November 2026 against `main` at `3d7c9fe`.

## How this fits what exists

The [technical architecture](technical-architecture.md) describes four Workers, D1, KV, Queues and the Agents SDK. The code that runs is the [v1 codebase plan](v1-codebase-plan.md)'s smaller shape. The marketplace has to fit the code, so where the two differ this document follows the code.

| Topic | Technical architecture | The code | Where |
| --- | --- | --- | --- |
| Workers | Four: `edge`, `vault`, `render`, `control` | One Worker, `resumatic` | `wrangler.jsonc`, `src/worker/index.ts` |
| Control plane | D1 | The `Directory` Durable Object: one global object and sixteen shards, each reached by name | `src/shared/stubs.ts` (`directoryByName`), `src/directory/` |
| The vault | `CareerVault`, an Agents SDK agent with sub-agents | `Vault extends DurableObject`; the Agents SDK is used only for the MCP handler | `src/vault/vault.ts`, `src/worker/mcp.ts` |
| Sessions | JWT access token, refresh token in KV | A signed HttpOnly cookie carrying user, vault, session generation and expiry; the vault checks generation and security epoch on every owner call | `src/worker/session.ts`, `requireOwner` in `src/vault/vault.ts` |
| Async events | An outbox in each vault, Queues to D1 | No queue; the vault's own alarm | `src/vault/vault.ts` (`alarm`) |
| Residency | One namespace per jurisdiction | None. The privacy notice says the beta does not guarantee data stays in a country | `src/web/pages/LegalPage.tsx` (line 101) |
| Rendering | A `render` Worker with a browser pool | Browser Run inside the one Worker | `src/render/pdf.ts` |

Two things follow. The system design's "D1 over workspaces" and "D1 over index shards" (lines 414 and 416) become Durable Object control planes, as the `Directory` is. And EU candidates cannot join until EU residency exists, which the v1 plan defers to "before marketing in the EU" (line 463).

## Preconditions

Nothing below is built until all of these hold. Each is a gate in the system design's delivery phases (lines 1063 to 1067) or a fact about the code today.

| # | Precondition | Today | Evidence |
| --- | --- | --- | --- |
| 1 | **Legal sign-off (Gate 3).** Counsel signs off the consent flows, the US notices and licensing in each launch market, and the marketplace entity that charges only organizations | Not started. Listed as decisions for counsel | Design review, "Decisions that need you or counsel" (lines 46 to 56); system design open questions (lines 1081 to 1084) |
| 2 | **Re-identification test (Gate 3).** Anonymous cards pass a test against an attacker who joins cards to public profiles, holds an employer's internal documents and controls fake accounts | The harness is being built this round, beside the owner-only card preview. **This round** | System design line 1065 |
| 3 | **Paid pilot (Gate 3).** A paid pilot with kill criteria fixed in advance and a loaded cost model, and its result | The plan is [brokered-pilot-plan.md](brokered-pilot-plan.md). Not started | System design lines 308 and 1065 |
| 4 | **Live billing.** Organizations can be charged, and refunds and failed payments are handled | Seeker billing exists and is off: `BILLING_ENABLED` is `"false"` in both environments. Nothing charges an organization. Stripe test flows are pending | `wrangler.jsonc`; `src/shared/billing.ts`; [release status](seeker-release-status.md), "Billing" |
| 5 | **Owner review of tags.** A card is built only from confirmed tags, and nobody can confirm a tag today | Pipeline step 7 is not built | [tagging.md](tagging.md), "What is not built"; [taxonomy-pipelines-design.md](taxonomy-pipelines-design.md), "Order of work" |
| 6 | **Years per skill decided** | Waiting | [decisions/years-per-skill.md](decisions/years-per-skill.md) |
| 7 | **Who may see the card decided** | Waiting | [decisions/card-sharing.md](decisions/card-sharing.md) |
| 8 | **Gate 4** before attestation, verification or any tier carries weight; **Gate 5** and EU residency before EU candidates or EU organizations | Not started | System design lines 1066 and 1067 |

## 1. Context and goals

### Actors

| Actor | Who | Reaches the system through |
| --- | --- | --- |
| Candidate | An existing Resumatic user who opts in | Their own session and vault, as today |
| Recruiter seat | A person at a verified agency | A recruiter session that names organization, seat, seat generation and workspace |
| Organization admin | Manages seats, openings and billing for one organization | The same session, with the admin role |
| Attester | A colleague a candidate names (Gate 4 and later) | A one-time link, then proof of the address |
| Partner app | An ATS, job board or sponsor (later phases) | OAuth, through a separate `partner` unit |
| Broker | Staff arranging introductions by hand during the pilot | Nothing in the product. The pilot adds no staff path into any vault |
| Coach | Unchanged: a copy's named reader | Shared copies, as today (`src/vault/shares.ts`) |
| Operator | Staff running the fleet | Cloudflare Access on `/admin/*`, as today (`src/worker/access.ts`) |

### Outside dependencies

| Dependency | Used for | Phase |
| --- | --- | --- |
| Business registries and domain checks | Verifying organizations: registry ID, domain age, look-alike checks | First launch |
| Stripe | Seats and introduction credits for organizations | First launch; precondition 4 |
| Transactional email | Content-free notices to candidates and seats. The sender and opt-in settings are being built this round. **This round** | First launch |
| ATS vendors | Pushing an accepted disclosure into an agency's ATS | Later |
| Job boards | Partner applications | Later |
| Credential issuers and verifiers | Verified tier | Gate 4 |
| Model providers | Unchanged. Search makes one requirement analysis per opening; vaults call no model for a match report (system design line 358) | First launch |

### Where data lives: three tiers

1. **The vault.** Everything about a person's career stays where it is today. New marketplace tables in the vault hold the candidate's own settings and a record of where their data went.
2. **Published by choice.** A pseudonymous card, built by code from confirmed records, sits in an index shard. It is the only thing a recruiter can find.
3. **Shared on acceptance.** An intro thread holds only what the candidate accepted to share with one organization for one opening, encrypted under the thread's own key.

Organization data (seats, openings, notes, pipeline) lives in the organization's workspace. Control planes hold IDs, states and counts. **No object on the recruiter side holds a vault ID.** Only a shard and a thread know which vault they serve, and neither returns it.

### Quality goals, in order

1. **Nothing beyond the card before acceptance.** Search, match reports and notices learn no more than the card publishes (system design line 350).
2. **No fabrication reaches a recruiter.** Cards and match reports are assembled by code from confirmed records; no model writes them (system design line 287).
3. **People decide.** Nothing is rejected by the system, and protected characteristics never enter ranking (system design line 289).
4. **The seeker product is unaffected.** A marketplace failure never stops tailoring, and marketplace load never wakes a vault more than the search budget allows.

## 2. Deployable units

The seeker Worker stays as it is. The marketplace adds three Workers and a few classes. A new Durable Object class is a lifecycle change and ships alone with `wrangler deploy` (technical architecture line 130; v1 plan line 437).

| Unit | Classes and Workflows | One per | Holds | Why here |
| --- | --- | --- | --- | --- |
| `resumatic` (exists) | `Vault` gains marketplace tables. New: `IntroThread`; at Gate 4, `AttestWorkflow` and `AttesterRegistry` | Thread: one per introduction or application, in the candidate's jurisdiction. Registry: one per jurisdiction | Thread: request, state and deadline, encrypted snapshot and messages, outcomes. Registry: keyed hashes of attester addresses, caps, sealed handles for revocation | Threads hold what candidates share, so they sit with the code that holds career data, as the design review asks ("an `IntroThread` class and Attest Workflows in `vault`") |
| `index` (new) | `IndexShard`; `IndexMap`; `CardCounter` | Shard: a hash range of vaults in one jurisdiction. Map and counter: one per jurisdiction | Cards, tombstones, vault IDs, int8 vectors; the shard map; visible-card counts per description | Every search scans every shard, so shards get their own Worker and isolates (design review, engineering finding 16) |
| `recruit` (new) | `OrgDirectory`; `RecruiterWorkspace`; `ReqSession`; `MarketLedger`; `FairnessAggregator`; `MatchWorkflow` | Directory: sixteen shards by name, as the `Directory`. Workspace: one per organization. Session: one per opening. Ledger and aggregator: one per jurisdiction | Organizations, seats, openings, pipeline, notes, credit holds; billing and abuse metadata; group counts | Recruiter traffic never shares an isolate with seeker traffic |
| `partner` (later) | OAuth endpoints | Partner app | Client records and grants | Later phases only |

**Bindings.** `resumatic` gains a service binding to `index` (named entrypoints, below) and a Durable Object binding for `IntroThread`. `recruit` gains service bindings to `index` and to `resumatic`'s thread entrypoint, and its own `OrgDirectory`, `RecruiterWorkspace`, `ReqSession`, `MarketLedger` and `FairnessAggregator` bindings. No recruiter-side binding reaches `Vault`. Each binding goes through one stub file per Worker, as `src/shared/stubs.ts` is today, so the rule "nothing on the recruiter side builds a vault stub" can be read in one place.

**A switch.** `MARKETPLACE_ENABLED` is off unless exactly `"true"`, is declared in `src/env.d.ts` beside the shadow flags, and is refused in production configuration by `scripts/validate-config.mjs`, as `TAG_SHADOW_ENABLED` is, until the preconditions hold.

**Rendering.** A disclosed resume carries a per-introduction watermark and contact aliases. The render path (`src/render/pdf.ts`, `src/render/template.ts`) gains a watermark parameter. It changes nothing for a seeker's own downloads. A browser pool per jurisdiction, which the design review asks for, waits for EU residency: the code has one Browser Run binding (`wrangler.jsonc`).

**Not used.** Vectorize holds no card (ADR-M2). The Agents SDK is not adopted for the marketplace: the code's vault is a plain Durable Object, and a req session is a named object, not a sub-agent (ADR-M1).

## 3. Interfaces

### Callers and credentials

| Caller | Credential | Checked where |
| --- | --- | --- |
| Candidate | The existing session cookie. The vault comes from the session only (`myVault` in `src/worker/routes.ts`) | The vault, by `requireOwner`, on every call and after every `await` |
| Recruiter seat | A recruiter session cookie of the same construction as `src/worker/session.ts`: organization, seat user, seat generation, workspace, expiry | The workspace, on every call. Suspending a seat raises its generation, which ends every session at once |
| A seat at a thread | A capability the workspace mints for one thread and one seat, valid five minutes (system design line 398) | The thread, on every call |
| Attester | A one-time token in the link's fragment, exchanged for an HttpOnly cookie for one attestation, as a share link is (`shareLink`, `/share/session`) | The candidate's vault, through the Attest Workflow |
| Partner app | Authorization code with PKCE for anything done for a candidate; client credentials only for one organization's own ATS work (system design line 410). The OAuth library is the one connected apps use (`@cloudflare/workers-oauth-provider` in `package.json`) | The candidate's vault for candidate actions; the workspace for ATS work |
| Object to object | A signed capability naming caller, operation and target, with a short expiry. Each class exposes one entrypoint per caller type, so holding a binding is not enough to call a system method (system design lines 422 and 973) | The callee |

Identity is never read from a request body. A recruiter's organization comes from their session, as a seeker's vault does today.

### Calls

These are the system design's calls (lines 429 to 439), with the caller each entrypoint accepts. Every call that names a card re-checks the card's level, regions and blocks for the calling organization. The names are proposals; the card preview being built this round keeps whatever name it ships with.

```ts
/** Vault, called by its own owner through /api/market/* routes. */
interface VaultMarketOwner {
  discoverability(who: Who): Promise<DiscoverabilityView>;
  setDiscoverability(who: Who, patch: DiscoverabilityPatch, expectedRevision: number): Promise<DiscoverabilityView>;
  cardPreview(who: Who): Promise<CardView>;               // built this round, owner-only
  requests(who: Who): Promise<IntroRequestView[]>;
  decide(who: Who, introId: string, choice: IntroChoice, requestKey: string): Promise<void>;
  raiseHand(who: Who, noticeId: string, choices: SharingChoices, requestKey: string): Promise<void>;
  withdraw(who: Who, introId: string): Promise<void>;
}

/** Vault, called only by a shard holding a capability for this vault. */
interface VaultForShard {
  matchReport(cap: Capability, cardId: string, requirements: CanonicalRequirement[]): Promise<MatchReport>;
  notice(cap: Capability, cardId: string, opening: OpeningSummary): Promise<void>;
}

/** Vault, called only by a thread holding a capability for this vault. */
interface VaultForThread {
  deliver(cap: Capability, introId: string, request: IntroRequest): Promise<void>;
  threadState(cap: Capability, introId: string, state: IntroState): Promise<void>;
}

/** IndexShard. */
interface ShardForVault {
  upsertCard(cap: Capability, card: Card, epoch: number, version: number): Promise<void>;
  removeCard(cap: Capability, cardId: string, epoch: number, version: number): Promise<void>; // leaves a tombstone
}
interface ShardForSession {
  search(cap: Capability, org: string, requirements: CanonicalRequirement[], filters: Filters): Promise<ShardResult>;
  matchReports(cap: Capability, org: string, handles: string[], requirements: CanonicalRequirement[]): Promise<MatchReport[]>;
  notify(cap: Capability, org: string, token: string, opening: OpeningSummary): Promise<void>;
  openIntro(cap: Capability, org: string, handle: string, request: IntroRequest): Promise<ThreadRef>; // idempotent by intro ID
}

/** IntroThread. */
interface ThreadForVault {
  decide(cap: Capability, choice: IntroChoice, disclosure?: EncryptedDisclosure): Promise<void>;
  eraseCandidate(cap: Capability): Promise<void>;
  exportForCandidate(cap: Capability): Promise<ThreadExport>;
}
interface ThreadForSeat {
  read(threadCap: ThreadCapability): Promise<ThreadView>;
  message(threadCap: ThreadCapability, body: string, requestKey: string): Promise<void>;
  reportStage(threadCap: ThreadCapability, stage: Stage): Promise<void>;
}

/** RecruiterWorkspace, called by the thread. Capture and release are at-least-once, keyed by intro ID. */
interface WorkspaceForThread {
  capture(cap: Capability, introId: string): Promise<void>;
  release(cap: Capability, introId: string): Promise<void>;
  erased(cap: Capability, introId: string): Promise<void>;
}
```

A match report holds, per requirement, covered, partly covered or not shown; confirmed or self-declared; within five years or older. It never holds a fact's words below the Open level, and a requirement naming an organization, school or person never matches below Open (system design line 358).

### Metadata events

The code has no queue today. The marketplace's billing and abuse counts must survive restarts and arrive at least once, so it adds one: `market-events` (ADR-M11). Each event is a snapshot tagged with the sending object's restore epoch and a sequence number, applied only when newer, as the technical architecture's ADR-07 already decides for seeker events.

| Event | From → to | Payload |
| --- | --- | --- |
| `intro.state` | Thread → `MarketLedger` | Intro ID, organization, state, origin, epoch, sequence |
| `credit.snapshot` | Workspace → `OrgDirectory` | Held, used and released running totals, epoch, sequence |
| `shard.counts` | Shard → `IndexMap` and `CardCounter` | Card counts and description counts, epoch, sequence |
| `placement.reported` | Thread → `MarketLedger` | Intro ID, organization, confirmed by, epoch, sequence |

No event holds a vault ID, a card's content or any career text. Cards, disclosures and ATS pushes never ride the queue; they go by RPC, retried by the sender's alarm (system design line 421).

### Workflow parameters

IDs only, as the existing Workflows carry (`src/workflows/`): `MatchParams { workspaceId, openingId, savedSearchId, runId }` and `AttestParams { vaultId, attestationId, runId }`. Steps return counts.

### Public routes

| Prefix | Side | Notes |
| --- | --- | --- |
| `/api/market/*` | Candidate | Signed-in, under `WRITE_LIMIT` for writes, as every `/api` write is (`src/worker/limits.ts`). Never answers 410 for an ended introduction: 410 under `/api` means the caller's own vault is gone |
| `/recruit/*` | Seats and admins | Own sign-in. Own rate limits per seat and per organization, beside the search budgets |
| `/attest/*` | Attesters (Gate 4) | Anonymous until the token is exchanged; listed in `rateLimitRequest` (`src/worker/limits.ts`) |
| `/partner/*` | Partner apps (later) | OAuth |

### Embedding models

A card's vector is built from canonical skill and occupation IDs, not from prose (system design line 352). Each card records its `embed_model`. A shard scores a query only against cards of the same model, and a query is embedded once for each model present. A model change is a fleet operation: vaults push their cards again under the new model, and until a shard holds no card of the old one, searches score both and keep each card's best result once. This settles the design review's "dual-model scoring" item (engineering finding 18) for cards. Tailoring's own embeddings are unchanged.

## 4. Runtime views

### A search

1. A seat opens or edits an opening in its workspace. The opening's pay range and location freeze at its first search.
2. The `ReqSession` for the opening runs the requirement analysis once. It is the only model call in search, reserved against the organization's budget before dispatch. Requirements become taxonomy IDs and fixed qualification types; proper nouns outside the taxonomy are dropped, so no free text reaches a shard or a vault.
3. The session reads the shard map for each region the organization may hire in, and calls `search` on every active shard.
4. Each shard filters by level, regions, blocks, job type and availability for this organization, scores on IDs and vectors, and returns its top 50 as per-organization handles with raw scores. Notify-level matches come back as opaque tokens.
5. The session merges the results. For the top 25 it asks the shards for match reports. Each shard re-checks visibility and forwards to the vaults it serves. Reports are released together at a fixed deadline, so a slow vault reveals nothing.
6. The seat sees order and coarse tiers, never scores. A shard that did not answer marks the result partial.

Fails closed: a shard or vault that cannot answer leaves a card out or pending; it never widens what a report says.

### An introduction and its credit

1. A seat requests an introduction for a card handle, with a pay range and a plain-text note. The workspace holds one credit and calls `openIntro` through the shard.
2. The shard re-checks the card for this organization and creates the thread in the candidate's jurisdiction, keyed by the intro ID, so a retry finds the same thread.
3. The thread delivers the request to the vault. Work authorisation is checked here, not in search. The vault shows it within the candidate's weekly cap.
4. The candidate opens it, sees the organization, opening and pay range, and can open a fit preview in their own vault. One click starts tailoring for the opening, free and outside plan quotas (system design line 457).
5. The candidate declines, or the seven-day deadline passes: the thread tells the workspace to release the hold. The seat sees "not now" after a random delay of up to 72 hours.
6. The candidate accepts and chooses what to share. The vault seals the snapshot for the thread. The thread asks the workspace to capture the credit and releases the snapshot only after capture succeeds.
7. Capture and release are at-least-once, keyed by intro ID. The workspace never releases a hold on its own clock. A reconciler in the workspace asks the thread about any hold still pending after the deadline.

Fails closed: if capture fails, nothing is disclosed and the request stays accepted but undelivered until capture succeeds or the candidate withdraws.

### An attestation (Gate 4)

1. The candidate picks a fact and names a colleague. The vault starts an `AttestWorkflow` with IDs only.
2. A neutral email with no career content goes out, and the Workflow waits up to 14 days for the answer.
3. The attester proves control of the address and sees every structured field of the fact. They confirm, suggest a correction or cannot confirm.
4. The signed result is stored in the vault bound to a hash of the fact's content. A correction is a proposal; it never changes the fact.

### A shard split

1. `IndexMap` marks the range splitting and creates two shards for its halves.
2. The old shard copies cards and tombstones to the new ones, honouring versions and tombstones, so a hidden card cannot come back.
3. During the copy, searches read both halves and remove duplicates. A push that reaches the wrong shard is refused with the owning shard's handle.
4. `IndexMap` publishes the new map and retires the old shard once both halves report the full count.

## 5. Data

### Tables

The tables are the system design's (lines 688 to 857), with three changes for this code base.

1. **No D1.** The system design's D1 additions move into Durable Object control planes: `organizations`, `agency_clients`, `credit_purchases`, `credit_usage` and `partner_apps` into `OrgDirectory`; `index_shards` into `IndexMap`; `intro_events` and `placements` into `MarketLedger`, one per jurisdiction.
2. **Confirmed versions reuse what exists.** A fact already has a state and a `revision` that every write raises (`src/vault/schema.ts`, the second migration). A card records each fact by ID and revision, so the system design's `fact_confirmations` table is not needed.
3. **Vault tables follow the vault's rules.** `discoverability`, `footprint`, `blocks`, `shareable`, `intros`, `notices` and, at Gate 4, `attestations` and `credentials` are appended as new vault migrations. Each is in the owner's export, in `TRANSFER_TABLES` (`src/shared/operations.ts`) and `TABLES` (`scripts/move-vault.mjs`), and erased with the vault, or has a stated reason in a comment. `self_id` is sensitive and is added only with the fairness work.

### Retention and recovery

| Object | Retention | Recovery |
| --- | --- | --- |
| Vault marketplace tables | Until the candidate deletes them or the account | The vault's own |
| Index shard | A card until hidden, erased or lapsed after 90 days without reconfirmation; tombstones outlast any retry | Point-in-time recovery; failing that, vaults push their cards again |
| Intro thread | Accepted: closes after 12 months without activity. Declined or expired: metadata only, request text deleted after 90 days | A destroyed key can sit in recovery history for up to 30 days |
| Workspace | Until the organization closes | Point-in-time recovery |
| Control planes and ledger | IDs, states and counts; decision records only where a law requires, in a restricted store. **Counsel** sets the periods | Point-in-time recovery |

Retention periods are the system design's (lines 325 and 346). Each is a proposal for counsel to confirm.

### Erasure, export and moving a vault

- **Erasure** is driven by the vault's `footprint` table: a tombstone for its card, `eraseCandidate` on each thread, pending notices withdrawn, and delete calls for ATS pushes. Only when each has confirmed does the vault's own deletion run. Today `destroy()` in `src/vault/vault.ts` calls `ctx.storage.deleteAll()`; the footprint step goes before it, so an interrupted erasure can be run again from what the vault still holds.
- **Export** adds the candidate's settings, card, blocks, notices and threads (through `exportForCandidate`) to the existing export (`exportSnapshot` in `src/vault/vault.ts`).
- **Moving a vault** first tombstones its card and closes its threads; recruiters keep what was already shared, and the candidate turns discoverability on again after the move (system design line 920).

## 6. Security

### Trust boundaries

| Boundary | What crosses | Control |
| --- | --- | --- |
| Internet to `recruit` | Seat requests | Recruiter session; seat generation; per-seat and per-organization limits; organization standing (probation, restricted) |
| `recruit` to `index` | Search, report requests, introductions | Signed capability; the shard re-checks the organization's view of each card |
| `index` to `resumatic` (vault) | Report requests and notices | Signed capability naming the shard and the card; the vault answers only about what its card publishes |
| `resumatic` (thread) to `recruit` | Capture, release, erasure | Signed capability; at-least-once, keyed by intro ID |
| Seat to thread | Reads, messages, stages | A five-minute capability for that thread and seat |
| Anyone to the candidate | Notes, messages, openings | Untrusted text, shown as plain text and never used as evidence. Notes and messages never reach a model prompt. An opening's description reaches one only when the candidate starts tailoring for it, as a posting they paste does: inside tags, as data. Links and images only after acceptance, through an interstitial and a proxy |

### Keys

| Key | Purpose | Held |
| --- | --- | --- |
| Capability signing key | Object-to-object calls | A secret in each Worker; rotated with overlap |
| Recruiter session key | Seat sessions | A secret in `recruit`, separate from `SESSION_KEY` |
| Handle key per organization | Per-organization card handles: an HMAC of the card ID under the organization's key, so handles from two organizations cannot be joined | `OrgDirectory`, sealed |
| Thread key | Encrypts each disclosure, its files and messages; destroyed on withdrawal or closure | The thread, wrapped by a key-encryption secret |
| Attestation signing key | Signs attestation results (Gate 4) | `resumatic` secret |
| ATS tokens | Pushes to an agency's ATS | Encrypted in the workspace |
| Partner OAuth keys | Tokens for partner apps (later phases) | `partner`, with the OAuth library's own key storage, apart from the connected apps' |

New secrets are declared in `src/env.d.ts` and named in the release check of production secret names (`scripts/lib/release-secret-names.mjs`), where `SESSION_KEY` is.

### Threats to add to the threat model

These rows go into a marketplace section of [seeker-threat-model.md](seeker-threat-model.md) when the code is built, each with the test that shows it.

| Threat | Control |
| --- | --- |
| Scraping cards | Budgets per organization and per card; per-organization handles; canary cards; no bulk export |
| Re-identifying an anonymous card | Coarsening to at least 10 visible, trusted cards per whole description; no dates or employer names below Open; a new handle when the level of detail changes. Gate 3 test. **This round** for the harness |
| Probing a vault through reports | Canonical requirements only; answers limited to published attributes; two recency buckets; release at a fixed deadline |
| An employer finding its own staff | Blocks by company family and agencies serving it, checked against the verified hiring company; block-aware anonymity; content-free notices; a personal email before discoverability |
| Pay floor or work authorisation probed | Frozen openings; caps on openings; wide pay bands; work authorisation checked only at delivery |
| A hidden card coming back | Versioned tombstones that outlast retries and survive splits; restores re-apply current consent |
| A suspended seat still reading | Seat generation in the session; five-minute thread capabilities |
| Credit races | The thread as the only authority; capture before disclosure |
| Fake organizations | Registry, domain age, look-alike checks, a payment method or deposit, probation, yearly re-verification |
| Attestation fraud (Gate 4) | Registry-linked domains, per-attester and per-domain caps, ring detection |
| A recruiter's note or message as an instruction | Plain text, never in a prompt or a check, as a coach's comment is today ([seeker-threat-model.md](seeker-threat-model.md), "A comment is read as an instruction or as evidence") |

### Every way out of a vault is gathered

The outward canary (`test/integration/outward.ts`) lists every surface a vault sends to anyone but its owner. The marketplace adds four: the card as a shard holds it, a match report, a notice's reply, and a disclosure. Facts marked sensitive, their quotes and their tags must appear in none of them, decided by the one helper that decides it today (`withheldFacts` in `src/vault/sensitive.ts`).

## 7. Operations

| Objective | Target (proposal) | Measured from |
| --- | --- | --- |
| Search answers | 99.5% of searches answer, partial or whole, within two seconds | `recruit` metrics |
| Credit settlement | Every hold settled within one day of its deadline | Workspace reconciler counts |
| Erasure through the footprint | Complete within 24 hours, as seeker erasure | Vault receipts |
| Seeker product unaffected | Vault latency targets unchanged with the marketplace on | Existing step metrics (`METRICS`) |

**Alerts.** A shard not reporting counts; holds pending past their deadline; organizations whose acceptance rate falls below the floor; hide and complaint rates rising; any canary card returned outside its organization.

**Runbooks.** A lost shard (restore, else have vaults push again); a stuck credit (ask the thread, settle by its word); a reported organization (suspend seats at once by raising their generation, then review).

**Limits to confirm before Phase C.** Isolate memory for a shard's vectors (about 20 MB at 20,000 cards, system design line 441); queue message size for events; and the single writer behind each control plane. The design review raised D1's single writer; here `OrgDirectory`, `IndexMap` and `MarketLedger` are each one Durable Object, with the same limit, so `OrgDirectory` is sharded by name as the `Directory` is and the others are one per jurisdiction. Each limit is to be checked against Cloudflare's current limits pages, not taken from this document.

## 8. Testing and delivery

| Test | What it shows | Layer |
| --- | --- | --- |
| Split chaos | A split interrupted at every step loses no card and revives no hidden one | Integration |
| Credit races | Accept, decline, deadline and withdrawal in every order settle once, and nothing is disclosed before capture | Integration |
| Restore and erasure cascades | Restore re-applies current consent; erasure reaches every footprint entry and can be run again | Integration, and staging for what workerd cannot run locally |
| Re-identification | The Gate 3 attacker cannot single out a card. **This round** for the harness | Script, against synthetic cards |
| Probing | A vault's report says nothing its card does not | Unit and integration |
| Denials | A stranger, a suspended seat, an expired capability and a forged handle each get nothing | Integration, one assertion each |
| Impact ratios | Each group's ratio at each stage stays at or above 0.8 | Fairness aggregator, staging |
| Load | Ten times peak searches against synthetic cards | Staging |

**Deploy order.** Callees before callers: `index`, then `resumatic` (threads and vault tables), then `recruit`, then `partner`. Each new Durable Object class ships alone.

**Phases.**

| Phase | Contents | Gate |
| --- | --- | --- |
| A | The owner-only card preview and the re-identification harness. **This round** | None: nothing leaves the vault |
| B | The brokered pilot. No new code reads a vault | Pilot preconditions ([brokered-pilot-plan.md](brokered-pilot-plan.md)) |
| C | Notify me and Anonymous levels, shards, workspaces, threads and credits, for agencies only | Gate 3 and the pilot passing its kill criteria |
| D | Open level, attestation, verification | Gate 4 |
| E | EU candidates and organizations | Gate 5 and EU residency |

## 9. Architecture decisions

### ADR-M1: Organizations, workspaces, shards and threads

**Context.** The [v1 codebase plan](v1-codebase-plan.md) (line 465) says the marketplace is "a second resource type: an `OrgDirectory` control plane and one `Org` object per recruiting firm, the same pattern applied again", and that "a seeker shares a consented profile out of their vault". The [system design](system-design.md) (lines 392 to 425) has recruiter workspaces with req sessions, index shards, intro threads, and counter, fairness and attester objects, with D1 as the control plane. The two disagree in three ways:

1. The plan has two object kinds; the design has at least five.
2. The plan sends a candidate's profile into the firm's object. The design review rejected that shape: data in a recruiter-side object is not reached by erasure, and search over every candidate needs a shared index (security findings 1 and 3; engineering findings 1 and 2).
3. The design's control plane is D1. The code's is a Durable Object (`src/directory/directory.ts`), and the plan moved it there on purpose (line 15).

**Options.**

| Option | Shape | For | Against |
| --- | --- | --- | --- |
| A. The plan as written | `OrgDirectory` and one `Org` per firm; profiles pushed into each `Org` | Two classes; the same pattern as `Directory` and `Vault` | Personal data copied into every firm that may see it; erasure must chase each copy; no place for a shared index, a thread's credit state or anonymity counts |
| B. The design as written | Workspaces, req sessions, shards, threads and aggregators under D1, with Queues | Settled by the design review | Adds D1 and KV to a code base that has neither, and a second control-plane style beside the `Directory` |
| C. Both, fitted | The plan's pattern for organizations: `OrgDirectory` as a Durable Object control plane, sharded by name like the `Directory`, and one `RecruiterWorkspace` per organization (the plan's `Org`). The design's shards, threads and aggregators as further resources, each with a small Durable Object control plane (`IndexMap`) | One control-plane style across the code; the design review's privacy and erasure fixes kept whole | More classes than the plan; the shard map is read from a Durable Object, not KV |

**Recommendation: C.** It keeps the one rule the plan states, that each resource type has its own control plane reached by name and is never on the data path, and it keeps every object the design review found necessary. The plan's `Org` is the design's workspace, renamed. "A consented profile out of their vault" becomes a card in a shard before acceptance and a disclosure in a thread after it, never a copy in the firm's object.

**Consequences.** `src/shared/stubs.ts` gains the `IntroThread` and `index` stubs that `resumatic` needs. Each new Worker has its own stub file, and none of them can build a vault stub. The v1 plan's "Recruiter marketplace" row is amended to point here. The shard map is cached in each `recruit` isolate and refreshed when a shard refuses a push or a search with a newer map version.

**Status: proposed. Owner.**

### The other decisions

| ID | Decision | Alternatives | Why | Status |
| --- | --- | --- | --- | --- |
| ADR-M2 | Cards live in Durable Object shards, not Vectorize | Vectorize with metadata filters | Blocks, levels and budgets are checked per organization on every call; cards stay in the candidate's jurisdiction; hiding deletes at once | Proposed |
| ADR-M3 | Cards are placed by a hash of the vault ID; a shard splits by halving its range | Placement by occupation or region | One shard owns each vault's one card; a push to the wrong shard is refused with the owner's handle | Proposed |
| ADR-M4 | One thread per relationship | Data in the vault or the workspace | Neither side stores the other's data; erasure and withdrawal have one place to act | Proposed |
| ADR-M5 | The thread is the only authority for an introduction's state and credit | The workspace's clock | One clock; capture before disclosure | Proposed |
| ADR-M6 | Recall in shards, precision in vaults | Everything in shards | Shards never hold more than the card; vaults answer only about published attributes | Proposed |
| ADR-M7 | Coarsening enforced in shards from a per-jurisdiction counter | Counts per shard | A whole-card minimum over visible, trusted cards needs one count | Proposed |
| ADR-M8 | An attester registry per jurisdiction, keyed by a keyed hash of the address | No registry | Caps, ring detection, revocation fan-out, and attesters' own rights | Proposed (Gate 4) |
| ADR-M9 | Fairness counts by randomized response to an aggregator | Per-person records leaving vaults | Counts without per-person data | Proposed |
| ADR-M10 | Control planes are Durable Objects, not D1 | D1, as the system design says | Fits the code; one control-plane style | Proposed |
| ADR-M11 | Marketplace metadata events ride one queue, as snapshots | Pushes by RPC only | At-least-once delivery for billing counts; snapshots make replay safe | Proposed |

**Amendments to the technical architecture's ADRs** (`technical-architecture.md`, lines 506 to 517):

- **ADR-02** (one vault per user): a candidate's marketplace data also lives in their card and their threads, each holding only what the candidate published or shared. The vault stays the only full record.
- **ADR-04** (vector search inside the vault): card vectors, built from IDs, live in shards. Career vectors stay in the vault.
- **ADR-05** (the vault starts every run): the vault starts Attest runs; the workspace starts Match runs, which hold no career data.

## 10. What rests on work being built this round

| This round's work | What here rests on it |
| --- | --- |
| The private card builder and the owner-only card preview | The card a shard holds is that card. Nothing here publishes it; only an owner sees the preview |
| The re-identification harness | The Gate 3 test of anonymous cards |
| Email notices: the sender, content-free notices and opt-in settings | Content-free notices to candidates about requests and notices, and to seats |
| The ESCO and O\*NET credits on the legal pages | The card's occupation and skill names come from the taxonomy |
| The taxonomy vector index | Not the card's vector, which is built from IDs. Vector candidates for tags, which feed confirmed tags only through owner review |

Paste text and the application kit are being built this round too. Nothing here rests on them.

## 11. Questions for counsel

Every one is **Counsel**. None is answered here.

1. Does the marketplace make the platform an employment agency, or need a recruiter licence, in each launch market (New York City and State, Illinois, California, Ontario, British Columbia, the UK, Ireland, and any other market chosen)? Is a separate entity that charges only organizations enough where exemptions hold only if seekers never pay?
2. Is search over discoverable cards outside NYC Local Law 144, and are raised hands and partner applications inside it?
3. Which notices are owed before ranking reaches candidates in New York City, Colorado, California and Illinois, and when?
4. Is the explicit consent at opt-in valid under GDPR Article 22(2)(c), and are human review and a contest route enough?
5. Is an accepted introduction a disclosure the candidate directs, not a sale or sharing under the CCPA, and is the platform not a data broker?
6. Do attested or verified facts make the platform a consumer reporting agency under the FCRA or ICRAA (Gate 4)?
7. What decision records must be kept, for how long, and where (California's automated-decision rules among them)?
8. Is the platform a controller for cards and threads and a processor for workspace data, and is the agency an independent controller of what it receives?
9. Which retention periods in "Retention and recovery" above are lawful and sufficient?
10. May anonymous cards describe employers in general terms?
11. Which EU AI Act provider duties attach to ranking and opening notices used in the EU, and must they be met before EU candidates join (Gate 5)?

## 12. Decisions for the owner

- ADR-M1 and the other proposed decisions above.
- The pilot's niches, markets, sizes, prices and kill criteria ([brokered-pilot-plan.md](brokered-pilot-plan.md)).
- [Years per skill](decisions/years-per-skill.md) and [who may see the card](decisions/card-sharing.md), which the card needs.
- The targets in "Operations", which are proposals.
