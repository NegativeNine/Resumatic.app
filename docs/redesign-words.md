# Redesign words: what each thing is called, and where earlier words remain

Stage 1 of the second redesign (`redesign/01-identity`) moved the web app to the plain words of the design system's voice and writing guide. This file is the record of that change. It lists the words, what stage 1 changed, the interface labels that keep an earlier word until their room's stage, and every message the server writes that a person can reach and that still uses an earlier word. Line numbers are at `78502c9`, the base of stage 1.

Each room stage changes the server messages its screens show, as assigned below, updates the tests that pin them, and removes its rows here and its entries from `DEFERRED` in `test/web/words.test.tsx`.

## 1. The words

From voice and writing (design system Resumatic, version 1794444170-a305). One name per thing, everywhere.

| Earlier word | New word | Notes |
| --- | --- | --- |
| data point, item, bullet | fact | One true thing: something done, a skill, a credential. |
| position, entry | role | A job, degree, project or volunteering. |
| vault, profile, account data | your record | Everything Resumatic holds for a person. “Profile” is only the contact details at the top of a resume. |
| source, document, upload (as a noun) | file, your files | What the person uploaded. “Upload” is the verb. |
| evidence, citation, proof (as a label) | where it came from | The words in a file that a fact rests on. The control reads “See where this came from”. |
| Proposed, pending, approved, Rejected | To check, Confirmed, Left out | The states of a fact, exactly. |
| Confirm, Edit, Reject | That’s right, Fix it, Leave it out | The answers to “Is this right?” |
| your own claim, manual, custom | Added by you | A fact the person wrote or changed. |
| sensitive | private, Keep private | A fact that is never on a resume and never shared. |
| application, posting, req | job | “Job description” for the pasted text. |
| generate, optimise, rewrite | tailor, tailored resume | “Tailor a resume”, “Tailoring…”. |
| bullet, sentence | line | One line on the resume. |
| Kept, Repaired, Replaced, Dropped, Edited | Backed, Corrected, Your wording, Left out, Edited by you | What the check did. Say “backed” once for the whole resume, and mark only the lines that differ. |
| gaps, missing skills, weaknesses | not in your record, what’s missing | What a job asks for that the record doesn’t show. |
| match score, ATS score | fit | “Your record covers 5 of the 7 things this job asks for.” A count, never a percentage. |
| output, generation, credit | document | What a plan counts: one finished resume, letter or interview preparation. |
| trial | 30-day pass | A plan that ends by itself. |
| snapshot, grant | shared copy | What a coach reads. |
| card, listing | anonymous profile | What a recruiter sees before a person says yes. |

“Verified” is reserved: only for facts checked against an outside source, never for confirmed facts.

## 2. What stage 1 changed in `src/web`

- **States and answers.** `STATE_LABEL` reads To check, Confirmed and Left out. The review buttons read That’s right, Fix it and Leave it out, for a role as for a fact (the role is named by `aria-describedby`), with the keys Y, F and L, and J and K for next and previous. A role asks “Leave out {org} and its {n} facts still to check?” before it leaves them out.
- **What the check did.** `LINE_STATUS_LABEL` reads Backed, Corrected, Your wording and Edited by you, with “Left out” for a dropped line; `LINE_STATUS_HINT` and `findingSentence` say “your record” where they said “your facts”.
- **Kinds of fact.** `FACT_KIND_LABEL` reads Something you did, A skill and A credential.
- **Five nouns, in labels and in the sentences that hold them.** “Source” meaning the person's file became file or your files (“Your files”, “Add a file”, “Download original”, “See this quote in its file”). “Vault” became your record (the export rows and the delete warning on Account, the preferences and saved answers notes). “Evidence” became where it came from (“Show where each line came from”, “Hide where it came from”, “Where these sentences came from”). “Gap” became what may be missing (“What may be missing, as found when this draft was made”, “Not in your record”). “Output” became document (the quota meter, the plan, the quota errors written by the client, and every line check, which “counts toward your documents for this period”).
- **Added by you.** A fact the person wrote or changed is marked Added by you, in its mark, its editor's note, the add-a-fact and add-a-role notes, and the margin and document notes (“Added by you, with no quote from a file.”).
- **Other labels with an earlier control name.** The saved answer and kit question buttons that read “Edit” read “Change”, because “Edit” is now the earlier word for Fix it.

Stage 4 named a fact the person keeps to themselves private in every label and sentence (Keep private, Stop keeping it private, Private, Private fact); stored and API names stay `sensitive`.

Server messages, stored messages (shown through `sourceErrorMessage`, `resumeErrorMessage` and `typeset(asSentence())`) and the legal pages are unchanged. So is every earlier word outside an edited sentence: posting, snapshot, card, application and sensitive.

### Deferred interface labels

The interface's own labels that keep an earlier word, each with the stage that renames it. `test/web/words.test.tsx` fails if a label on Facts, Jobs, a resume, Account, Sharing or a shared copy uses one of these words and isn't listed in its `DEFERRED`, and it fails if an entry there isn't listed here.

| Label | Where | Stage |
| --- | --- | --- |
| “Shared career snapshot” | ShareSnapshotContent | 7, outside: snapshot becomes shared copy |

Sentences that hold one of these words and none of stage 1's five nouns are unchanged as well, such as the sensitive notices on a resume. Their room's stage changes them with the labels. Stage 5 renamed the Jobs room's labels and the posting reader's messages, and took its rows out of this list.

## 3. Server text a person can reach

**Candidates.** Every `AppError(code, message)` in `src/worker`, `src/vault`, `src/shared`, `src/workflows`, `src/pipeline` and `src/ai`, with the messages held in constants; `SAFE_DETAILS` and `GENERIC_DETAIL` (`src/workflows/steps.ts`); `FALLBACK_WORDS` and `SIGN_IN_WORDS` (`src/web/errors.ts`) and `NOT_FINISHED` and `EARLIER` (`src/web/source-error.ts`); the HTML the Worker writes; and the email notices and the invite.

**Qualifies** if it contains, as a whole word, an earlier term: vault, source(s), evidence, citation, proof, proposed, pending, approved, rejected or reject, kept, repaired, replaced, dropped, “own claim”, manual, sensitive, application(s), posting(s), generate or generation, bullet(s), snapshot(s), grant(s), card, listing, trial, output(s), credit(s), gap(s), entry, position, quota, or review as the state. “Document” and “upload” qualify only as nouns for the person's file.

**Reach.** An `AppError` reaches a person when all three hold:

1. Its status is 403, 404, 409, 413, 422 or 429. A 401 or 410 under `/api` signs the person out, and a 503 shows the fallback. `/share`'s gone sentence is included.
2. A route that `api.ts`, `/share` or `/auth/callback` calls can throw it, or it is a stored workflow detail (`SAFE_DETAILS`).
3. No caller replaces it with its own `words`.

HTML pages and emails always reach a person.

**Room** is that of the screen that shows it: facts (files, uploads, paste, roles, facts, review, sensitive); jobs (jobs, postings, tailoring, resumes, documents, kits, answers, fit); sharing/account (shares and the owner's side of comments and suggestions, connected apps and the consent page, card preview, email notices, profile, preferences, billing, export, deletion); outside (`/share`, sign-in, the coach workspace, the invite).

**Proposed sentences** are fixed, in the voice, with the full new words. A proposal that says “private” ships with stage 4 or after it. None changes in stage 1. Stage 5 changed every message assigned to jobs and took those rows out of the tables below; the counts in section 4 are as they were at 78502c9.

No server message is assigned to Today. Its first run shows the facts room’s upload and paste messages, which stage 4 changes.

**Shipped.** Each room stage removes its rows below once it has changed them. Stage 6 (sharing and account) changed every sharing/account row: the share, export, checkout and suggestion messages, the consent page and the reminder email, with the archive's three sentences now constants in `src/render/archive.ts`. Its rows that needed no change (the comment and suggestion notices and the email footer) are gone too. The counts in section 4 are as they stood at `78502c9`.

### `AppError` messages

| File:line at 78502c9 | Code | Current text | Proposed sentence | Room |
| --- | --- | --- | --- | --- |

### Messages held in constants

| Defined and thrown | Code | Current text | Proposed sentence | Room |
| --- | --- | --- | --- | --- |

### `/share`'s gone sentence

`SharePage` shows its own fixed sentences for an unavailable link today, so these are listed because a person can reach the response, not because the page shows it.

| File:line at 78502c9 | Code | Current text | Proposed sentence | Room |
| --- | --- | --- | --- | --- |
| `src/worker/shares.ts:14, src/worker/routes.ts:1774 and 1805, src/vault/shares.ts:440, 486, 501 and 569` | gone (410 under /share) | this share link is unavailable or expired | This link has expired or been turned off. Ask the person who sent it for a new one. | outside |
| `src/worker/shares.ts:66` | gone (410 under /share) | this share link has expired | This link has expired. Ask the person who sent it for a new one. | outside |

### Workflow details, fallbacks and stored messages

- **`SAFE_DETAILS`** (`src/workflows/steps.ts:33`). One qualified: “The import source changed. Upload it again.”, thrown at `src/workflows/distill.ts:147`. Stage 4 changed it to “The file changed while it was being read. Upload it again.” The old import sentence stays one release for runs in flight; EARLIER rewords it. The others use no earlier word in the sense above (“review again” is the verb).
- **`GENERIC_DETAIL`** (`src/workflows/steps.ts:48`). None qualifies.
- **`FALLBACK_WORDS`** and **`SIGN_IN_WORDS`** (`src/web/errors.ts`). None qualifies.
- **`NOT_FINISHED`** and **`EARLIER`** (`src/web/source-error.ts`). None qualifies.

### HTML the Worker writes

| Where | Current text | Proposed text | Room |
| --- | --- | --- | --- |
| `src/worker/mcp.ts:280` the connect sign-in page | Sign in to connect an app; Continue with Google | No earlier word. It takes the plain identity's lockup and type with the sign-in sheet. | outside |

### Email

| Where | Current text | Proposed text | Room |
| --- | --- | --- | --- |
| `docs/beta/invite-email.md`, step 2 | Resumatic reads it and proposes roles and facts, each shown next to the exact words it came from. | Resumatic reads it and finds roles and facts for you to check, each shown next to the exact words it came from. | outside |
| `docs/beta/invite-email.md`, step 3 | Confirm the facts that are true, edit the ones that are nearly right, and reject the rest. | Say “That’s right” to the facts that are true, fix the ones that are nearly right, and leave out the rest. | outside |
| `docs/beta/invite-email.md`, step 4 | … and lists the job's requirements your facts don't cover. | … and lists what the job asks for that your record doesn’t show. | outside |
| `docs/beta/invite-email.md`, step 5 | Read the resume, check any line's evidence in the margin, and download the PDF. | Read the resume, see where any line came from beside the page, and download the PDF. | outside |
| `docs/beta/invite-email.md`, your data | Your career data is kept in its own database, separate from every other user's. | Your record is kept in its own database, separate from everyone else’s. | outside |
| `docs/beta/invite-email.md`, during the beta | During the beta you can tailor [20] resumes a month. | During the beta you get [20] documents a month: each tailored resume, cover letter or interview preparation is one. | outside |
| `docs/beta/invite-email.md` and `public/email/resumatic-lockup.png` | The turnstile lockup | The green tile and the wordmark, redrawn from the system's `resumatic-lockup.svg` | outside |

## 4. Not shown to people, and why

**How this was counted.** Every `new AppError(code, message)` call site at 78502c9 in `src/worker`, `src/vault`, `src/shared`, `src/workflows`, `src/pipeline` and `src/ai`, tests left out: 814 sites. A site's message is read from its literal, or from the constant it names (both branches where it chooses between two); values interpolated into it are not read. A site is a candidate when its message holds one of the terms above as a whole word, taking “document”, “upload” and “review” in any sense: 217 sites. Two more sites, `src/vault/vault.ts:1201` and `1222`, throw a sentence looked up from `KIT_PROBLEMS`; they are listed under messages held in constants and are not in these counts.

The 217 candidates, each counted once:

| Where | Sites |
| --- | --- |
| The `AppError` table above, at `78502c9`: stages 4, 5 and 6 have since changed each of its rows and taken it out | 58 |
| The throw sites of the constants table (`src/vault/vault.ts:1010, 1122, 1138, 1142, 1143, 1197, 1218, 1378`, `src/worker/routes.ts:1512`) | 9 |
| The term in another sense only (below) | 29 |
| Never shown to a person (below) | 121 |
| **Total** | **217** |

**The term in another sense only (29).** “Upload” as a verb or an adjective, “review” as a verb or as an operator's review, and “document” for a cover letter or interview preparation, which is the new word's own sense: `src/worker/routes.ts:668, 672, 1316`; `src/vault/checkout.ts:157`; `src/vault/document-shares.ts:34`; `src/vault/legacy-remediation.ts:103`; `src/vault/shares.ts:116`; `src/vault/snapshots.ts:113`; `src/vault/vault.ts:1396, 2718, 2900, 3169, 3273, 3389, 3429, 3471, 3509, 3544, 3595, 3633, 3671, 4666, 4777, 5107, 6067`; `src/workflows/distill.ts:69, 137`; `src/pipeline/distill.ts:30`; `src/pipeline/extract/verify.ts:242`.

**Never shown to a person (121),** by why:

| Category | Count | Why | Sites |
| --- | --- | --- | --- |
| 5xx | 48 | A 503 shows the client's fallback (“Resumatic is busy right now…”), never the server's words. | `src/worker/billing.ts:343, 408, 575, 582, 599, 606, 619, 622, 631, 668`; `src/worker/deletion-fences.ts:55`; `src/worker/routes.ts:357, 836, 1030, 1214`; `src/vault/checkout.ts:48, 89, 94, 145, 221`; `src/vault/vault.ts:447, 475, 646, 821, 1587, 1593, 5161, 5174, 5178, 5578, 5593, 5622, 5637, 5646, 5920, 5926, 5928, 5932, 5962, 5971, 5974, 5986, 6219, 6607, 6609, 6614, 6617`; `src/pipeline/card.ts:43` |
| internal guard | 37 | A check on the server's own state or on a request the web app never sends: an upload's reserved key, digest or path, a store's own limits, a vault that isn't the caller's, a deletion step out of order, an idempotency key reused with other input, image reading for a file that isn't a PDF (`SourceList` offers it only for one). | `src/worker/routes.ts:662, 783, 1314, 2065`; `src/worker/shares.ts:40`; `src/vault/snapshots.ts:453`; `src/vault/uploads.ts:85, 115, 180, 193, 208, 246, 285, 322, 334, 366`; `src/vault/vault.ts:343, 419, 468, 496, 543, 598, 604, 637, 1516, 1522, 1524, 1535, 1565, 1663, 1667, 3253, 5727, 6242, 6243, 6310`; `src/shared/billing.ts:91` |
| workflow detail | 15 | Thrown inside a Workflow step. `SAFE_DETAILS` doesn't list it, so the run stores `GENERIC_DETAIL` instead. | `src/vault/tailor-publication.ts:21, 38`; `src/vault/vault.ts:2020, 2128, 2192, 2320, 2436, 2452, 2453, 2457, 2476, 2481, 3736`; `src/pipeline/documents.ts:168, 326` |
| transfer | 8 | Fenced vault replacement (`VaultOperations`, `finishImport`), run by an operator. | `src/vault/operations.ts:163, 168, 190, 341, 436, 714`; `src/vault/vault.ts:5554, 5588` |
| maintenance | 5 | Maintenance routes, fleet re-embedding and the maintenance fence. | `src/worker/maintenance.ts:32`; `src/vault/operations.ts:539, 721`; `src/shared/operations.ts:114`; `src/workflows/fleet.ts:70` |
| sign-out codes | 3 | A 410 under `/api` signs the person out with the session note; a 401 does the same. | `src/vault/vault.ts:412, 5424, 5706` |
| connected apps | 3 | A connected app's call: `run` in `src/worker/mcp.ts` turns every tool failure into one of two fixed sentences, and the token exchange answers with its own `OAuthError`. The grant the consent page builds is checked again in the vault. | `src/vault/mcp-grants.ts:76, 113`; `src/vault/vault.ts:4037` |
| admin | 1 | The pilot's identity probe, an operator tool. | `src/worker/pilot/ledger.ts:83` |
| replaced by caller words | 1 | The posting reader's `invalid` is replaced by the words `JobsPage` passes. | `src/worker/postings.ts:34` |

48 + 37 + 15 + 8 + 5 + 3 + 3 + 1 + 1 = 121.

**Outside these counts.** They are not `AppError` messages:

- The four `OAuthError` descriptions in `src/worker/mcp.ts` (:192, :205, :208, :215) go to the connecting app during OAuth and are not shown by Resumatic. None uses an earlier word.
- `renderResumeHtml` (`src/render/template.ts`) prints the resume itself from the person's own words. Its earlier words (“vault”, and “gap” as a CSS property) are in a code comment and its styles, never in its text.
- The quota sentence for tailoring (`src/vault/vault.ts:3280`) counts “tailored resumes”, which isn't on the list of terms (its only “quota” is the interpolated `quota.limit`); the client replaces it with `quotaMessage` (`src/web/tailor.ts`), which stage 1 changed to documents.
