# Design review, validation and adversarial critique

November 2026. Covers the [system design](system-design.md) and the [technical architecture](technical-architecture.md) as exported on 4 November 2026, including the recruiter marketplace added the same week.

This is an engineering review. Statements about law are a reading of current sources, not legal advice; counsel decides at the marketplace gates.

## Verdict

**The seeker product holds up; the marketplace, as first drafted, did not, and has been reworked.**

- **Seeker core: sound, with fixable gaps.** One Durable Object per user, Workflow state that carries only IDs, a writer with no tools, and deterministic checks before an independent judge all survived attack. The gaps were in how evidence enters the vault (gap questions, hidden text in uploads, other people's work in team write-ups), in the fallback that reprints raw quotes, and in rules for equivalent wording. All are fixed in the design.
- **Cloudflare facts: mostly right.** Two claims were wrong (AI Gateway logging changed on 24 September 2026; the rule for gradual deployments of Durable Objects was stated too broadly) and several were stale or depend on beta products. All are corrected, and the remaining platform unknowns are tracked as open questions.
- **Marketplace: the main problems.** Search could learn more about a candidate than their card published, through match reports and a vector built from their own prose. A current employer had several routes to its own staff. Erasure, restore and vault moves never reached the new objects. The platform's own legal status was underestimated: it is likely an employment agency, a provider and deployer under the EU AI Act, and possibly a consumer reporting agency. The design now addresses each of these, but several answers depend on decisions only counsel or the business can make.
- **Business: the biggest remaining risk.** Marketplaces that charged per introduction or per hire have struggled, and recruiters already buy "open to work" signals at scale. The design now gates the marketplace on a paid pilot with kill criteria fixed in advance, and treats the evidence layer as the thing to prove.

## How the review was run

Four reviewers worked independently, each given only the exported documents and a brief, without the author's reasoning:

1. **Cloudflare platform.** Every product claim, limit, price and configuration key checked against Cloudflare's current documentation.
2. **Security, privacy and abuse.** A red team attacking routing, erasure, residency, the grounding pipeline and every marketplace flow.
3. **Regulation and business.** Each legal statement checked against official texts or law-firm analyses, missing regimes identified, and the marketplace's commercial assumptions attacked.
4. **Engineering consistency.** Contradictions within and between the two documents, arithmetic, failure handling, scaling, and schema gaps.

The design's author also made a separate pass. Every finding below was checked by the author before it changed the design; the most consequential new facts (the AI Gateway logging change, Workflows and Browser Run pricing, the Wrangler `exports` field, the Queues coordinator design, the Article 50 grace period and the FTC's Spokeo case) were re-verified against their sources.

Status key: **Fixed** (the design now says what the finding asked, or an equivalent), **Partly fixed** (the main point is addressed; a detail remains), **Decision** (needs the owner or counsel; listed in the design's open questions), **TAD** (waits for the technical architecture's marketplace revision), **No change** (with the reason).

## What changed, in brief

| Area | Change | Where |
| --- | --- | --- |
| Search privacy | Openings become canonical taxonomy IDs before they reach shards or vaults; vaults answer only about attributes their card publishes; per-organization card handles; budgets per organization and card; reports released together at a fixed deadline | Matching |
| Card anonymity | k-anonymity over the whole published card, counted only over cards recruiters can see that carry trust signals; at most 12 canonical skills; card vector built from skill and occupation IDs, not prose; a card that blocks an employer is published only if enough others blocking it share its description | Matching; Consent and introductions |
| Employer discovery | Blocks cover the employer's company family and the agencies serving it, checked against the verified hiring company; personal email before discoverability; content-free notifications; current-role attestations and employment checks off by default | Consent and introductions; Verification tiers; Trust, safety and compliance |
| Erasure, restore, move | A footprint table in the vault drives erasure through shards, threads, notices, ATS pushes and attestation runs, and `deleteAll()` runs last so erasure can always be re-driven; restores save and re-apply current consent under a new epoch from D1; moves import with re-encryption | Contract between the planes; Data model |
| Credits | The thread owns each introduction's state and deadline, the workspace never releases a hold on its own clock, the control plane pushes cumulative grants, and disclosure waits for capture | Consent and introductions; Marketplace architecture |
| Grounding | Evidence must sit inside the user's answer, never the question; a bare "yes" creates no fact; hidden text and PDF metadata never become facts; the actor in a quote must be the user; the quote fallback is used only if it still passes every check; text normalization and span coverage checks; typed equivalences | Distill pipeline; Tailor pipeline; No-fabrication guarantee |
| Sessions and tokens | `onBeforeSubAgent` admits only registered sessions and the granted application; per-connection roles; refresh tokens rotate atomically in the vault with token-family revocation; WebSocket tickets; recruiter seat generations and per-thread capabilities; signed internal calls | Contract between the planes; Security; technical architecture |
| Residency | Tokens bound to the regional hostname; EU email region; error codes only in logs; keyed hashes of vault names in gateway metadata; EU fallback routes that fail closed; EU D1 database for marketplace metadata | Security, privacy and tenant isolation |
| Regulation | AI Act duties attach to output used in the EU, with the full provider list; Article 50 marking from launch; GDPR Article 22 consent at opt-in; LL144 scope corrected and the platform treated as an employment agency; FEHA four-year decision records; licensing, pay transparency and citizenship-discrimination rows added | Trust, safety and compliance |
| Verification and the FCRA | Until counsel decides at Gate 4, attested and verified facts are credentials the candidate holds and shares, with no ranking weight and no fee | Verification tiers; Revenue model |
| Business | Separate marketplace entity charging only organizations; introduction-triggered tailoring free; agencies only, in two or three niches, as a paid pilot with kill criteria; names only after acceptance; disclosures licensed per opening; partners paid per seat or opening, never per candidate; a loaded cost model per jurisdiction | Recruiter marketplace; Revenue model; Delivery phases |
| Costs | Browser Run costed as a pool; Workflow step billing added; AI Gateway log billing and trace billing noted | Reliability, scale and cost |

## Decisions that need you or counsel

These are now open questions in the system design rather than settled choices:

1. **Verification and the FCRA.** Keep attested and verified facts as candidate-held credentials, or run verification as a consumer reporting agency with its duties. Decided at Gate 4.
2. **Employment-agency status and licensing.** Confirm the separate, organization-paid marketplace entity, and get licences or leave out markets: New York State and City, Illinois, California, Ontario, British Columbia, the UK and Ireland.
3. **Pricing.** Whether to add a small request fee, charge at the first conversation rather than at acceptance, and refund withdrawals or silence. The pilot tests these.
4. **EU timing.** Whether ranked search and opening notices reach EU candidates before 2 December 2027, meeting Annex III early, or only after; legacy status should not be relied on.
5. **Article 50 marking.** Whether grounded drafting from the candidate's own facts falls under the assistive-editing exception. Until then, generated files carry machine-readable marking.
6. **Whether to build the marketplace at all.** The pilot's kill criteria are the decision rule; see the business critique below.
7. **Smaller choices.** Generalized employer descriptions on anonymous cards; candidate ownership between agencies and in-house teams; Secrets Store and AI Gateway bring-your-own-key, both in beta, for production keys.

## Cloudflare platform

Claims verified as correct included: Durable Object limits (10 GB per object, 2 MB rows, 1,000 requests per second soft limit, CPU up to five minutes), FTS5, 30-day point-in-time recovery, `deleteAll()` clearing the alarm on current compatibility dates, jurisdictions and `ctx.id.jurisdiction`; the Agents SDK sub-agent API, `routeAgentRequest` with `jurisdiction`, and `runWorkflow`, `waitForApproval` and `approveWorkflow`; Workflows limits (1 MiB step results, creation rates, waiting instances not counted, `waitForEvent` up to 365 days, per-jurisdiction bindings); D1's 10 GB limit, Time Travel and jurisdictions; R2 jurisdictions; Queues' at-least-once delivery and batch limits; the Rate Limiting binding's semantics; `toMarkdown` formats; AI Gateway metadata headers and caching; Browser Run limits; the data-localization coverage of each product; the Wrangler keys in the configuration excerpts; and Durable Object pricing arithmetic.

| # | Finding | Status |
| --- | --- | --- |
| 1 | AI Gateway logging changed on 24 September 2026: gateways created on or after that date log to Workers Logs; the per-gateway cap and automatic deletion apply only to Legacy Logs | Fixed: failure mode, data architecture |
| 2 | Only Durable Object lifecycle changes (new, renamed, deleted, transferred classes) must deploy alone; code changes roll out gradually | Fixed: technical architecture |
| 3 | Agents SDK Workflow callbacks are keyed by class name, so they may not keep a vault's jurisdiction | Fixed as a Gate 2 blocker with a workaround (explicit `getAgentByName` with jurisdiction) |
| 4 | Sub-agent storage lives inside the vault's object; residency, recovery and a shared 10 GB limit are undocumented | Fixed: residency table; open question |
| 5 | Refresh-token rotation on KV is not atomic, and KV is eventually consistent | Fixed: rotation in the vault, KV as cache |
| 6 | Secrets Store and AI Gateway bring-your-own-key are in beta | Fixed: risk and open question |
| 7 | Single-page-application asset handling can swallow API navigations | Fixed: `run_worker_first` |
| 8 | Browser Run bills pooled browsers for open time and for concurrency above 10 | Fixed: cost table, about $0.00065 per run |
| 9 | Workflows now bill per step and for storage (from 10 August 2026) | Fixed: cost table |
| 10 | Wrangler's `migrations` field is legacy; `exports` declares Durable Object classes | Fixed: technical architecture configuration |
| 11 | Location hints inside a jurisdiction are undocumented and may be ignored | Fixed: signup step |
| 12 | Tracing is in beta and billed as observability usage | Fixed |
| 13 | Queues coordinator and shard map in KV, unverified by the reviewer | No change: the author verified the post; the claim is correct |
| 14 | Erasure must delete Workflow instances through the Workflows binding | Fixed: erasure step 2 |
| 15 | The payload header does not govern Logpush | Fixed: Logpush stays off |
| 16 | Nested session routes are gated by `onBeforeSubAgent` | Fixed: hot path |
| 17 | Workflow termination and point-in-time recovery are not available locally | Fixed: erasure tests run in staging |
| 18 | Incognito browser contexts already isolate renders | Fixed: open question narrowed |
| 19 | Cite D1's data-location page rather than the changelog | Fixed |
| 20 | Queues document no ordering guarantee | Fixed |
| 21 | The reranker's English-and-Chinese scope comes from its model card, not Cloudflare | No change: low impact |
| 22 | Workflow creation limit is per second per account | Fixed |
| 23 | The Agents SDK scheduler shares the object's alarm | Fixed |
| 24 | Version affinity needs a header set by a Transform Rule | Fixed |
| 25 | Analytics Engine keeps data three months | Fixed |
| 26 | `fedramp` is listed but not provisioned | Fixed: marked as needing a contract |
| 27 | The residency table omitted Turnstile and Access | Fixed |

## Security, privacy and abuse

| # | Sev. | Finding | Status |
| --- | --- | --- | --- |
| 1 | Critical | Match reports answered free-text probes over the whole vault, including employer and school names, and leaked activity through recency | Fixed: canonical requirements, answers limited to published attributes, budgets, two recency buckets |
| 2 | Critical | Coarsening covered four of about twelve card attributes and counted cards viewers never see; fake accounts could pad counts | Fixed: whole-card minimum over visible, trusted cards; new handle on re-coarsening; Gate 3 attack test |
| 3 | Critical | Erasure and moves left cards, threads, notices and metadata behind | Fixed: footprint-driven erasure, tombstones, `deleteAll()` last |
| 4 | High | Agencies, subsidiaries and confidential searches bypassed the employer block | Fixed: company-family blocks, declared agency clients, verified hiring companies |
| 5 | High | A card vector built from the candidate's own prose was a nearest-neighbor oracle | Fixed: vector from canonical IDs; no scores returned |
| 6 | High | Card IDs were global, stable handles checked only at search time | Fixed: per-organization handles, re-checks on every call, new handle on downgrade |
| 7 | High | Blocks and timing leaked through result differences and response delays | Fixed: block-aware anonymity, fixed-deadline release, delayed declines and alerts |
| 8 | High | Pay floor and work authorization could be probed with many openings | Fixed: frozen openings, caps, wide pay bands, work authorization checked only at delivery |
| 9 | High | Late pushes, splits or restores could bring hidden cards and old consent back | Fixed: versioned tombstones; restores re-apply current consent |
| 10 | High | Grants were not enforced on session sockets | Fixed: `onBeforeSubAgent`, connection roles, grant scopes |
| 11 | High | Recruiter seats could not be revoked at threads | Fixed: seat generations and short-lived per-thread capabilities |
| 12 | High | Attestations, employment checks, work email, corporate sign-in and sponsor reports could tell the employer | Fixed |
| 13 | High | Fairness counts could not be computed without per-person data leaving the vault; tags missed special categories | Fixed: randomized response to an aggregator; extended tags |
| 14 | High | A hostile JD could write evidence through gap questions | Fixed |
| 15 | High | Hidden text, metadata and colleagues' work became usable facts | Fixed |
| 16 | High | Credentials, domains and attester caps could be forged or laundered | Fixed: trusted issuers, registry-linked domains, per-domain caps, ring detection, field-level attestation |
| 17 | High | Partners could act for candidates with app credentials | Fixed: authorization code with PKCE, confirmation in the vault |
| 18 | High | Organization verification was cheap | Fixed: probation, domain age, look-alike checks, deposits, yearly re-verification |
| 19 | High | Quotas per seat did not stop scraping; watermarks do not stop leaks | Fixed: organization and card budgets, canary cards, aliases in every format |
| 20 | Medium | Pooled browsers rendering user content after verification | Fixed: locked-down incognito context; output compared with verified content |
| 21 | Medium | The quote fallback could reprint corrected claims | Fixed |
| 22 | Medium | Deterministic checks missed scope words, unknown entities and judge coverage | Fixed |
| 23 | Medium | Equivalences that change meaning | Fixed: typed equivalences |
| 24 | Medium | Withdrawal and closure did not reach messages, ATS copies or exported credentials | Fixed: encryption under the thread key, retention, delete calls, revocation list |
| 25 | Medium | Attesters had no way to exercise their rights | Fixed: attester registry |
| 26 | Medium | Holding a binding was enough to call system methods | Fixed: per-caller entrypoints, signed capabilities, signed admin calls and prompt sets |
| 27 | Medium | Revocation missed KV refresh, sockets and marketplace objects | Fixed |
| 28 | Medium | EU residency depended on the client's hostname and missed new flows | Fixed |
| 29 | Medium | Free openings and requests allowed crowding and billing games | Fixed: caps, one slot per organization a week, capture before disclosure |
| 30 | Medium | Notes and messages could de-anonymize or phish | Fixed: plain-text notes, interstitials, image proxy |

## Regulation

| # | Finding | Status |
| --- | --- | --- |
| 1 | Article 50(2)'s 2 December 2026 date is only a grace period for systems on the market before 2 August 2026 | Fixed |
| 2 | Article 50(2) has an exception for assistive editing | Fixed: open question |
| 3 | The AI Act provider list was incomplete (quality management, conformity assessment, declaration, CE marking, corrective action, EU representative) | Fixed: table and Gate 5 |
| 4 | Profiling rules out the Article 6(3) exemption; coverage reports shared with recruiters would be candidate evaluations | Fixed: snapshots never include fit previews or coverage reports |
| 5 | AI Act duties follow output used in the EU, not the organization's location | Fixed |
| 6 | Legacy status should not be relied on | Fixed: open question |
| 7 | After SCHUFA, a ranking a recruiter relies on may be an Article 22 decision | Fixed: explicit consent at opt-in, human review, contest |
| 8 | Article 9 applies when special-category data is extracted | Fixed: consent at upload for EU users, or discard |
| 9 | DPIA timing, transfers and an Article 27 representative | Fixed: Gate 2 and table |
| 10 | LL144 covers applicants for a specific NYC job, not sourcing | Fixed |
| 11 | The platform is likely an employment agency under the NYC Human Rights Law | Fixed |
| 12 | LL144 penalties accrue per day; enforcement is tightening | Fixed |
| 13 | Colorado details (human review where commercially reasonable, factual correction only, three-year records, cure period) | Fixed |
| 14 | CCPA risk assessments are needed regardless, because of sensitive data | Fixed |
| 15 | FEHA's rules likely cover the platform and require four years of decision records | Fixed: restricted decision-record store |
| 16 | California's 2026 law on automated decisions about employees | No change: aimed at employees, not candidates |
| 17 | Illinois notice rules were proposed and then postponed | Fixed |
| 18 | The FCRA analysis was wrong: consent is a permissible purpose, not an exemption, and attestations may be investigative consumer reports | Fixed: conservative default and a Gate 4 decision |
| 19 | The CFPB circular discussed by one source was withdrawn in May 2025 | Fixed: source annotated |
| 20 | Years-of-experience bands track age | Fixed: capped bands, qualification-only use, age-impact monitoring |
| 21 | Proxies can sit in the card vector | Fixed |
| 22–25 | Employment-agency licensing in New York, California and Illinois, and federal employment-agency exposure | Fixed: separate organization-paid entity; licences or market exclusion |
| 26 | Citizenship-status discrimination in referral for a fee | Fixed |
| 27 | EU Pay Transparency Directive | Fixed |
| 28–29 | Canada, the UK, Ireland and Italy | Fixed in the licensing row; Italy not yet checked |
| 30 | Texas, new state privacy laws, Washington's health-data law | Fixed |

## Business critique

| # | Objection | Response |
| --- | --- | --- |
| 1 | Comparable marketplaces (Hired, Indeed's Seen, Triplebyte's network) ran the same mechanics with more money and did not survive | Paid pilot with kill criteria before self-serve; the pilot must show that evidence, consent and pay ranges change the outcome |
| 2 | Recruiters already buy "open to work" signals at far larger scale | Decision: position the product as an evidence layer (possibly sold through ATS integrations) rather than another candidate database |
| 3 | Supply skews toward candidates recruiters need least | Launch in two or three niches with enough discoverable candidates; track available cards per occupation and metro |
| 4 | "A fifth of users discoverable" overstates the visible pool | Partly: health measures now track available cards and the spread of requests; the sizing assumption stays, labeled as one |
| 5 | Charging only on acceptance prices the wrong event | Decision: the pilot tests a request fee, a later charge point and refunds |
| 6 | The Open level and ATS pushes invite disintermediation | Fixed: names only after acceptance; disclosures licensed to one opening |
| 7 | Eight demand types collide | Fixed: agencies first; ownership rules before in-house teams; cohorts and revenue share later |
| 8 | "Never sold" conflicts with how money moves | Fixed: partners paid per seat or opening, never per candidate; sponsors see only aggregates |
| 9 | Legal status constrains the paid seeker product | Fixed: separate entity; introduction-triggered tailoring free |
| 10 | Unit economics ignored the fixed costs | Fixed: Gate 3 requires a loaded model and a break-even per seat |

## Engineering consistency

| # | Sev. | Finding | Status |
| --- | --- | --- | --- |
| 1 | Blocker | Erasure never reached marketplace data and could not be re-driven after `deleteAll()` | Fixed; organization and seat removal also defined |
| 2 | Major | The marketplace broke both documents' isolation and placement rules | Fixed in the system design and the technical architecture's goals; ADR amendments are **TAD** |
| 3 | Major | Employer block bypass and pay-floor probing | Fixed |
| 4 | Major | `openIntro` had no way to reach the candidate's vault | Fixed: routed through the shard |
| 5 | Major | Credit holds had two clocks and no failure handling | Fixed |
| 6 | Major | Restore orphaned cards and threads and reused epochs | Fixed |
| 7 | Major | Moving a vault with marketplace objects was undefined; `import` was missing | Fixed: threads are closed rather than repointed |
| 8 | Major | Export omitted marketplace data and had no download route | Fixed |
| 9 | Major | Shard splits could revive hidden cards or loop on stale maps | Fixed |
| 10 | Major | Notice caps were per shard, survived hides, and lacked a raise-hand call | Fixed |
| 11 | Major | Cached results kept showing hidden or blocking candidates | Fixed |
| 12 | Major | Coarsening counts could not work as specified | Fixed: counter object per jurisdiction |
| 13 | Major | Fairness metrics needed an aggregator | Fixed |
| 14 | Major | Attestation rules needed an attester index; plain email hashes are reversible | Fixed |
| 15 | Major | Count heartbeats would overflow queue messages and load D1 | Fixed: counter object, marketplace queue |
| 16 | Major | Shard CPU and memory; isolates are shared per Worker | Fixed: own Worker, contiguous arrays, benchmark before Phase 4 |
| 17 | Major | Sizing omitted saved searches and notices | Fixed |
| 18 | Major | Embedding models can differ across cards, vaults and requests | Partly: `embed_model` recorded; dual-model scoring is **TAD** |
| 19 | Major | Workflow, session and vault interfaces were missing approval and answer paths | Fixed in the technical architecture; download routing is **TAD** |
| 20 | Major | The latency budget left no room for a full repair round | Fixed: repairs target failing bullets only |
| 21 | Major | `edge` could not sign refreshed tokens | Fixed |
| 22 | Major | Vaults had no binding to pull entitlements | Fixed: `edge` attaches signed entitlements |
| 23 | Major | Schema gaps (thread and workspace jurisdictions, reservations, opening JDs, card model and epoch) | Fixed |
| 24 | Minor | Event ordering guards and the event list | Fixed for `grant.changed`; the marketplace event union is **TAD** |
| 25 | Minor | Ranking and explanation claims contradicted how search works | Fixed |
| 26 | Minor | Smaller schema and wording gaps | Partly: `sharing_grants.application_id` and one word for regions remain |
| 27 | Minor | Partner API sign-in could not carry candidate actions | Fixed |
| 28 | Minor | Interface and binding mismatches between the documents | Partly: the `control` R2 binding and the email provider's key are **TAD** |
| 29 | Minor | Residency wording | Fixed |
| 30 | Minor | Cost and phasing inconsistencies | Fixed |

## Author's own findings

1. Requirements naming an employer or school could test where an anonymous candidate worked. Fixed (also covered by security finding 1).
2. Rare skills could single out an anonymous candidate. Fixed.
3. Agencies working for the current employer slipped past the block. Fixed.
4. Domain-verified attestation worked only for current colleagues, whose involvement can reveal a job search. Fixed: former colleagues verify through their own vaults.
5. A restored vault's card could be rejected as stale. Fixed.
6. Erasure and vault moves ignored marketplace objects. Fixed, and extended by the reviewers' findings.

## What the technical architecture still needs for the marketplace

The technical architecture now says it covers the seeker product only. Its marketplace revision needs:

- **Context and goals:** recruiters, attesters and partners as actors; business-registry, verification, credential, ATS, job-board and email services as dependencies; the three-tier data-placement rule.
- **Deployable units:** an `IntroThread` class and Attest Workflows in `vault`; an `index` Worker for `IndexShard`; a `recruit` Worker for `RecruiterWorkspace`, `ReqSession` and Match Workflows; a `partner` Worker with OAuth; new bindings on `edge` and `control`; a watermarking parameter and a browser pool per jurisdiction in `render`; the counter, fairness and attester objects.
- **Interfaces:** a recruiter caller and attester link token; shard, vault-for-shards, thread, workspace and workspace-admin APIs as named in the system design; marketplace events with epoch and sequence; Match and Attest parameters; public routes for both sides; dual-model embedding handling.
- **Runtime views:** a search, an introduction with its credit, an attestation, a shard split.
- **Data, security and operations:** retention and recovery for each new object; trust boundaries and capability checks for object-to-object calls; keys for attestation signing, thread keys, partner OAuth and ATS secrets; threat entries for scraping, re-identification, probing, employer discovery and attestation fraud; SLOs, alerts and runbooks for shards, credits and fraud; limits (isolate memory, queue message size, D1's single writer).
- **Testing and delivery:** split chaos, credit races, restore and erasure cascades, re-identification and probing tests, impact ratios, load at ten times peak; deploy order for the new Workers.
- **ADRs:** cards in Durable Object shards rather than Vectorize; the shard key and split protocol; one thread per relationship; the thread as credit authority; recall in shards and precision in vaults; coarsening enforcement; the attester registry; fairness aggregation; amendments to ADR-02, ADR-04 and ADR-05.

## Sources

Every Cloudflare and regulatory source used by the design is listed in the system design's Sources section. Additional sources the review relied on:

- [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/), [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/), [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [How we built Cloudflare Queues](https://blog.cloudflare.com/how-we-built-cloudflare-queues/) (all checked by the author)
- [Article 50 marking grace period](https://labs.cloudsecurityalliance.org/research/csa-research-note-eu-ai-act-article50-watermarking-deadline/) (Cloud Security Alliance) and [EU AI Act after the Omnibus](https://www.pureglobal.com/news/eu-ai-act-omnibus-high-risk-dates-2028) (checked by the author)
- [FTC settles first FCRA case on selling internet data for employment screening (Spokeo)](https://www.troutman.com/FCRA-FTC-Settles-First-Case-Involving-Sale-of-Internet-and-Social-Media-Data-06-12-2012) (checked by the author)

Sources the business critique cited, not independently checked by the author:

- [Hired raises $40M Series C](https://vator.tv/2016-02-08-hired-raises-40m-series-c-for-tech-talent-marketplace/); [Vettery acquires Hired](https://techcrunch.com/2020/11/23/vettery-acquires-hired/); [Adecco folds Hired into LHH](https://www.staffingindustry.com/news/global-daily-news/adecco-incorporating-hired-lhh-business)
- [Indeed sunsets Seen](https://www.recruitingnewsnetwork.com/posts/indeed-sunsets-seen)
- [220 million LinkedIn members are open to work](https://nbcnewyork.com/news/business/money-report/on-linkedin-220-million-people-are-open-to-work-recruiters-weigh-in-if-the-feature-helps-or-hurts-job-seekers/6119784)
- [LinkedIn Hiring Assistant generally available](https://news.linkedin.com/2025/hiring-assistant-globally-available)
- [Public Triplebyte profiles](https://mjtsai.com/blog/2020/05/26/public-triplebyte-profiles)
- [US staffing industry forecast, September 2026](https://www.staffingindustry.com/research/research-reports/americas/us-staffing-industry-forecast-september-2026-update)
