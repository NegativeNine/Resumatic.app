# Resumatic

An agentic resume builder that tailors a resume to each job description using only experience the user has actually provided. It breaks everything a user uploads into small, source-backed facts, then builds every resume from those facts alone, with a verifier that blocks any claim the facts do not support. An opt-in recruiter marketplace, planned for later phases, lets verified recruiters meet candidates whose experience is backed by evidence.

**Status: design.** This repository holds the design documents. Code arrives with Phase 1 of the delivery plan. The November 2026 review found the seeker product sound and reworked the marketplace; the marketplace's biggest remaining risks are commercial and legal, so it is gated on a paid pilot and on decisions by counsel.

## Documents

| Document | What it covers |
| --- | --- |
| [System design](docs/system-design.md) | Product scope, the control-plane and data-plane architecture on Cloudflare, the Career Vault, the Distill and Tailor pipelines, the no-fabrication guarantee, the recruiter marketplace, data model, security, reliability and cost, operations, delivery phases, open questions |
| [Technical architecture](docs/technical-architecture.md) | Deployable Workers and their bindings, interfaces, model input and output contracts, runtime view, data and security architecture, environments, observability, testing, and the architecture decision log. It covers the seeker product; the marketplace additions it still needs are listed in the design review |
| [Design review, November 2026](docs/design-review-2026-11.md) | Validation against Cloudflare documentation and current regulation, an adversarial security and business critique, and what changed as a result |

Diagrams are in [docs/diagrams](docs/diagrams), rendered to SVG from the living documents. The Markdown files here are exports of those living documents, taken on 4 November 2026.

## The design in brief

- **One isolated database per user.** Each user's career data lives in their own Durable Object, the Career Vault, with its own SQLite database. D1 is the control plane: accounts, billing and the directory of vaults, never on the request path for career data. EU users' vaults are pinned to the EU.
- **Grounded generation.** Employers, titles, dates and degrees are rendered from records by code. Models write only bullet and summary text, every claim must cite stored facts, and deterministic checks plus an independent judge fail closed to the user's own words.
- **Gaps become questions, not content.** A job requirement with no supporting evidence produces a question for the user, never an invented bullet.
- **A consent-first marketplace.** Candidates who opt in appear to verified recruiters as pseudonymous, evidence-backed cards. Recruiters pay when a candidate accepts an introduction; seekers never pay to be seen, and their data is never sold.

## Planned layout

The technical architecture defines four Workers that deploy separately:

| Worker | Owns |
| --- | --- |
| `edge` | Static assets and the API; the only Worker users reach |
| `vault` | The `CareerVault` Durable Object, `TailorSession` sub-agents, and the Distill and Tailor Workflows |
| `render` | Pooled Browser Run sessions for PDF rendering |
| `control` | The D1 control plane, billing webhooks, admin, fleet operations and the event consumer |

The marketplace adds recruiter workspaces, index shards and intro threads (see the system design); the design review lists the Workers and interfaces the technical architecture still needs for it.
