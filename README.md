# Resumatic

An agentic resume builder that tailors a resume to each job description using only experience the user has actually provided. It breaks everything a user uploads into small, source-backed facts, then builds every resume from those facts alone, with a verifier that blocks any claim the facts do not support. An opt-in recruiter marketplace, planned for later phases, lets verified recruiters meet candidates whose experience is backed by evidence.

**Status: job seeker implementation in progress; not release-ready.** The application includes extraction strategies and evaluation tools, immutable resume versions, gap questions, refinement, cover letters, interview preparation, DOCX and LinkedIn import, quotas and billing, coach snapshots, connected apps, live progress, and maintenance operations. See the [release status](docs/seeker-release-status.md), [operations runbook](docs/seeker-operations.md), and [threat model](docs/seeker-threat-model.md). Deletion guarantees, real-service validation, model promotion, latency targets and release approval remain pending. Regional residency and recruiter/marketplace work are outside this implementation.

## Documents

| Document | What it covers |
| --- | --- |
| [Seeker release status](docs/seeker-release-status.md) | Implemented features, local evidence, and live acceptance still required |
| [Seeker operations](docs/seeker-operations.md) | Deployment, budgets, billing, deletion audits, transfers, and operational controls |
| [Seeker threat model](docs/seeker-threat-model.md) | Trust boundaries, controls, and external security checks |
| [v1 codebase plan](docs/v1-codebase-plan.md) | The simplified first release: one Worker, a Directory Durable Object as the control plane and one Vault per user as the data plane, mapped step by step to Cloudflare's control and data plane pattern; repository layout, schemas, pipelines, key flows, configuration, tests and build order |
| [System design](docs/system-design.md) | Product scope, the control-plane and data-plane architecture on Cloudflare, the Career Vault, the Distill and Tailor pipelines, the no-fabrication guarantee, the recruiter marketplace, data model, security, reliability and cost, operations, delivery phases, open questions |
| [Technical architecture](docs/technical-architecture.md) | Deployable Workers and their bindings, interfaces, model input and output contracts, runtime view, data and security architecture, environments, observability, testing, and the architecture decision log. It covers the seeker product; the marketplace additions it still needs are listed in the design review |
| [Design review, November 2026](docs/design-review-2026-11.md) | Validation against Cloudflare documentation and current regulation, an adversarial security and business critique, and what changed as a result |

Diagrams are in [docs/diagrams](docs/diagrams), rendered to SVG from the living documents. The Markdown files here are exports of those living documents, taken on 4 November 2026.

## The design in brief

- **One isolated database per user.** Each user's career data lives in their own Durable Object, the Career Vault, with its own SQLite database. Directory Durable Objects hold accounts, billing and the directory of vaults, and stay outside the request path for career data.
- **Grounded generation.** Employers, titles, dates and degrees are rendered from records by code. Models write only bullet and summary text, every claim must cite stored facts, and deterministic checks plus an independent judge fail closed to the user's own words.
- **Gaps become questions, not content.** A job requirement with no supporting evidence produces a question for the user, never an invented bullet.
- **A consent-first marketplace.** Candidates who opt in appear to verified recruiters as pseudonymous, evidence-backed cards. Recruiters pay when a candidate accepts an introduction; seekers never pay to be seen, and their data is never sold.

## Development

Requires Node 22.

```sh
npm install           # also generates worker-configuration.d.ts with wrangler types
cp .dev.vars.example .dev.vars
npm run dev           # app and API on http://localhost:5173
npm test              # unit tests in Node, integration tests inside workerd
npm run typecheck
```

Local dev needs no Cloudflare login, but uploads and tailoring call Workers AI and AI Gateway, which only run remotely: run `npx wrangler login`, set `CF_ACCOUNT_ID` and `CF_AI_TOKEN` in `.dev.vars`, configure positive model spend limits as described in the operations runbook, and use `npm run dev:remote`. Google sign-in needs `OIDC_CLIENT_ID` (in `wrangler.jsonc`) and `OIDC_CLIENT_SECRET`; without them, sign in with the test route, which `.dev.vars.example` turns on:

```sh
curl -i -X POST http://localhost:5173/auth/test-login -H 'x-test-signin-key: dev-test-key' \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
```

The `.npmrc` sets `legacy-peer-deps`, because npm's resolver currently crashes on this dependency tree's peer set.

## Tests

| Command | What it checks | Needs |
| --- | --- | --- |
| `npm test` | Unit tests (grounding checks, sessions, tokens, the pipelines with stand-in models) in Node; integration tests (routes, sign-in, sessions, the Directory, the Vault, both Workflows end to end, PDF caching, deletion) inside workerd | Nothing |
| `npm run eval:extract` | Offline extraction harness with synthetic fixtures; reports are not eligible for promotion | Nothing; `--live` requires explicit budgets |
| `npm run eval:seeded` | Offline seeded fabrication controls; live mode is budget-gated | Nothing by default |
| `npm run test:scripts` | Deployment and maintenance script behavior without external writes | Nothing |
| `npm run evals` | The no-fabrication evals: resumes and job descriptions with planted traps, run through the real pipeline and models. Any trap in a finished resume fails the run; quality metrics go to `eval-report.json` | `CF_ACCOUNT_ID`, `CF_AI_TOKEN`, `AI_GATEWAY_ID`, explicit eval budget and call cap |
| `npm run e2e:staging` | A deployed staging Worker end to end: test sign-in, upload, Distill, review, Tailor, PDF, export, deletion | `STAGING_URL`, `TEST_SIGNIN_KEY` |

Integration tests reach the Worker, Durable Objects and Workflows in one isolate, so `setModels()` and `setPdfRenderer()` swap in stand-ins, and outbound `fetch` is stubbed for Google and Cloudflare Access. CI runs `npm test` on every push, offline regression checks on every change. Live evaluations and staging deployment require explicit enablement, credentials and spend budgets.

## Staging and production setup

Every push to `main` runs the tests, builds with `CLOUDFLARE_ENV=staging`, deploys the `resumatic-staging` Worker, checks `/api/health` and the app, and runs the end-to-end check. Before the first deploy:

1. Create the bucket: `npx wrangler r2 bucket create resumatic-files-staging`.
2. Create an AI Gateway named `resumatic-staging` (`resumatic` for production) and turn on Unified Billing for the third-party models named in `wrangler.jsonc`.
3. Create a Google OAuth client with the redirect URI `https://<host>/auth/callback`, and put its client ID in `OIDC_CLIENT_ID` and your account ID in `CF_ACCOUNT_ID` in `wrangler.jsonc`.
4. Set the Worker's secrets: `npx wrangler secret put <NAME> --env staging` for `SESSION_KEY` (32 or more random bytes), `OIDC_CLIENT_SECRET`, `CF_AI_TOKEN` (a token with Workers AI Read) and, on staging only, `TEST_SIGNIN_KEY`.
5. Put `/admin/*` behind a Cloudflare Access application and set `ACCESS_TEAM_DOMAIN` (for example `https://<team>.cloudflareaccess.com`) and `ACCESS_AUD` (the application's audience tag). The Worker verifies the Access token itself and refuses admin calls until both are set.
6. In GitHub, add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_AI_TOKEN` and `TEST_SIGNIN_KEY` as secrets of the repository's `staging` environment. The deploy token needs permission to edit Workers and R2.

Until the Cloudflare secrets exist, CI skips the staging deploy and the evals with a warning instead of failing; once they are set, both run and gate as described above.

Sign-up is invite-only while `INVITE_ONLY` is `"true"`: add invites with `POST /admin/invites`, then send the [invite email](docs/beta/invite-email.md). Invitation revocation requires a stable idempotency key and a verified rollout; see the [operations guide](docs/seeker-operations.md). Test sign-ins skip the invite list; they exist only where `TEST_SIGNIN_KEY` is set, which must never include production. Before inviting anyone, make sure the support address in `src/web/config.ts` receives mail, and have counsel review the draft privacy notice and terms.

## Layout

v1 ships as one Worker, as set out in the [v1 codebase plan](docs/v1-codebase-plan.md):

| Part | Owns | Code |
| --- | --- | --- |
| Worker | Static assets, the HTTP API, Google sign-in, session cookies, Access checks | `src/worker/` |
| `Directory` Durable Object | The control plane: identities, users, invites and the directory of vaults; account deletion | `src/directory/` |
| `Vault` Durable Object, one per user | The data plane: a user's profile, sources, quotes, facts, vectors, applications and resumes, and their quota | `src/vault/` |
| `DistillWorkflow`, `TailorWorkflow` | Fact extraction from uploads, and tailoring with fail-closed grounding checks | `src/workflows/`, `src/pipeline/`, `src/grounding/`, `src/ai/` |
| PDF rendering | One ATS-friendly template, rendered with Browser Run and cached per resume version | `src/render/` |
| Web app | React screens for sources and fact review, applications and tailoring, resumes and account | `src/web/` |

The HTTP contract shared by the Worker and the web app is in `src/shared/api.ts`. The technical architecture's four separately deployed Workers (`edge`, `vault`, `render`, `control`) describe the fuller system. The marketplace adds recruiter workspaces, index shards and intro threads (see the system design); the design review lists the Workers and interfaces the technical architecture still needs for it.
