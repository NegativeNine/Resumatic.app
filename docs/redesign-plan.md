# Resumatic v1: Redesign Plan

## Second redesign: the plain identity (November 2026)

The second redesign moves the app to the identity the design system now defines: a green check for what is backed, amber for what waits for the person, one legible typeface and everyday words. The record of the first redesign (#3 to #11) follows this section and still holds its ground rules: the design system is the source of truth, copies stay in sync, nothing new goes in the security policy, and copy follows voice and writing.

**Sources.**

- The design system Resumatic, version `1794444170-a305`, copied 2026-11-12T01:05:25Z from [the system](https://claude.ai/artifact/3KaBCkca28Q5HiXbhPdzDN). Section 12 of its "Changes to the app", "the plain identity", is what this redesign carries out.
- The UX redesign: a canvas of 42 boards and its `redesign.css`. Each board marks each capability on it Built, In part, Next or Later. The boards are design, not code.
- Atkinson Hyperlegible Next from `@fontsource-variable/atkinson-hyperlegible-next` 5.3.0, under the SIL Open Font License 1.1.

**Stages.** Stage 1 merges alone and first. Stage 2 branches from it, and stages 3 to 7 are built at the same time from stage 2 and merged in order.

| Stage | Branch | Owns |
| --- | --- | --- |
| 1 identity | `redesign/01-identity` | Tokens, type, the components bundle, fonts, logo and app icon, plain status class names, the label words in `format.ts`, review keys Y/F/L/J/K, the shared `app-*` layout classes, and the list of server text with earlier words (`docs/redesign-words.md`) |
| 2 shell | `redesign/02-shell` | Router and nested routes, the header, tabs, footer, the phone bottom bar, `GET /api/v2/today` and the placeholder page |
| 3 today | `redesign/03-today` | Today and its first run |
| 4 facts | `redesign/04-facts` | Facts: To check, All facts, Skills, Your files |
| 5 jobs | `redesign/05-jobs` | Jobs and a job's page |
| 6 sharing | `redesign/06-sharing` | Sharing and Account |
| 7 outside | `redesign/07-outside` | The coaching and hiring workspaces, `/share`, sign-in, the landing page, phone layouts and the invite email's lockup |

### Stage 1: the plain identity

Today's pages and routes keep their structure; only how they look and what they say changes. `tokens.css`, `type.css` and `components.css` are new copies of the system (custom properties only, the type classes, and the bundle without its `body` rule), and `fonts.css` loads Atkinson Hyperlegible Next, weights 200 to 800, from a latin and a latin-ext file. The main button is `brand`, links and quiet buttons are `link`, focus is `ink`, buttons are 44px (36 and 52), marks are 24px pills, and quotes are upright in the one face with the matched words on `backed-soft`. The lockup is the green tile with its check, then the outlined wordmark in `currentColor`, and `public/favicon.svg` is the tile at full bleed. The review queue answers with Y (that's right), F (fix it) and L (leave it out), and moves with J and K. `docs/redesign-words.md` lists what changed in the interface's words, the labels left for later stages, and every server message a person can reach that still uses an earlier word.

Decisions, each with the alternative rejected:

1. **`controls.css` stays, with new values.** About 70 plain `<button>`, input and select elements still carry v1 classes (finding 10 below), and rewriting their call sites is work for stages 2 to 7. Retiring it now was rejected.
2. **The system's files are copied as the first redesign copied them.** `tokens.css` holds custom properties only, plus `color-scheme`; `type.css` holds the type classes; `fonts.css` is written for the app; `components.css` is `bundle.css` without its `body` rule. Loading the system's `tokens.css` whole was rejected: its `@font-face` has no latin-ext file, and finding 7 still holds.
3. **`Badge` and `Tick` take plain tones only.** `MarkTone` and `TickState` are closed unions, and typed maps (`REVIEW_MARK`, `REVIEW_TICK`, `LINE_MARK`, `RUN_MARK`) translate stored states, so the types catch a missed call site. Free strings with an alias map inside `Badge` were rejected.
4. **Review buttons lose the noun.** A role's buttons read as a fact's, and `aria-describedby` names the item. "That's right role" (not English) and "Is this role right?" headings (a layout change, stage 4) were rejected.
5. **No "Put it back" yet.** The review API has only confirm and reject, and a left-out fact or role has no Fix it and no Leave it out, so it shows only That's right, and its key hints show only Y and J/K. Adding a review action in an identity stage was rejected.
6. **"Sensitive" stays.** The rename to private and Keep private goes to stage 4 with the privacy notice, which `legal.test.tsx` pins.
7. **The gaps heading keeps its qualifier:** "What may be missing, as found when this draft was made". The list is possible gaps at draft time, not a coverage check.
8. **The copy rule covers sentences, but only for five nouns:** source (meaning the person's file), vault, evidence, gap and output, and sentences that name a control or state by its old label. A rail titled "Your files" beside "No roles or facts from this source" would be incoherent, and the five can be found with grep. Renaming labels only, and changing every earlier word in every sentence, were rejected.
9. **Checks are not documents.** A line check or an accepted suggestion "counts toward your documents for this period", never "counts as one document", because a document is a finished resume, letter or interview preparation.
10. **Stray custom properties are resolved, not exempted.** `--application-columns` is set inline by `JobsPage`, so it is on an explicit allow-list in `tokens.test.ts`. `--dur-1` and `--font-mono` became literal values, because the system defines neither. `.app-letter` lost its `box-shadow`, and with it the `rgb()` fallback, because only the resume page and the sign-in sheet cast shadows.
11. **No server message changes in stage 1.** No screen stage 1 changes shows a server message only to itself, so there was nothing to take early. Changing them now was rejected: it churns integration tests that the room stages rewrite anyway.
12. **The invite email's PNG is not redrawn here.** Its lockup belongs to stage 7.
13. **`focus` is tested at 11:1**, the system README's figure, not only at 3:1.
14. **A coach's unseen comment is `needs-you`**, because it waits for the person. The app's own `.rs-mark--new` rule is gone.
15. **Fit's "not covered" tick is `todo`**, a neutral ring, not amber: something missing is not a request to the person.
16. **No screenshots.** See below.

The invite email's lockup (`public/email/resumatic-lockup.png`) still shows the turnstile; stage 7 redraws it. `sharp` 0.35.5 (a dev dependency through miniflare) can render the lockup SVG to PNG locally, at twice the 218 × 44 display size.

No headless Chromium was available, so stage 1 has no screenshots. There is no chrome or chromium binary, `LOCAL_CHROME_BIN` is unset, `node_modules` has no playwright or puppeteer, and downloading a browser needs the network.

Font bytes: 171,880 → 53,088. The four Schibsted Grotesk and Newsreader files go, and the two Atkinson Hyperlegible Next files (33,996 and 19,092 bytes) come in. The latin file is byte-identical to the design system's.

### Stage 2: the shell, the rooms and the Today API

Every address exists now. A room stage replaces one line of `SCREENS` per page and deletes its interim file. Today's pages keep serving their capabilities until then. Old links land: `#/resumes/:id` gains its job once the resume loads.

Until stage 3 sets `TODAY_OPEN`, signing in lands on To check and the rooms carry their own counts. Then Today becomes the default and carries the one count.

Until stage 6, the coach, comment, preference, card-preview and connected-app sections appear on Account and under Sharing. Until stage 5, saved answers appear on Account and on Rules and answers. The reach tests name both pages.

`GET /api/v2/today` is derived and stored nowhere. It carries counts, names and IDs, and never the words of a fact, comment, question, answer or stored error.

The phone bar is CSS only, and no test shows it.

**The route table.** Each row is one entry in `ROUTES` (`src/web/router.ts`) and one line in `SCREENS` (`src/web/screens.tsx`).

| Address | Name | Room › tab | Stage-2 screen | Replaced by |
| --- | --- | --- | --- | --- |
| `#/today` | today | Today | `PlaceholderPage name="today"` | 3 |
| `#/facts/check` | factsCheck | Facts › To check | `SourcesPage` | 4 |
| `#/facts/all` | factsAll | Facts › All facts | `SourcesPage` | 4 |
| `#/facts/all/ask` | attest | Facts › All facts | placeholder | 4 |
| `#/facts/skills` | factsSkills | Facts › Skills | placeholder | 4 |
| `#/facts/files` | factsFiles | Facts › Your files | `SourcesPage` | 4 |
| `#/jobs` | jobs | Jobs › Your jobs | `JobsPage` | 5 |
| `#/jobs/find` | jobsFind | Jobs › Find jobs | placeholder | 5 |
| `#/jobs/applications` | jobsApplications | Jobs › Applications | placeholder | 5 |
| `#/jobs/rules` | jobsRules | Jobs › Applications | `RulesInterim` (rules `PlaceholderSection`, then `SavedAnswers`) | 5 |
| `#/jobs/:id/:jobTab` (fit, resume, letter, interview, application) | job | Jobs › Your jobs | `JobsPage focus={id}` | 5 |
| `#/jobs/:id/resume/:resumeId` | resume | Jobs › Your jobs | `ResumePage id={resumeId}` | 5 |
| `#/sharing` | sharing | Sharing › Overview | `SharingInterim`: `OwnerComments` | 6 |
| `#/sharing/coaches` | sharingCoaches | Sharing › Coaches | `CoachesInterim`: `CoachSharingTools`, `OwnerComments`, "Live access" section | 6 |
| `#/sharing/recruiters` | sharingRecruiters | Sharing › Recruiters | `RecruitersInterim`: `JobPreferences`, `CardPreviewSection` (with `capabilities.cardPreview`), "Visibility, blocks and requests" section | 6 |
| `#/sharing/recruiters/request/:id` | introRequest | Sharing › Recruiters | placeholder | 6 |
| `#/sharing/apps` | sharingApps | Sharing › Connected apps | `AppsInterim`: `ConnectedApps` | 6 |
| `#/account`, `#/account/:section` (profile, plan, notifications, appearance, data, signing-in) | account | none | `AccountPage`, whole, with the section scrolled into view and focused | 6 |
| `#/coaching/clients`, `#/coaching/clients/:id` | coachingClients, coachingClient | Coaching › Clients | `ClientsPage` | 7 |
| `#/coaching/organisation` | coachingOrganisation | Coaching › Organisation | placeholder | 7 |
| `#/hiring/openings`, `/candidates`, `/introductions`, `/organisation` | hiring* | Hiring › each | placeholder | 7 |
| `#/privacy`, `#/terms` | privacy, terms | none | `LegalPage` | none |

**Old addresses.** `canonicalHash` rewrites these with `history.replaceState`:

- `""` and `#/` become `DEFAULT_HASH`, which is `TODAY_OPEN ? "#/today" : "#/facts/check"`.
- `#/sources` and `#/facts` become `#/facts/check`.
- `#/applications` becomes `#/jobs`.
- `#/clients` and `#/coaching` become `#/coaching/clients`.
- `#/hiring` becomes `#/hiring/openings`.
- `#/jobs/:id` becomes `#/jobs/:id/fit`, except when `:id` is `find`, `applications` or `rules`.

`#/resumes/:id` parses to the resume route with no job, and `useCanonicalResumeAddress` puts the job in the address once the resume has loaded, as it corrects an address that names the wrong job. The resume's route key is `resume/<resumeId>` and a job's is `job/<id>`, so neither the correction nor moving between a job's tabs remounts the page or moves focus.

Decisions, each with the alternative rejected:

1. **Two tables in two files.** `ROUTES` in `router.ts` is pure: pattern, name, room, tab and workspace, with no React component, so `router.test.ts` stays a pure test. `SCREENS` in `screens.tsx` is typed over every route name, so the compiler asks for a screen for each; its rows are grouped by owning stage in marked blocks. Components inside `router.ts` were rejected: pages import `href` from the router, so it would be an import cycle.
2. **`TODAY_OPEN` gates the default and the first-row count.** Stage 2 merges and deploys alone, and landing on a placeholder would replace today's landing page with an empty one. Coach-comment emails link to `/`, and the header's count leads to where comments are read; with the flag off, each room's count leads to a page that shows what it counts, and Sharing › Overview shows `OwnerComments`. Today as the default now (a dead landing), a Today-only count now (it would lead to a page that can't show it) and two separate edits in stage 3 (one constant keeps it to one line) were rejected.
3. **After stage 3, only Today carries a first-row count**, as the board says: "Nothing else is counted". Room numbers stay in the second row, on To check and Coaches. Room counts kept permanently were rejected; the owner can still ask for them (question 1 below).
4. **Old resume links are corrected after the resume loads.** A synchronous job lookup (an extra request on every old link) and a resolver component (the same resume loaded twice) were rejected.
5. **Account sections are sub-routes.** Anchors in the hash (a hash router can't hold them) and every menu link at `#/account` (the person loses their place) were rejected.
6. **Interim pages are built from existing components** (`src/web/pages/interim/{jobs,sharing}.tsx`), and the two reach tests are widened by one path each. Pointing Sharing tabs at `AccountPage` (the tab and the page heading would disagree) and placeholders for capabilities that are built (the owner's placeholder rule forbids them) were rejected.
7. **Counts are attributed to the source each review entry is shown under.** `proposedBySource` sums to `countByState(...).proposed`, and both live in `src/shared/review-groups.ts`, so the Vault and the web app count with one function. Raw per-source counts were rejected: a duplicate would be counted twice.
8. **Today reads files lightly.** The Vault reads only `id, filename`, state and time from `sources`. `readSources()` was rejected: it works out conversion quality over every PDF's and OCR file's text and looks up runs, on a request made on every room change.
9. **Comments and suggestions are separate kinds.** A comment is an unseen coach's row with no suggestion state; a suggestion is an open row whose owner standing is waiting, seen or not. `unseen()` was rejected: it counts suggestions as comments and misses a suggestion seen but not answered.
10. **No words.** The answer carries counts, IDs, file names, job titles and companies, coach names and addresses, and link labels. An unreadable file carries no error: its reason is shown on Your files. An employer's question text and the stored error were rejected.
11. **Counts refresh after a write.** `request()` in `api.ts` sends `COUNTS_CHANGED` 150 ms after any 2xx change to `/api/`, never after `/auth/*`, so a sign-out note stays. Today also reloads when the room or workspace changes, not the tab. Reloading on every route change was rejected: a vault read per tab click.
12. **The phone bar is the same `nav`, restyled below 600px.** A second nav was rejected: a duplicate landmark.
13. **The account menu is a disclosure:** a button with `aria-expanded` and `aria-controls`, and the panel next in DOM order. `role="menu"` was rejected: the panel holds headings.
14. **Shared files carry one marked, empty block per stage**, `// stage 3: today` to `// stage 7: outside` (`/* … */` in CSS), in `api.ts`, `api-fake.ts`, `test/web/fixtures.ts`, `app.css`, `placeholders.ts` and `screens.tsx`. Stages 3 to 7 are built at the same time and add only inside their own block. Appending at the end was rejected: it conflicts at every merge after the first.

Open questions for the owner, each built as stated; the answer changes only a later stage:

1. Once Today opens, only Today carries a first-row count, as the board shows. If room counts should stay after stage 3, stage 3 leaves them on.
2. Kits for jobs whose status is Closed still count as waiting, as the kit page reports them. Should they?
3. Kit question text and stored read errors are left out of Today. If stage 3's board needs either, stage 3 adds it, an error only through `sourceErrorMessage`.
4. The phone bottom bar holds the four rooms (the shell board), while the phone boards add Account as a fifth. Stage 7 settles it; stage 2 ships four.

### Stage 6: Sharing and Account

Stage 6 changes the client and the words only. It adds no table, endpoint, Vault method, switch or model call, and no migration. Sharing gets its four pages, Account its own layout, and `src/web/pages/interim/sharing.tsx` is gone. The server's sharing and account messages use the plain words (section 3 of `docs/redesign-words.md` lists what changed).

**The screens, and what each reads.** Every read is the owner's own session route; no identity comes from the client.

| Address | Screen | Reads |
| --- | --- | --- |
| `#/sharing` | `SharingOverview`: three ways (Coaches, Recruiters, Connected apps) with what each holds now, then what never leaves the record | `/api/shares`; `/api/mcp/grants` only where connected apps are on; Today from `TodayContext` (the shell's own read). Never preferences, the preview or a comment thread, and it never posts `/seen` |
| `#/sharing/coaches` | `SharingCoaches`: the copies shared, the comments and live access (a placeholder), beside the form for a new copy | `/api/shares`, `/api/shares/comments`; the form, once opened, reads facts, jobs, roles and the shareable documents |
| `#/sharing/recruiters` | `SharingRecruiters`: "Can recruiters find you?" (a placeholder) and what a recruiter would see (where the preview is on), beside "Requests to meet you" (a placeholder) and what you're looking for | `/api/v2/card-preview` where it is on, `/api/preferences` |
| `#/sharing/recruiters/request/:id` | the `introRequest` placeholder, now with a way back to Recruiters | nothing |
| `#/sharing/apps` | `SharingApps`: `ConnectedApps` as before, its heading "Your apps"; not found where apps are off | `/api/mcp/grants` |
| `#/account`, `#/account/:section` | `AccountPage`: the sections listed beside them, then Profile, Plan, Notifications (where email is on, with More choices), Appearance, Your data, where the record is kept (a placeholder), Signing in, and Delete account last | `/api/billing`, `/api/email-notices` where email is on |

Overview counts what waits on Coaches exactly as the Coaches tab does: Today's `counts.sharing` once Today has loaded, otherwise the session's `newFromCoach`. Its words come from Today's `comments` and `suggestions` items. A copy is open when it isn't revoked, hasn't expired and can be delivered; an app is connected, waiting or ended by `ConnectedApps`' own rules. Stage 2's shell test that reached a comment from the header in one click now reaches it in two: Sharing says it waits, and its Coaches tab shows it.

Decisions, each with the alternative rejected:

1. **Overview summarises; it doesn't embed `OwnerComments`.** `OwnerComments` marks comments seen on render, which would clear the count while the person sees only a summary.
2. **Overview reads only routes that already exist** (`/api/shares`, `/api/mcp/grants`, and Today from `TodayContext`). Reading `api.facts` for one number on every visit was rejected, and so was `api.preferences`, which the reach test forbids.
3. **`api.mcpGrants` is added, and `ConnectedApps` keeps its raw `fetch`.** Rewriting it was rejected: its list is shown as today, and it is a listed older exception. Overview reuses its active, pending and inactive rules, so the two never disagree.
4. **The share tools move to `components/sharing/Copies.tsx`, split into `CopyList` and `NewCopy`, with their state on the page.** Keeping `CoachSharingTools` whole was rejected: the board puts the list and the form in different columns.
5. **The share form stays behind "Choose what to share".** Opening it at once, as the board shows, was rejected because it fires four requests on every visit. The control names the tests and the smoke check pin are kept.
6. **The recruiter placeholders are two sections in view, not `MoreChoices`.** A disclosure hiding only "Not available yet" adds a control for nothing, and the MoreChoices rule keeps protections (blocks, caps) in view.
7. **Notifications' More choices holds a placeholder.** Every notice that works stays in view. Dropping the row was rejected because the board has it; inventing frequency selects was rejected because none is built.
8. **Where the record is kept is a placeholder whose words match the privacy notice** ("created … near where you first sign in"). A present-tense "is kept near" was rejected: a fenced vault replacement creates the new vault without the location hint.
9. **Signing in keeps its own section, before Delete account.** Putting it under Your data was rejected because the `signing-in` anchor exists; putting it last was rejected because Delete sits last.
10. **The card preview's noun is "anonymous profile", and its heading "What a recruiter would see".** `docs/redesign-words.md` assigned this rename to stage 6.
11. **The archive messages are constants in `src/render/archive.ts`**, so the route, the Vault and the tests share one sentence.
12. **The consent page points to "Sharing › Connected apps"**, because apps no longer live on Account.
13. **Moved copy uses stage 4's word "private".**
14. **The router and stage 2's anchors are untouched. `AccountPage` learns its section from a prop given in `screens.tsx`.** Reading `location.hash` inside the page was rejected: it duplicates the router's parsing.
15. **Room styles go in `styles/rooms/sharing.css` and `rooms/account.css`, and the raw-colour test reads `styles/rooms/*.css`.** Moving them into `app.css`'s stage 6 block was rejected: that block is for shared rules.
16. **Overview marks follow the shell: no count at zero.** "{n} connected" is `backed`, as `ConnectedApps`' "Connected" is; `status` is reserved to a job's tracking.
17. **"Suggested wording" stays uncountable.** It is counted in lines of suggested wording, because `count` would print "wordings".
18. **Notices and the link hint name places, not "here" or "below".** Both moved, and the old words now point the wrong way.

Also settled here, where the design left it open: Account says in one line, beside its list of sections, that saved answers are under Jobs › Rules and answers; Plan keeps its renewal date after the plan words; and Overview names a copy that names nobody "A link".

Open questions for the owner, each built as stated; only the answer would change it:

1. Account shows "Where your record is kept" as a placeholder because the board marks EU residency Later. Keep it or drop it?
2. Notifications' More choices holds only a placeholder. Is a row with nothing to choose acceptable?
3. Blocks, the weekly cap and pausing are in view under "Can recruiters find you?", not inside More choices as the board draws them. Is that right?
4. Sign out everywhere stays in its own "Signing in" section, before Delete account. Is that right?
5. Overview doesn't count private facts, which would cost a facts read per visit. Should it?
6. Is "anonymous profile" the right word before anything is published?
7. The placeholder for more email notices names no reason for waiting. What does it wait for?

---

Nov 7, 2026. Revised after PR #2 (the job seeker roadmap) merged, which changed 42 of the web app's files. The redesign is rebuilt on that `main` (`215a3e3`).

This plan brings the Resumatic design system into the web app (`src/web`), along with the few server changes the design needs.

- **Design system:** [Resumatic](https://claude.ai/artifact/3KaBCkca28Q5HiXbhPdzDN). It holds the brand, the UX principles, the components and the "Changes to the app" list.
- **Prototypes:** [Resumatic prototypes](https://claude.ai/artifact/8DZFVLVD5uindetU7MnDh1), a set of 12 artboards. Their markup is the reference for every screen below.
- **Branches:** one per PR, `redesign/01-foundations` to `redesign/09-docs`, each stacked on the one before. Screenshots for the PR descriptions live on the `redesign-screenshots` branch, which is never merged.

## Status

All nine pull requests (#3 to #11) are merged into main.

Two follow-ups came out of a review of main after the merge:

- **#13, polish.** The screens the redesign only restyled through the adapter now use the design system's components: application documents, the job board, the plan, share links and connected apps on Account, and the shared copy at `/share`. It also adds structure checks with axe-core over every page (`test/web/accessibility.test.tsx`), which found and fixed invalid list markup on the board.
- **#14, typography.** The interface's copy uses typographic apostrophes and quotation marks, and server messages are typeset on display (`typeset` in `src/web/format.ts`).

#12 adds a staging deploy that needs no model credentials. It waits on the staging Cloudflare account ID.

Where the build departed from this plan:

- **Jobs (PR 6).** On wide screens the list view puts the form beside the jobs, as the artboard does; the board keeps the full width. A job's own tracking status is a neutral outline mark, List and Board are drawn as the segmented filter, and the page file is `JobsPage.tsx`.
- **The browser smoke (PR 6).** It had stopped at sign-in since PR 2, because it waited for v1 labels and class names. PR 6 updated its selectors without changing any check, and PRs 7 and 8 kept it passing.
- **Errors (PR 7).** Besides the table's messages, every message a person reaches on a normal path is a sentence, and the client shows any other server message as one (`src/shared/sentence.ts`). Two fixed messages joined the reviewed list in `workflows/steps.ts`: a file the converter can't read, and a file too long to read.
- **Findings (PR 8).** The fifth kind is `unsupported`, which covers the judge and the deterministic checks with no specific sentence. Connected apps read resumes without findings.
- **Duplicate uploads (PR 8).** The Vault checks the hash before the upload is reserved, so a refused copy never reaches R2. A copy under another name is refused too ("You've already uploaded this file as …"). Retry upload appears only when it isn't clear whether the file arrived.
- **Sizes.** Client JS is 372.5 kB (113.8 kB gzipped), 9.6 kB gzipped over the baseline. Client CSS is 48.2 kB (9.8 kB gzipped), most of it the component bundle.

Still open: the keyboard and screen reader passes with VoiceOver and NVDA (the axe-core checks cover structure only, not contrast or reading order), and a staging run once `STAGING_DEPLOY_ENABLED` is set.

## Summary

The work ships as nine pull requests. Each one keeps CI green and deploys to staging when it merges.

| # | Pull request | What lands | Size | Server change |
| --- | --- | --- | --- | --- |
| 1 | Foundations | Tokens, fonts, theme switch, favicon, a test project for the web app | M | none |
| 2 | Shell and navigation | Lockup, Facts / Jobs / Account, QuotaMeter, route aliases | S | none |
| 3 | Primitives | Mark, Tick, Quote, Field, Message, EmptyState, and the design's buttons and fields for every existing control | M | none |
| 4 | Facts page | Sources rail, tick column, keyboard review queue, a warning before rejecting a role | L | none |
| 5 | Resume page | Sheet built from a model the PDF template shares, margin notes, check strip, gap list | L | none |
| 6 | Jobs, sign-in, account | Job cards with Latest, SignInCard, account panels, dark theme on | M | none |
| 7 | Copy and errors | Error messages in the interface's voice, in the client and on the server | M | message text |
| 8 | API additions | Why a line was repaired or replaced, duplicate upload check | M | yes |
| 9 | Docs | Invite email, diagrams, corrections to the design system | S | none |

PRs 1 to 6 depend on each other in order. PR 8, and the server half of PR 7, don't depend on the UI PRs. The client half of PR 7 is a final sweep, so it comes last. The sentence PR 8 adds to each margin note appears once PR 5 has landed.

## Baseline

These results were recorded on `main` at `215a3e3`, after PR #2 merged and before any redesign change:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passes |
| `npm test` | 1,555 tests in 206 files pass and 2 are skipped, in about 8 minutes |
| `node --test scripts/*.test.mjs` | 130 tests pass |
| `npm run build` | Passes. Client CSS is 18.1 kB (4.6 kB gzipped) and client JS is 345.6 kB (104.2 kB gzipped). |

Before PR 1, the web app was tested only through a few server-rendered component tests in `test/unit`. `scripts/e2e-staging.mjs` calls the API only.

## What the code review found

I read the code against the design system's "Changes to the app". These are the things the plan has to handle. Some correct the design doc; some are existing problems the redesign would put on screen. PR #2 already settled two of the original ten.

1. **Quote context already exists.** PR #2 stores each quote's `span` in its source and adds "See this quote in its source" (`SourceEvidence.tsx`), which shows the quote highlighted in the source text. So the design doc's quote context needs no API change; PR 3 and PR 4 restyle it, and the old PR 8b is dropped.
2. **Server wording reaches people verbatim, and the client's wording never does.** `describeError` (`src/web/errors.ts`) prefers any 4xx JSON message to the `words` its caller passes. As a result, the quota and conflict sentences in `src/web/tailor.ts` never show. People see "you have used all 20 tailored resumes for this month; more on December 1" instead (PR 7).
3. **Failure messages speak as a person.** The fallbacks say "We couldn't reach Resumatic" (`errors.ts`) and "We couldn't finish reading this file. Please try again later." (`source-error.ts`), and stored errors get no full stop (`src/workflows/steps.ts`) (PR 7).
4. **The cached PDF now follows profile edits.** Settled by PR #2: the export cache key hashes the whole render input, profile included (`src/worker/vault-export-cache.ts`). PR 5 no longer changes the cache.
5. **"FACT" comes from CSS.** The markup in `LineItem.tsx` already says "Fact". The rule `.evidence-label` in `styles.css` uppercases it, so the fix belongs in CSS, not in the text.
6. **The duplicate upload check breaks a test as it's written.** The test "reads at most three uploads at a time" (`test/integration/vault.test.ts`) uploads the same bytes five times into one vault (PR 8).
7. **The token file's type classes collide with the app's classes.** The design system's `tokens.css` defines `.quote` and `.lede`, and the app uses both names (`ui.tsx`). So PR 1 copies only the custom properties. The type ramp arrives in PR 3, together with the components that replace those classes.
8. **The sheet can't wrap lines exactly as the PDF does.** The design's sheet is 720 px wide with 14 px text. The PDF is a Letter page, 816 px wide at 96 dpi, with 10.5 pt (14 px) text. It is printed by Browser Run, using whatever Helvetica or Arial substitute its Chromium has. So PR 5 scales the sheet in proportion and treats line breaks as approximate. Print preview stays the exact view.
9. **The app has more screens than the design.** PR #2 added a job tracker board, cover letters and interview prep (`ApplicationWorkspace.tsx`, `Documents.tsx`), billing, sharing and connected apps on Account (`AccountTools.tsx`, `ConnectedApps.tsx`) and a public share page (`SharePage.tsx`). None has an artboard, so they take the design through the shared primitives and the same patterns: panels, marks, quotes and fields.
10. **Controls are written as plain elements, about 70 of them.** Buttons, inputs and selects carry v1 class names (`primary`, `quiet`, `small`) across about 8,400 lines. Rewriting each call site would be a large, risky diff in code that guards revisions and retries. So PR 3 restyles those elements and class names to the design system's controls in one adapter stylesheet, and components rebuilt in later PRs use the rs- classes directly.
11. **The security policy rules out an inline theme script.** `public/_headers` sets `script-src 'self'`. So a small script served from the same origin, `public/theme.js`, sets the theme. It loads in `<head>`, before the first paint.

## Decisions

The plan assumes the recommended option in each row unless you choose otherwise.

| Decision | Recommended | Alternative |
| --- | --- | --- |
| Scope | All nine PRs, in order | The UI work (PRs 1–7) now, with the API additions later |
| Dark theme | Turn it on in PR 6. It follows the operating system, and Account gets an Appearance setting. Until then, `theme.js` applies only an explicitly stored choice, so dark can be checked during PRs 1–5. | Light only for now |
| Routes | Use `#/facts` and `#/jobs`. `#/sources` and `#/applications` stay as aliases that redirect to them. | Keep the old hashes and rename only the labels |
| Keyboard shortcuts | C, E, R, J and K work only while focus is inside the review queue. That meets WCAG 2.1.4 without needing a setting. | Keys that work anywhere on the page, plus a setting on Account to turn them off |
| Why a line changed | The deterministic checks return a typed `finding`, and the client words it. The judge model's free text never reaches the screen. | A `reason` sentence written on the server, as the design doc says |
| Gap question | Show the requirement as written, then ask "Describe what you did, in your own words." | A template such as "Have you worked with Kafka?", which reads badly for a requirement like "5+ years of Go" |
| Quote font file | Newsreader italic with the weight axis only (64.5 kB) | Weight and optical-size axes (146.9 kB), as in the design system |
| Font source | Copy the woff2 files (latin and latin-ext) into the repo, with their OFL licences | Install the `@fontsource-variable` packages from npm |
| Duplicate upload | Answer 409 with "You've already uploaded jane-doe.pdf." An earlier upload that failed doesn't count as a duplicate. | Accept duplicates, as v1 does today |
| PR shape | One PR per phase, each stacked on the previous one | One large PR |

## Ground rules for every PR

- **CI passes:** `npm run typecheck`, `npm test` (unit, integration and, from PR 1, web) and `npm run build`.
- **The design system is the source of truth.** Files copied from it live in `src/web/styles/`, with a note of where each one came from. A change to one copy is made in both. The same rule holds between the in-app sheet and `src/render/template.ts`.
- **Copy follows the design system's "Voice and writing" guide.** Each PR fixes the copy in the components it touches, and PR 7 sweeps up whatever is left.
- **No new security policy entries.** That means no inline scripts and no third-party origins. Numbers that drive layout, such as where a margin note sits, are set through the CSSOM (`element.style`), which `style-src 'self'` allows.
- **Accessibility holds at every step:**
  - The skip link stays the first focusable element, and focus moves to `main` when the route changes.
  - After a review decision, focus moves the way `useReview` already moves it.
  - Every control works from the keyboard.
  - No state is shown by color alone.
- **Screenshots in every PR.** Each PR description shows the screens it changes, at 1280 px and 390 px wide, next to the matching artboard. Light screens are shown from PR 1, and dark screens from PR 6.
- **Old CSS goes when its last user goes.** By the end of PR 7, `src/web/styles.css` no longer exists.

## Target structure

```
src/web/
  styles/
    README.md         where each file comes from, and the rule for keeping copies in sync
    tokens.css        custom properties for light and dark (from the design system's tokens.css)
    fonts.css         @font-face rules
    type.css          the type ramp (PR 3)
    components.css    the rs- component styles (from the design system's components/bundle.css)
    controls.css      the design's buttons and fields for the app's existing elements and class names (PR 3)
    app.css           page layout: header, rail, sheet and margin, breakpoints
  fonts/              four woff2 files, two OFL licences, a README
  components/
    Lockup.tsx        inline SVG lockup and mark (PR 2)
    QuotaMeter.tsx    (PR 2)
  theme.ts            the stored choice, and following the OS (PR 1; Account uses it in PR 6)
public/
  favicon.svg         (PR 1)
  theme.js            sets data-theme before the first paint (PR 1)
src/shared/sheet.ts   the resume sheet model that both renderers use (PR 5)
test/web/             React tests in jsdom (PR 1 onward)
```

## PR 1. Foundations

**Goal.** The new palette and type everywhere, with no change to markup, plus a test project for the UI.

| File | Change |
| --- | --- |
| `src/web/styles/tokens.css` | New. The custom properties from the design system's `tokens.css`: light and dark colors, spacing, radius, layout and font stacks. Each theme block also gets `color-scheme: light` or `color-scheme: dark`. The type classes are left out (finding 7). |
| `src/web/styles/fonts.css`, `src/web/fonts/` | New. Schibsted Grotesk (weights 400–900) and Newsreader italic, each as a latin file and a latin-ext file, with fontsource's `unicode-range` values. That way names like Łukasz or Nguyễn render in one typeface. Fonts use `font-display: swap`, and the URLs are relative so Vite fingerprints the files. The folder also holds the OFL licences and a README naming `@fontsource-variable/*` 5.3.0 as the source. |
| `src/web/styles.css` | Replace the `:root` block (lines 1–27) with a bridge from the old variable names to the new tokens. Details follow this table. |
| `src/web/App.tsx` | Import `styles/tokens.css`, then `styles/fonts.css`, then `styles.css`. |
| `index.html` | Add `<meta name="color-scheme" content="light dark">`, `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` and `<script src="/theme.js"></script>` to `<head>`. Vite serves the script as is from `public/`. |
| `public/favicon.svg` | New. Copied from the design system's `assets/Logos/resumatic-app-icon.svg`. |
| `public/theme.js` | New, about ten lines. It reads `localStorage["resumatic:theme"]` inside `try`/`catch` and sets `document.documentElement.dataset.theme`. Until PR 6 it applies only an explicitly stored choice, and otherwise sets `light`. |
| `src/web/theme.ts` | New. `getTheme()`, `setTheme("system" \| "light" \| "dark")`, and a `matchMedia` listener that follows the operating system while the choice is "system". The listener is switched on in PR 6. |
| `public/_headers` | Optional. Add `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`, since Vite fingerprints those files. |

**The variable bridge in `src/web/styles.css`:**
- Map the old names to the new tokens:
  - `--bg` → `desk`
  - `--surface` → `paper`
  - `--surface-sunken` → `paper-sunken`
  - `--text` → `ink`
  - `--muted` → `ink-muted`
  - `--border` → `rule`
  - `--border-strong` → `rule-strong`
  - `--focus` → `focus`
  - `--success` → `ledger`
  - `--danger` → `danger`
  - `--font` → `--font-sans`
  - `--font-quote` keeps its name
- Split `--accent` by use. Its 18 uses (counting `--accent-strong` and `--accent-soft`) take `ink` (with `on-ink` text) for `.primary`, the nav underline and the selected filter. They take `ballpoint` for `a`, `.quiet` and `.link-button`.
- Replace the 29 hard-coded colors with tokens, so dark mode holds together. Badge tones take their StatusMark colors:
  - kept, confirmed and ready take `ledger` on `ledger-soft`
  - repaired, queued and running take `ballpoint` on `ballpoint-soft`
  - replaced takes `violet` on `violet-soft`
  - edited and mine take `on-highlight` on `highlight`
  - rejected and dropped take `ink-muted` on `paper-sunken`
  - failed takes `danger` on `danger-soft`
  - proposed takes `ink-muted` with a dashed `pencil` border, which retires the amber tone
- Change the focus ring to 2 px, as the design system specifies.

**Web test project:**
- **`vitest.config.ts`:** a `web` project with `@vitejs/plugin-react`, `environment: "jsdom"`, `include: ["test/web/**/*.test.{ts,tsx}"]` and `setupFiles: ["test/web/setup.ts"]`.
- **`test/web/setup.ts`:** loads `@testing-library/jest-dom/vitest`, cleans up after each test, and stubs `window.scrollTo` and `matchMedia`, which jsdom lacks.
- **`test/web/api-fake.ts` and `test/web/fixtures.ts`:**
  - An in-memory stand-in for the API, installed with `vi.stubGlobal("fetch", …)`.
  - Fixtures for a vault, jobs and a ready resume.
  - A `renderWithSession(ui, { me })` helper, because most components call `useSession()`.
- **`test/web/tsconfig.json`:** DOM lib and `jsx: react-jsx`. Add it to the references in the root `tsconfig.json`, and exclude `web/**` from `test/tsconfig.json`, whose ES-only lib would reject DOM code.
- **`package.json`:** add the dev dependencies `jsdom`, `@testing-library/dom`, `@testing-library/react`, `@testing-library/user-event` and `@testing-library/jest-dom`, and add `--project web` to `"test"`. (`@testing-library/dom` is a peer dependency, and `.npmrc` sets `legacy-peer-deps`, so it has to be listed.)

**Tests:**
- **`test/web/tokens.test.ts`:** parses `src/web/styles/tokens.css` and checks, in both themes, the contrast the design system promises:
  - `ink` and `ink-muted` on `paper`, `paper-sunken` and `desk` at 4.5:1
  - `on-ink` on `ink`
  - `ballpoint` on `paper` and `desk`
  - `on-highlight` on `highlight`
  - `danger` on `paper` and on `danger-soft`
  - `ledger` on `ledger-soft`
  - `focus` against `paper` and `desk` at 3:1
- **`test/web/router.test.ts`:** today's `parseRoute`, as a baseline for PR 2's aliases.
- **`test/web/format.test.ts`:** `formatMonth`, `formatDateRange` and `count`.
- **`test/web/theme.test.ts`:** `public/theme.js` and `src/web/theme.ts` agree on the stored choice.
- **`test/web/app.test.tsx`:** the app signs in against the fake API and shows its first page.

**Risks.**
- Schibsted Grotesk sets wider than `system-ui`. Check that buttons and the nav don't wrap at 390 px.
- Dark mode is only partly restyled until PR 6, which is why it stays behind the stored choice until then.

**Done when.**
- Every page shows the new colors and type, and nothing has moved.
- The contrast test passes.

## PR 2. Shell and navigation

**Goal.** The header, nav and footer from the AppHeader component, under the new place names.

| File | Change |
| --- | --- |
| `src/web/styles/components.css` | New. The design system's `components/bundle.css`, without its `body` rule, because the app's ground is `desk`, not `paper`. Import it after `fonts.css` and before `styles.css`. |
| `src/web/router.ts` | The pages `facts` and `jobs` replace `sources` and `applications`, with `href.facts = "#/facts"` and `href.jobs = "#/jobs"`. `parseRoute` maps `sources` to `facts`, `applications` to `jobs`, and the empty hash to `facts`. An alias is rewritten to its canonical hash with `history.replaceState`, so the address bar and copied links show the new names. |
| `src/web/App.tsx` | Titles become "Facts", "Jobs", "Tailored resume" and "Account". Update the page switch, and point the not-found copy to Facts and Jobs. |
| `src/web/components/Lockup.tsx` | New. The lockup and the mark as inline SVG with `fill="currentColor"`, built from the design system's `resumatic-lockup-ink.svg` and `resumatic-mark-ink.svg`. Each has `role="img"` and `aria-label="Resumatic"`. |
| `src/web/components/Shell.tsx` | AppHeader markup (`rs-header`, `rs-brand`, `rs-nav`). Details follow this table. |
| `src/web/components/QuotaMeter.tsx` | New. Draws `limit` ticks, or ten ticks that each stand for a tenth when the limit is above 40, all `aria-hidden`. The words carry the meaning: "12 of 20 resumes used this month", or "20 of 20 used. More from 1 Dec" in `danger` once the limit is reached. |
| `src/web/format.ts` | Add `formatDayMonthAfter("2026-11")`, which returns "1 Dec". |
| `src/web/styles.css` | Delete the header, nav, quota and footer rules. |

**What `Shell.tsx` gets:**
- The lockup, linking to Facts, and the Private beta mark.
- Nav labels Facts, Jobs and Account. Jobs stays current on a resume page.
- QuotaMeter in place of `QuotaLine`.
- Under 600 px, the lockup becomes the mark and the quota moves to the top of Jobs.
- The footer as `rs-footer`.

**Tests (web):**
- The aliases resolve and redirect to the canonical hash.
- `#/resumes/:id` still parses.
- Jobs has `aria-current` on a resume page.
- QuotaMeter shows the right words below and at the limit, and the right tick count above 40.
- The skip link is the first focusable element.
- A route change moves focus to `main`.

**Reference.** The Facts, Jobs and Account artboards (header and footer).

**Done when.**
- Every signed-in page has the AppHeader header.
- Old bookmarks still land on the right page.

## PR 3. Primitives

**Goal.** Rebuild `src/web/components/ui.tsx` on the rs- classes, so the page PRs only have to assemble parts.

| Primitive | Replaces | Notes |
| --- | --- | --- |
| Buttons | About 70 `<button>` elements and `a.button` links, styled with `primary`, `quiet`, `danger`, `small`, `large` and `link-button` | `styles/controls.css` gives those elements and class names the design system's button styles (`rs-btn` and its variants), so every existing control changes without touching its call site (finding 10). |
| `Mark` | `Badge`, wherever it's used | Each tone maps one to one onto an `rs-mark--*` class: proposed, confirmed, rejected, reading (was queued), ready, failed, running, kept, repaired, replaced, dropped, edited, mine and beta. |
| `Tick` | Nothing (new) | The tick column. Proposed is a dashed pencil tick, confirmed a ledger tick, rejected a struck tick, and your own claim a pen. |
| `Quote` | The `.quote` figure | `rs-quote`: Newsreader italic, the quoted span in `highlight`, ⊢ in the gutter and the caption below. `size="sm"` is for the margin. An optional `context` prop is filled in by PR 8. |
| `Field`, `CharCount` and inputs | `label`, `.hint`, the inputs and `.char-count` | `Field` renders `rs-field`, `rs-label` and `rs-hint`. `styles/controls.css` styles every input, textarea and select as `rs-input`, `rs-textarea` and `rs-select`. |
| `Message` | `.alert`, `.notice` and `.success` | Error, info and success, each keeping the `role="alert"` or `role="status"` it has today. `ErrorNote` and `ActionError` render it. |
| `Loading`, `EmptyState`, `PageHeader`, `Glyph` | `.loading`, `.empty` and `.page-head` | `EmptyState` takes the next step as a link. `Glyph` draws an `rs-g` mask and is always `aria-hidden`. |

This PR also adds `src/web/styles/type.css`, the type ramp, now that the app no longer uses `.quote` or `.lede`. It deletes the button, form, message, badge, quote, empty-state and loading rules from `styles.css`.

**Tests (web):**
- `Message` has the right role for each kind.
- `Button` shows its disabled and busy labels.
- `Quote` shows its caption and its highlight.
- `CharCount` shows the right text under and over the limit.

**Done when.**
- Every control on every page, including the screens PR #2 added, has the design system's look.
- `styles.css` has no button, form or badge rules left.

## PR 4. Facts page

**Goal.** The "Facts, first run" and "Facts, review queue" artboards, plus "Phone: review queue".

| File | Change |
| --- | --- |
| `pages/SourcesPage.tsx` → `pages/FactsPage.tsx` | Title "Facts". The sources rail (Dropzone, then the source list, `layout-rail` wide) sits beside the review column. With no sources, roles or facts yet, the dropzone is centered instead. Under 860 px, the rail stacks above the column. |
| `components/Uploader.tsx` | Dropzone markup. `problemWith` names the file without straight quotes around it, as the voice examples do. |
| `components/SourceList.tsx` | SourceRow markup. Details follow this table. |
| `components/Review.tsx` | SegmentedFilter (`rs-filter`) and the keyboard queue described below. The empty states use EmptyState, and "all caught up" links to Jobs. |
| `components/RoleGroup.tsx` | RoleGroup with the tick column, and a warning before Reject role. Details follow this table. |
| `components/FactItem.tsx` | FactItem with the tick column. The meta line becomes separate items (lines 48–57). The quote uses `Quote`, and rejected facts are muted. Escape cancels an edit and returns focus to the fact. |
| `components/ReviewButtons.tsx` | Details follow this table. |
| `components/AddFact.tsx`, `components/RoleForm.tsx` | Field grid and buttons. Escape closes the form. |
| `src/web/vault.ts` | Add `proposedUnder(vault, roleId)`. |

**`SourceList.tsx` (SourceRow):**
- The file name, then "Uploaded 7 Nov 2026" and "Download original" as separate items, with no middle dot (line 35).
- Marks: Reading…, Couldn't read, or Ready with "3 facts to review" or "All reviewed" beside it (line 65).
- A failed source gets two sentences (line 42, finding 3). The first is the stored error made into a sentence, or "This file couldn't be read." if there is none. The second is the retry advice.
- Confirm all keeps its warning and its count.

**`RoleGroup.tsx`:**
- The tick column.
- The detail line becomes separate items divided by short rules, replacing " · " (line 28).
- Reject role asks first whenever facts are still proposed under the role: "Reject Northwind Logistics and its 6 proposed facts? Rejected items are kept here and never used." The buttons are "Reject role and 6 facts" and Cancel.
- The count comes from the whole vault (`proposedUnder`), not the filtered list, because `review` rejects every proposed fact under the role (`src/vault/vault.ts:486`).

**`ReviewButtons.tsx`:**
- The buttons go in the order Confirm, Edit, Reject, and all three are disabled while a decision is saving.
- On click, the tick fills and holds for 160 ms before the item leaves. There's no hold under `prefers-reduced-motion`.
- Keep `useReview`'s focus order. Replace `closest(".group")` (line 30) with a data attribute, so markup changes can't break it.

**Keyboard queue.** In the design, the first proposed item is active, and it answers to C (confirm), E (edit), R (reject), J (next) and K (previous).

- **Items.** Each item carries `data-queue-item`, and each already has `tabIndex={-1}`. J and K move to the next or previous item in DOM order and focus it. C, E and R call the active item's confirm, edit and reject, which each item registers through a small context.
- **One handler.** A single `keydown` handler sits on the review section. It ignores:
  - events from text fields, textareas, selects and contenteditable elements
  - any event with Ctrl, Meta or Alt held
  - key repeats

  Because the keys work only while focus is inside the queue, they meet WCAG 2.1.4 without an off switch.
- **Active item.** The active item follows focus, so Tab and click work too. The key hints (`rs-actions__keys`) show only on the active item, and only at 860 px and wider.
- **Rejecting a role.** R on a role with proposed facts opens the warning. It never rejects straight away.

**Tests (web):**
- J and K move focus between items.
- C on the active fact sends `POST /api/review` with its ID.
- E opens the editor, and Escape closes it with focus back on the fact.
- R on a role with proposed facts opens the warning, and nothing is sent until the person confirms.
- Keys typed in a textarea do nothing, and neither do keys pressed with a modifier.
- The buttons render in the order Confirm, Edit, Reject.
- No meta line contains " · ".
- Each sentence in a failed source's text ends with a full stop.
- On first run, the dropzone is centered.

**Risks.**
- Focus regressions are the main risk. The existing focus order is the contract to keep.
- Screen readers in browse mode may take single-letter keys for themselves. The buttons remain the main way to review.

**Done when.**
- The review queue works from start to finish with the keyboard alone.
- The page matches the artboards at both widths.

## PR 5. Resume page

**Goal.** The "Tailored resume and its margin", "Tailoring", "Close a gap" and "Phone: a line's evidence" artboards, with a preview that matches the PDF.

**One model, two renderers.** Today the sheet in the app and the PDF template differ in four ways:
- The preview has no name or contact line.
- It puts projects and volunteering under their own headings (`ResumeSheet.tsx:12`).
- It puts the organization and the title on separate lines (`:85`).
- It prints a "Summary" heading that the PDF doesn't have (`:74`).

Instead of mirroring the template by hand, extract its structure into one model that both renderers use:

- **`src/shared/sheet.ts` (new).** `sheetModel(profile, body)` returns:
  - the name and the contact items
  - the summary line
  - the sections in the template's order: Experience (every role that isn't education), then Education
  - for each role, its heading ("Title, Organization"), its dates ("Mar 2021 – Present", with the PDF's capital P) and its lines
  - the skills
- **A golden test first.** Add `test/unit/render.test.ts`, which holds a golden copy of `renderResumeHtml` output for a fixture covering every kind of role. Then rebuild `src/render/template.ts` on `sheetModel`. Its output must stay byte-identical.
- **The app's sheet.** `ResumeSheet.tsx` renders the same model as `.rs-sheet`, with the profile from `useSession().me.profile`. The PDF also prints the current profile (`src/vault/vault.ts:657`).
  - The contact line and the skills keep " · ", because that is how the PDF prints them.
  - When the profile has no name, the margin says "Add your name and contact details on Account. They print at the top of every resume."

**Sheet size.** Lay the sheet out as a scaled Letter page:
- Make the frame a size container (`container-type: inline-size`).
- Set every sheet dimension in `em`.
- Set the base font size to `min(14px, 100cqw * 14 / 816)`.

At full size the sheet is the PDF's 816 px and 14 px. In a narrower frame, text, padding and widths all shrink together, so lines break close to where the PDF breaks them.

Exact line breaks can't be promised (finding 8). Before relying on them, print one PDF on staging, list its fonts with `pdffonts`, and adjust the font stack if Browser Run substitutes a wider face. The design system's `.rs-sheet` (720 px, fixed padding) changes to match; see PR 9.

| File | Change |
| --- | --- |
| `components/ResumeSheet.tsx` | The page layout. Details follow this table. |
| `components/LineItem.tsx` | Split in two: the line on the sheet and its note in the margin. Details follow this table. |
| `components/useMarginLayout.ts` | New. Places each margin note level with its line. Details follow this table. |
| `components/ResumeReport.tsx` | `CheckReport` (the strip, which becomes a two-by-two grid under 600 px) and `GapList`, with "Add a fact" on each gap. |
| `components/AddFact.tsx` | A gap mode for adding a fact from a gap. Details follow this table. |
| `components/TailorProgress.tsx` | Steps with ticks, and the copy "…the resume will be waiting under Jobs." |
| `pages/ResumePage.tsx` | "Back to Jobs". The margin's tick-in animation plays once, when the page sees the resume go from running to ready. It doesn't play on later visits or under reduced motion. The failed state uses the wording from the voice guide's table. |

**`ResumeSheet.tsx`:**
- A toolbar: Download PDF, Print preview, Show all evidence, Tailor a new version.
- The CheckReport strip above the sheet, with a link to the gaps ("3 requirements your facts don't cover").
- The sheet and the margin side by side, with GapList at the end of the margin.
- Under 860 px the margin goes away, and tapping a line opens its note as a well under the line.

**`LineItem.tsx`:**
- **The line** (`li.rs-line`) holds only the text that prints. Clicking it opens its note.
- **The note** holds a leader rule, the status mark, a "⊢ 2 facts" toggle (with `aria-expanded` and `aria-controls`), the evidence, and Edit line.
- Drop `text-transform` from the evidence label (finding 5).

**`useMarginLayout.ts`:**
- It measures the top of each line within the sheet, after `document.fonts.ready` and again on resize through `ResizeObserver`.
- It places notes with `element.style.top`. A pure function, `placeNotes(tops, heights, gap)`, keeps each note level with its line and pushes it down only when it would overlap the note above.
- One open note floats over the others (`shadow-pop`), so they don't move. Show all evidence opens every note, and the notes stack down the margin.

**`AddFact.tsx` (gap mode):**
- It shows the requirement as written, then the question "Describe what you did, in your own words."
- The hint says "A yes on its own can't go on a resume. Write the claim the way you'd want it to read."
- An answer can be saved only if it has at least three words and isn't a bare yes or no.
- After "Fact added." it offers Tailor a new version.
- The fact is saved with `POST /api/facts`, as the person's own claim.

**Tests:**
- **Unit:**
  - `sheetModel` gets the order, the headings, "Present" and the contact and skills separators right, and gives the summary no heading.
  - The template's output matches the golden copy.
  - `placeNotes` keeps notes level and pushes them down only on overlap.
- **Web:**
  - The sheet shows the session's name and contact line.
  - Every note toggle has `aria-expanded`.
  - Show all evidence opens and closes every note.
  - A bare "yes" can't be saved from a gap.

**Risks.**
- Notes can jitter while fonts load or in long resumes. Measure in one layout pass, and compare positions before writing them so `ResizeObserver` can't loop.
- The template refactor touches the PDF. The golden test is the guard.

**Done when.**
- The page matches the artboards.
- The sheet and Print preview show the same text in the same order.
- Editing the profile changes both (the export cache already follows profile edits, finding 4).

## PR 6. Jobs, sign-in and account

**Goal.** The "Jobs", "Sign in" and "Account" artboards, and the edge states from "Edge states". Dark mode is switched on in this PR.

| File | Change |
| --- | --- |
| `pages/ApplicationsPage.tsx` → `pages/JobsPage.tsx` | The page becomes Jobs. Details follow this table. |
| `pages/SignedOut.tsx` | SignInCard. Details follow this table. |
| `App.tsx` | The loading and unavailable states use the SignInCard frame. |
| `pages/AccountPage.tsx` | Laid out as panels. Details follow this table. |
| `public/theme.js`, `src/web/theme.ts` | When no choice is stored, follow the operating system. This switches dark mode on for everyone. |
| `pages/LegalPage.tsx` | "Sources & facts" becomes "Facts" (line 89), and the headings are restyled. |

**`JobsPage.tsx`:**
- The title "Jobs", and a lede that points to Facts.
- JobForm and JobCard.
- "Added 7 Nov 2026" and the note on unnamed jobs become separate items (line 128).
- Resume rows read "Resume tailored 7 Nov 2026, 9:42 AM", with state marks and Latest on the newest.
- The list heading becomes "Your jobs".
- The empty state reads "No jobs yet. Paste a job description above to start your first one."
- When the quota is used up, the notice stays at the top and the buttons stay enabled (finding 9).
- Under 600 px, the QuotaMeter words show at the top of the page.

**`SignedOut.tsx` (SignInCard):**
- The lockup.
- The headline "Tailored resumes, built only from what you've done."
- The current lede.
- Notes and errors, placed above the button.
- Sign in with Google, then the fine print.

**`AccountPage.tsx` panels:**
- Profile (a Field grid)
- Appearance (Match system, Light or Dark, through `theme.ts`)
- Signing out and Your data (SettingsRow)
- Delete account (DangerZone)

**Tests (web):**
- Latest marks only the newest resume.
- When the quota is used up, the notice shows and every Tailor button stays enabled.
- Choosing Dark sets `data-theme="dark"` and the choice persists. Match system follows `matchMedia`.
- Delete stays disabled until the confirmation phrase is typed.
- The sign-in note and error appear above the button.

**Done when.**
- The three pages match their artboards in light and dark.

## PR 7. Copy and errors

**Client:**
- **`src/web/errors.ts`.** A caller's `words` for an error code win over the server's message, and the server's message wins over the fallbacks (finding 2). Rewrite the fallbacks in the interface's voice:
  - "Resumatic couldn't be reached. Check your connection, then try again."
  - For not found: "This couldn't be found. It may have been removed."
  - Drop "Please" and "on our side" throughout.
- **`src/web/App.tsx:73`.** "Your account couldn't be loaded.", followed by the reason.
- **A sweep for what earlier PRs left behind:**
  - "we" outside the legal pages
  - middle dots outside the sheet
  - Title Case
  - exclamation marks

**Server.** A 4xx message is shown as written, so each one a person can reach becomes a sentence in the voice. Paths in this table are relative to `src/`:

| Where | Today | Becomes |
| --- | --- | --- |
| `vault/vault.ts:266` | wait for your other uploads to finish reading | Resumatic is still reading 3 of your uploads. Wait for one to finish, then upload this file. |
| `vault/vault.ts:267` | you can keep at most 50 uploads | You can keep up to 50 sources during the beta. Email support@resumatic.app if you need more. |
| `vault/vault.ts:579` | a resume is already being tailored; wait for it to finish | Another resume is still being tailored, and Resumatic works on one at a time. Wait for it to finish, then try again. |
| `vault/vault.ts:583` | you have used all 20 tailored resumes for this month; more on December 1 | You've used all 20 tailored resumes for Nov 2026. You can tailor more from 1 Dec 2026. |
| `vault/vault.ts:638`, `:652` | the resume is not ready yet | This resume isn't ready yet. Wait for tailoring to finish, then try again. |
| `vault/vault.ts:640` | a line must be 1 to 300 characters | A line can be up to 300 characters, and it can't be empty. |
| `vault/vault.ts:834` | that role was rejected | That role was rejected. Choose another role for this fact. |
| `worker/routes.ts:214` | upload a PDF or DOCX file | Upload a PDF or Word (.docx) file. |
| `worker/routes.ts:215` | the file is empty | This file is empty. |
| `worker/routes.ts:216` | files can be at most 10 MB | Files can be up to 10 MB. |
| `worker/routes.ts:40` | the request body is too large | Give the upload limit its own handler, which says "Files can be up to 10 MB." |
| `workflows/tailor.ts:36` | confirm some facts before tailoring a resume | Confirm some facts before tailoring a resume. |
| `workflows/tailor.ts:48` | none of your confirmed facts match this job yet | None of your confirmed facts match this job yet. Add facts that cover its requirements, then tailor a new version. |
| `workflows/distill.ts:25` | the uploaded file is missing; upload it again | The uploaded file is missing. Upload it again. |
| `workflows/distill.ts:27` | no text could be read from this file | No text could be read from this file. |
| `workflows/distill.ts:63` | We could not read this file. | This file couldn't be read. |
| `pipeline/distill.ts:23` | this document is too long to read; upload a resume of a few pages | This file is too long to read. Upload a resume of a few pages. |
| `ai/vectors.ts:43` | could not read *name*: *converter error* | This file couldn't be read. (Log the converter's error instead of storing it.) |

`userMessage` (`workflows/steps.ts:27`) also ends every stored message with a full stop.

Three tests assert on this wording and need updating: `test/integration/tailor.test.ts:128`, `test/integration/tailor.test.ts:155` and `test/integration/vault.test.ts:151`. Error codes are parsed from the code prefix, not from the wording, so nothing else depends on the text.

## PR 8. API additions

**8a. Why a line was repaired or replaced**

- **`src/grounding/claims.ts`.** Return structured problems next to today's strings, which still feed the repair prompt:
  - `{ kind: "numbers" | "names", values }`
  - `{ kind: "scope", claimed, allowed }`
  - `checkLine` adds `{ kind: "citation" }` for a line that cites no facts, a fact outside the selection, or a fact from another role.
  - A rejection by the judge is `{ kind: "judge" }`, with no text.
- **`src/pipeline/tailor.ts`.** When a line ends up repaired or replaced, carry the first finding from round 1 onto it. `toLine` (line 231) copies it.
- **`src/shared/api.ts`.** Add `ResumeLine.finding?: LineFinding`. It's stored inside the `resumes.body` JSON, so no migration is needed. Older resumes have no finding.
- **`src/vault/vault.ts`, `editLine`.** Clear `finding` when the person edits the line.
- **`src/web/format.ts`.** `findingSentence(finding)` produces one of:
  - "The draft said 40%. Your facts don't include that number."
  - "The draft named Kafka. Your facts don't mention it."
  - "The draft said Led. Your fact says Implemented."
  - "The draft cited a fact it couldn't use for this line."
  - "The check found wording its facts don't support."
- **Why typed.** The judge's reason is model text about a draft that was written with the job description in view, and the job description is untrusted input. Keeping that text off the screen means every sentence in the margin is Resumatic's own.

**8b. Quote context.** Dropped: PR #2's `SourceEvidence` already shows each quote in its source (finding 1).

**8c. Duplicate uploads**

- **Migration 2.** `ALTER TABLE sources ADD COLUMN sha256 TEXT`, plus an index.
- **`src/worker/routes.ts` (`POST /api/sources`).** Hash the bytes the route already reads for R2 (`crypto.subtle.digest`). Ask the vault about the hash before writing to R2, then pass it to `addSource`.
- **`vault.addSource`.** If a source with the same hash exists and didn't fail, answer `conflict` with "You've already uploaded jane-doe.pdf." A failed upload doesn't block a retry, because its failure message tells people to try again.
- **Tests:**
  - Vary the bytes per upload in `test/integration/vault.test.ts:70`.
  - Add "refuses a second copy of the same file".
  - Add "accepts a file again after it failed to read".
  - Add a migration test that runs `migrate()` on a version-1 schema.

## PR 9. Docs and outside the app

- **`docs/beta/invite-email.md`.** Add the lockup, and send the email from the support address.
- **`docs/diagrams/*.svg` (12 files).** Recolor them in `ink`, `rule` and `ballpoint`, if they're shown outside the team.
- **The design system.** Correct "Changes to the app" with findings 1, 2, 6 and 8, and change `.rs-sheet` to the scaled Letter page from PR 5. This can happen at any point.

## Checking the work

- **Every PR:** typecheck, tests and build. The web tests cover behavior.
- **Screens.** Check them in a headless browser against `vite dev`, with `/api/*` answered from the web test fixtures. Capture light and dark at 1280 px and 390 px. The screenshots go in the PR description next to the artboards. A committed script and a CI job can follow once the screens settle.
- **Keyboard and screen reader passes** on Facts and Resume, with VoiceOver and NVDA. Every action must be reachable, and decisions and saves must be announced.
- **Staging.** After each merge, staging deploys and `e2e:staging` runs, as it does today.
- **Bundle size.** Each PR description reports bundle sizes against the baseline.

## Definition of done

- Every item in the design system's "Changes to the app" has shipped, or is listed under Deferred with a reason.
- `src/web/styles.css` is gone. The app's styles are tokens, fonts, type, components and app layout.
- CI is green, including the web project and the contrast test.
- Every screen matches its artboard in light and dark, at 1280 px and 390 px.
- Facts and Resume work from the keyboard alone, and shortcuts never fire while someone is typing.
- The sheet in the app and Print preview show the same content in the same order, and a profile edit changes the PDF.
- No server message that reaches a person is a lowercase fragment.
- Client JS stays within about 10 kB (gzipped) of the baseline's 104.2 kB, and fonts load only when they're used.

## Deferred

- **The "Landing page" artboard.** The app has no public marketing page yet.
- **Storing a gap question with its answer as an interview source.** The design doc's §5 marks this as later.
- **Backfilling quote context** for evidence saved before PR 8.
- **Visual regression tests in CI.**

## Appendix: where copied files come from

| Repo file | Source |
| --- | --- |
| `src/web/styles/tokens.css` | Design system, `project/tokens.css` (custom properties only) |
| `src/web/styles/type.css` | Design system, `project/tokens.css` (type classes) |
| `src/web/styles/components.css` | Design system, `project/components/bundle.css` |
| `src/web/fonts/*.woff2` | `@fontsource-variable/schibsted-grotesk` 5.3.0 and `@fontsource-variable/newsreader` 5.3.0, latin and latin-ext |
| `src/web/components/Lockup.tsx` | Design system, `project/assets/Logos/resumatic-lockup-ink.svg` and `resumatic-mark-ink.svg` |
| `public/favicon.svg` | Design system, `project/assets/Logos/resumatic-app-icon.svg` |
| Markup | The prototype artboards: Sign in; Facts, first run; Facts, review queue; Jobs; Tailoring; Tailored resume and its margin; Close a gap; Account; Edge states; Phone: review queue; Phone: a line's evidence |
