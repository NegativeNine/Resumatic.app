# Decision: a job listings provider for search

**Waiting for: the owner (whether, which provider, what budget) and counsel (search inside a paid plan; each provider's terms). Written on 11 November 2026 against `main` at `3d7c9fe`.**

## The question

Should people be able to search job listings inside Resumatic? If so, from which provider, with what budget, and may search be part of a paid plan?

## Why it blocks what

- **Job search was left out of v1.** The system design says so ("Out of scope for v1: job search and auto-apply", line 54), and lists as a risk that fetching job descriptions breaches a site's terms (line 1096).
- **What exists is one posting at a time.** A person pastes a posting, or names its link and the posting reader fetches that one page (`src/worker/postings.ts`). The reader is off unless `POSTING_READER_ENABLED` is `"true"` and is refused in production configuration ([seeker-threat-model.md](../seeker-threat-model.md), line 31). A saved job is a row in the vault's `applications` table: its posting text, link, title, company, status, date applied and notes (`src/vault/schema.ts`, the first and second migrations and the `url` column). It is made by `addApplicationIdempotent` in `src/vault/vault.ts`, from `POST /api/v2/applications` in `src/worker/routes.ts`.
- **Search may change the platform's legal position.** Several employment-agency rules exempt only services that job seekers never pay for, and UK rules bar making work-finding conditional on paid services (system design, lines 457 and 501, and the UK regulation cited at line 1190). Seeker plans can be paid (`src/shared/billing.ts`). Search inside a paid plan could be the kind of work-finding those rules mean. **Counsel.**
- **No provider can be chosen without reading its terms,** and nothing in the repository records any provider's terms.

## Criteria for a provider

A provider is acceptable only if its written terms, read by counsel, allow each of these.

| Criterion | What we need |
| --- | --- |
| Display | Showing its listings to signed-in people, with whatever attribution and link back it requires |
| Storage | Keeping a listing's text in the person's own vault, for as long as they keep the job, once they save it. A rule that expired listings must be deleted would clash with a saved job, and needs an answer first |
| Model use | Sending a saved listing's text to the model providers named in the privacy notice, to read requirements and to tailor, as a pasted posting is. No training, by us or by them |
| What it learns | What the provider receives about a search: our servers make the request, so it sees the search words and our address, not the person's. Whether it keeps or uses the search words |
| Regions | The countries people are in, and the languages its listings come in |
| Cost model | Per request, per result, per click, revenue share or flat, and whether a hard monthly cap is possible |
| Data protection | A processing agreement where it receives personal data, and where it processes it |
| Quality | How it handles duplicates, expired and scam listings, and whether listings carry pay ranges |
| Reliability | Rate limits and how it fails |

## Kinds of provider

None is named here, and no provider's terms are stated as fact. These are the kinds to compare.

1. **Listing aggregators with an API,** which gather postings from many sources and license them to apps.
2. **Job boards' partner or publisher programmes,** which syndicate their own listings.
3. **Applicant tracking systems' public job-board endpoints,** which serve one employer's openings at a time.
4. **Public employment services' open data,** where a government publishes listings for reuse.
5. **Employers' own pages, one at a time,** which is what the posting reader already does when a person names a link.

## Options

1. **No search.** Keep paste and links. Nothing changes.
2. **Search free on every plan,** from a licensed provider, through one provider-neutral interface.
3. **Search only on paid plans.**
4. **Links out only.** Results open the provider's page; nothing is fetched or kept until the person pastes it or saves it by its link, as today.

## Recommendation

**Option 1 until counsel answers. Then option 2, never option 3 unless counsel clears it market by market.** Free search keeps clear of the rule that seekers must not pay for work-finding, if counsel agrees that is the risk. Start with one provider behind an interface that does not depend on it, so a second can be added or the first replaced without touching the vault.

| Rule | Proposal |
| --- | --- |
| What leaves | Only the words the person types and the place they pick. Job preferences are not used: nothing reads them but their owner today (`test/unit/preferences-reach.test.ts`), and changing that is a separate decision |
| What is kept | Nothing, until the person saves a listing. Then it is a saved job like any other |
| What a listing is | Untrusted text from an employer, as a pasted posting is. Never an instruction, never evidence |
| Spend | Provider calls are spend. Each is counted against a daily cap per account and a monthly cap for the environment before it is sent, as model calls are reserved before dispatch (`src/workflows/models.ts`) |
| Switch | `JOB_SEARCH_ENABLED`, off unless exactly `"true"` and refused in production configuration until counsel and the owner agree |
| Budget | A monthly figure the owner sets once a provider's cost model is known. **Owner** |

## What changes once decided

**Code**

- Types in `src/shared/listings.ts`: a `ListingQuery` (words and place, each capped), a `Listing` (provider, the provider's ID, title, company, place, remote or not, posted and expiry dates, link, and text when the provider gives it) and a `ListingPage`.
- A `ListingProvider` interface (`search(query, cursor)`, `get(id)`) in `src/worker/listings/`, with one adapter per provider. The rest of the code sees only the interface.
- `POST /api/listings/search`: signed in, under its own rate limit, answering only to the person who asked. Nothing is stored.
- Saving a listing goes through `addApplicationIdempotent`, with its link, title, company and text, so a saved listing is an ordinary job. Two nullable columns on `applications`, the provider and its listing ID, in a new appended vault migration. A move copies them without a change, because transfer copies columns by `PRAGMA table_info` (`src/vault/operations.ts`). The export does not: `exportSnapshot` in `src/vault/vault.ts` maps each `applications` column by name, so the map and the `VaultExport` type each gain the two fields, with a test that a saved listing's provider and ID are in the export.
- A threat-model row and tests: a listing written as an instruction stays text; a search sends nothing but the query; spend refused at the cap.

**Docs**

- The privacy notice: what a search sends to the provider and that our servers make the request. `test/web/legal.test.tsx` changes with it.
- [seeker-threat-model.md](../seeker-threat-model.md) and [seeker-release-status.md](../seeker-release-status.md): a row each.
- [system-design.md](../system-design.md): job search moves out of "Out of scope".

## Who decides

- **Owner:** whether to offer search; the provider, after counsel has read its terms; the monthly budget; free or paid.
- **Counsel:** whether search inside a paid plan makes the platform an employment agency or a work-finding service in each market; each candidate provider's terms against the criteria above.
