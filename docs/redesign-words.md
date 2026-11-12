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

Server messages, stored messages (shown through `sourceErrorMessage`, `resumeErrorMessage` and `typeset(asSentence())`) and the legal pages are unchanged. So is every earlier word outside an edited sentence: posting, snapshot, card, application and sensitive.

### Deferred interface labels

The interface's own labels that keep an earlier word, each with the stage that renames it. `test/web/words.test.tsx` fails if a label on Facts, Jobs, a resume, Account or a shared copy uses one of these words and isn't listed in its `DEFERRED`, and it fails if an entry there isn't listed here.

| Label | Where | Stage |
| --- | --- | --- |
| “Sensitive” | FactItem's mark | 4, facts: becomes private, with the privacy notice |
| “Sensitive fact” | the margin and the skill list on a resume | 4, facts |
| “Mark sensitive” | SensitiveControl | 4, facts |
| “Unmark sensitive” | SensitiveControl | 4, facts |
| “The posting” | JobPosting's heading | 5, jobs: posting becomes job description |
| “Read the posting” | JobPosting | 5, jobs |
| “Hide the posting” | JobPosting | 5, jobs |
| “Open the original posting” | JobPosting | 5, jobs |
| “Original posting” | the job row on Jobs | 5, jobs |
| “Link to the posting” | JobPosting and the add-a-job form | 5, jobs |
| “Paste the whole posting, including the requirements.” | the add-a-job form's hint | 5, jobs |
| “Track this application” | ApplicationWorkspace | 5, jobs: application becomes job |
| “Prepare your application” | Documents | 5, jobs |
| “Application kit” | ApplicationKit | 5, jobs |
| “Card preview” | CardPreview on Account | 6, sharing and account: card becomes anonymous profile |
| “Shared career snapshot” | ShareSnapshotContent | 7, outside: snapshot becomes shared copy |

Sentences that hold one of these words and none of stage 1's five nouns are unchanged as well, such as the sensitive notices on a resume and the posting reader's messages on Jobs. Their room's stage changes them with the labels.

## 3. Server text a person can reach

**Candidates.** Every `AppError(code, message)` in `src/worker`, `src/vault`, `src/shared`, `src/workflows`, `src/pipeline` and `src/ai`, with the messages held in constants; `SAFE_DETAILS` and `GENERIC_DETAIL` (`src/workflows/steps.ts`); `FALLBACK_WORDS` and `SIGN_IN_WORDS` (`src/web/errors.ts`) and `NOT_FINISHED` and `EARLIER` (`src/web/source-error.ts`); the HTML the Worker writes; and the email notices and the invite.

**Qualifies** if it contains, as a whole word, an earlier term: vault, source(s), evidence, citation, proof, proposed, pending, approved, rejected or reject, kept, repaired, replaced, dropped, “own claim”, manual, sensitive, application(s), posting(s), generate or generation, bullet(s), snapshot(s), grant(s), card, listing, trial, output(s), credit(s), gap(s), entry, position, quota, or review as the state. “Document” and “upload” qualify only as nouns for the person's file.

**Reach.** An `AppError` reaches a person when all three hold:

1. Its status is 403, 404, 409, 413, 422 or 429. A 401 or 410 under `/api` signs the person out, and a 503 shows the fallback. `/share`'s gone sentence is included.
2. A route that `api.ts`, `/share` or `/auth/callback` calls can throw it, or it is a stored workflow detail (`SAFE_DETAILS`).
3. No caller replaces it with its own `words`.

HTML pages and emails always reach a person.

**Room** is that of the screen that shows it: facts (files, uploads, paste, roles, facts, review, sensitive); jobs (jobs, postings, tailoring, resumes, documents, kits, answers, fit); sharing/account (shares and the owner's side of comments and suggestions, connected apps and the consent page, card preview, email notices, profile, preferences, billing, export, deletion); outside (`/share`, sign-in, the coach workspace, the invite).

**Proposed sentences** are fixed, in the voice, with the full new words. A proposal that says “private” ships with stage 4 or after it. None changes in stage 1.

### `AppError` messages

| File:line at 78502c9 | Code | Current text | Proposed sentence | Room |
| --- | --- | --- | --- | --- |
| `src/vault/checkout.ts:174` | conflict | finish cancelling the pending checkout first | Cancel the checkout you started first, then try again. | sharing/account |
| `src/vault/legacy-remediation.ts:39` | conflict | the checked line is missing its evidence | A checked line no longer shows where it came from. Check that line again. | jobs |
| `src/vault/refinement-evidence.ts:15` | conflict | the resume or its supporting evidence changed; generate a new resume or choose different facts | The resume or the facts behind it changed. Tailor a new resume, or choose different facts. | jobs |
| `src/vault/runs.ts:161` | quota | the output allowance for this period is exhausted | You’ve used all your documents for this period. More arrive when your allowance renews. | jobs |
| `src/vault/shares.ts:133` | invalid | A fact marked sensitive can't be shared. Unmark it, or leave it out. | A fact you keep private can’t be shared. Leave it out, or stop keeping it private. | sharing/account |
| `src/vault/shares.ts:219` | too_large | share snapshot is too large | This shared copy is too large. Choose fewer facts, resumes or documents, then try again. | sharing/account |
| `src/vault/shares.ts:343` | too_large | share snapshot is too large | This shared copy is too large. Choose fewer facts, resumes or documents, then try again. | sharing/account |
| `src/vault/snapshots.ts:68` | conflict | fact evidence is incomplete; generate the resume again | Where a fact came from is incomplete. Tailor the resume again. | jobs |
| `src/vault/snapshots.ts:86` | conflict | role evidence is incomplete; generate the resume again | Where a role came from is incomplete. Tailor the resume again. | jobs |
| `src/vault/snapshots.ts:186` | conflict | This version uses a fact you marked sensitive. Remove those lines or tailor a new version, then try again. | This version uses a fact you keep private. Remove those lines or tailor a new version, then try again. | jobs |
| `src/vault/snapshots.ts:206` | conflict | experience requires review; generate the document again | Some of your experience still needs checking. Make the document again. | jobs |
| `src/vault/snapshots.ts:225` | conflict | experience requires review; generate the document again | Some of your experience still needs checking. Make the document again. | jobs |
| `src/vault/snapshots.ts:239` | conflict | experience requires review; generate the document again | Some of your experience still needs checking. Make the document again. | jobs |
| `src/vault/snapshots.ts:345` | conflict | a role changed while this draft was being made; generate it again | A role changed while this draft was being made. Make it again. | jobs |
| `src/vault/uploads.ts:97` | conflict | this upload expired; start a new upload (a file; a paste says “This text wasn’t added.”) | This file wasn’t added. Upload it again. | facts |
| `src/vault/uploads.ts:126` | not_found | no such original source | The original file can’t be found. It may have been deleted. | facts |
| `src/vault/uploads.ts:139` | conflict | Resumatic is still reading your other sources. Wait for one to finish, then add this text. / … then upload this file. | Resumatic is still reading your other files. Wait for one to finish, then add this text. / … then upload this file. | facts |
| `src/vault/uploads.ts:146` | quota | You can keep up to ${this.options.maxSources} sources during the beta. Email support@resumatic.app if you need more. | You can keep up to {n} files during the beta. Email support@resumatic.app if you need more. | facts |
| `src/vault/uploads.ts:187` | conflict | this upload expired; start a new upload (a file; a paste says “This text wasn’t added.”) | This file wasn’t added. Upload it again. | facts |
| `src/vault/vault.ts:1244` | not_found | no such application | This job can’t be found. It may have been deleted. | jobs |
| `src/vault/vault.ts:1675` | conflict | Resumatic is still reading your other sources. Wait for one to finish, then upload this file. | Resumatic is still reading your other files. Wait for one to finish, then upload this file. | facts |
| `src/vault/vault.ts:1680` | quota | You can keep up to ${MAX_SOURCES} sources during the beta. Email support@resumatic.app if you need more. | You can keep up to {n} files during the beta. Email support@resumatic.app if you need more. | facts |
| `src/vault/vault.ts:1856` | conflict | this source has not been read yet | This file hasn’t been read yet. Wait for it to finish, then try again. | facts |
| `src/vault/vault.ts:1868` | invalid | source has not been converted yet | This file hasn’t been read yet. Wait for it to finish, then try again. | facts |
| `src/vault/vault.ts:3095` | invalid | enter the posting's web address, starting with https:// | Enter the job’s web address, starting with https://. | jobs |
| `src/vault/vault.ts:3147` | not_found | no such application | This job can’t be found. It may have been deleted. | jobs |
| `src/vault/vault.ts:3167` | not_found | no such application | This job can’t be found. It may have been deleted. | jobs |
| `src/vault/vault.ts:3247` | not_found | no such application | This job can’t be found. It may have been deleted. | jobs |
| `src/vault/vault.ts:3391` | conflict | this resume is already in review | This resume is already being checked line by line. | jobs |
| `src/vault/vault.ts:3395` | conflict | this resume does not need grounding review | This resume doesn’t need a line-by-line check. | jobs |
| `src/vault/vault.ts:3431` | conflict | only a review version can remove a line | Only a version being checked line by line can remove a line. | jobs |
| `src/vault/vault.ts:3434` | conflict | the review line is missing or ambiguous | That line can’t be found in this version. Refresh the resume, then try again. | jobs |
| `src/vault/vault.ts:3473` | conflict | only a review version can remove a section | Only a version being checked line by line can remove a section. | jobs |
| `src/vault/vault.ts:3477` | conflict | the review section is missing or invalid | That section can’t be found in this version. Refresh the resume, then try again. | jobs |
| `src/vault/vault.ts:3511` | conflict | only a review version can remove a skill | Only a version being checked line by line can remove a skill. | jobs |
| `src/vault/vault.ts:3514` | conflict | the review skill is missing | That skill can’t be found in this version. Refresh the resume, then try again. | jobs |
| `src/vault/vault.ts:4172` | invalid | select confirmed facts from your vault | Choose confirmed facts from your record. | sharing/account |
| `src/vault/vault.ts:4201` | invalid | select finished cover letters or interview preparation from your vault | Choose finished cover letters or interview preparation from your record. | sharing/account |
| `src/vault/vault.ts:4561` | not_found | no such application | This job can’t be found. It may have been deleted. | jobs |
| `src/vault/vault.ts:4566` | conflict | the application changed; refresh and try again | This job changed. Refresh the page, then try again. | jobs |
| `src/vault/vault.ts:4571` | invalid | enter the posting's web address, starting with https:// | Enter the job’s web address, starting with https://. | jobs |
| `src/vault/vault.ts:4581` | conflict | Work on this job is still in progress. Wait for it to finish, then change the posting. | Work on this job is still in progress. Wait for it to finish, then change the job description. | jobs |
| `src/vault/vault.ts:4648` | not_found | no such application | This job can’t be found. It may have been deleted. | jobs |
| `src/vault/vault.ts:4673` | invalid | the resume is not ready for this application | This resume isn’t ready for this job yet. | jobs |
| `src/vault/vault.ts:4696` | invalid | Choose facts that aren't marked sensitive. | Choose facts you don’t keep private. | jobs |
| `src/vault/vault.ts:4700` | conflict | This version uses a fact you marked sensitive. Remove those lines or tailor a new version, then try again. | This version uses a fact you keep private. Remove those lines or tailor a new version, then try again. | jobs |
| `src/vault/vault.ts:5171` | too_large | Your vault has too many files for one archive. Download the JSON and the original files one at a time. | Your record has too many files for one archive. Download the JSON and your files one at a time. | sharing/account |
| `src/vault/vault.ts:5187` | too_large | Your vault is too large for one archive. Download the JSON and the original files one at a time. | Your record is too large for one archive. Download the JSON and your files one at a time. | sharing/account |
| `src/vault/vault.ts:6358` | conflict | this source already has a newer run | This file is already being read again. | facts |
| `src/vault/vault.ts:6368` | conflict | extraction is already committed for this source | This file has already been read. | facts |
| `src/vault/vault.ts:6379` | conflict | wait for other uploads to finish | Wait for your other files to finish reading, then try again. | facts |
| `src/vault/vault.ts:6914` | conflict | this source is no longer being read | This file is no longer being read. | facts |
| `src/vault/vault.ts:6949` | not_found | no such source | This file can’t be found. It may have been deleted. | facts |
| `src/vault/vault.ts:7010` | invalid | That role was rejected. Choose another role for this fact. | That role was left out. Choose another role for this fact. | facts |
| `src/worker/routes.ts:1220` | conflict | An original file is missing from your vault. Download the JSON and the available files one at a time. | A file is missing from your record. Download the JSON and the files that are there one at a time. | sharing/account |
| `src/worker/routes.ts:1223` | too_large | Your vault is too large for one archive. Download the JSON and the original files one at a time. | Your record is too large for one archive. Download the JSON and your files one at a time. | sharing/account |
| `src/workflows/distill.ts:147` | conflict | The import source changed. Upload it again. | The file changed while it was being read. Upload it again. | facts |

### Messages held in constants

| Defined and thrown | Code | Current text | Proposed sentence | Room |
| --- | --- | --- | --- | --- |
| `src/shared/kit.ts:440, thrown at src/vault/vault.ts:1010, 1122, 1138, 1142, 1197` | conflict | This application kit was changed somewhere else. Load it again, check it, then try again. | This job’s kit was changed somewhere else. Load it again, check it, then try again. | jobs |
| `src/shared/kit.ts:445, thrown at src/vault/vault.ts:1378, and through KIT_PROBLEMS at 1201 and 1222` | conflict | This resume version can't go in a kit: it uses a fact you've marked sensitive, or a line its facts don't back. Choose another version. | This resume version can’t go in a kit: it uses a fact you keep private, or a line its facts don’t back. Choose another version. | jobs |
| `src/shared/kit.ts:450, thrown at src/vault/vault.ts:1143, and through KIT_PROBLEMS at 1201 and 1222` | invalid | This question asks about something whose answer is never saved. Type your answer for this application only. | This question asks about something whose answer is never saved. Type your answer for this job only. | jobs |
| `src/shared/kit.ts:451, thrown at src/vault/vault.ts:1218` | conflict | Approve this application kit before downloading it. | Approve this kit before downloading it. | jobs |
| `src/shared/kit.ts:452, thrown at src/worker/routes.ts:1512` | conflict | This application kit changed while it was being prepared. Check it, then download it again. | This kit changed while it was being prepared. Check it, then download it again. | jobs |

### `/share`'s gone sentence

`SharePage` shows its own fixed sentences for an unavailable link today, so these are listed because a person can reach the response, not because the page shows it.

| File:line at 78502c9 | Code | Current text | Proposed sentence | Room |
| --- | --- | --- | --- | --- |
| `src/worker/shares.ts:14, src/worker/routes.ts:1774 and 1805, src/vault/shares.ts:440, 486, 501 and 569` | gone (410 under /share) | this share link is unavailable or expired | This link has expired or been turned off. Ask the person who sent it for a new one. | outside |
| `src/worker/shares.ts:66` | gone (410 under /share) | this share link has expired | This link has expired. Ask the person who sent it for a new one. | outside |

### Workflow details, fallbacks and stored messages

- **`SAFE_DETAILS`** (`src/workflows/steps.ts:33`). One qualifies: “The import source changed. Upload it again.”, thrown at `src/workflows/distill.ts:147` and listed in the table above (facts). The others use no earlier word in the sense above (“review again” is the verb).
- **`GENERIC_DETAIL`** (`src/workflows/steps.ts:48`). None qualifies.
- **`FALLBACK_WORDS`** and **`SIGN_IN_WORDS`** (`src/web/errors.ts`). None qualifies.
- **`NOT_FINISHED`** and **`EARLIER`** (`src/web/source-error.ts`). None qualifies.

### HTML the Worker writes

| Where | Current text | Proposed text | Room |
| --- | --- | --- | --- |
| `src/worker/mcp.ts:244` `consentPage` | The app can read your confirmed facts and finished resumes. Original uploads, evidence quotes, private application notes and facts you've marked sensitive are excluded. You can revoke access in Account. | The app can read your confirmed facts and finished resumes. Your files, the words your facts came from, your notes on jobs and the facts you keep private are left out. You can turn off its access under Account. | sharing/account, with or after stage 4 |
| `src/worker/mcp.ts:244` `consentPage` | Read confirmed facts and finished resumes | Read your confirmed facts and finished resumes | sharing/account |
| `src/worker/mcp.ts:235` `consentPage` | Generate resumes using my plan quota, and check my fit for the saved jobs it can see | Tailor resumes, counted as documents in my plan, and check my fit for the saved jobs it can see | sharing/account |
| `src/worker/mcp.ts:280` the connect sign-in page | Sign in to connect an app; Continue with Google | No earlier word. It takes the plain identity's lockup and type with the sign-in sheet. | outside |

### Email

| Where | Current text | Proposed text | Room |
| --- | --- | --- | --- |
| `src/shared/email-notices.ts:79` `noticeMessage`, subject | Facts are waiting for your review in Resumatic | Facts are waiting for you to check in Resumatic | sharing/account |
| `src/shared/email-notices.ts:80` `noticeMessage`, body | Some facts Resumatic read for you have been waiting for your review for 3 days or more. Sign in to review them: … | Some facts Resumatic found for you have been waiting for you to check them for 3 days or more. Sign in to check them: … | sharing/account |
| `src/shared/email-notices.ts:69–75` `noticeMessage`, the comment and suggestion notices | A coach has left a new comment on a copy you shared. / A coach has suggested new wording for a line in a copy you shared. | No earlier word. | sharing/account |
| `src/shared/email-notices.ts:62` `FOOTER` | You get this email because you turned on email notices in Resumatic. To stop them, turn them off under Account. | No earlier word. | sharing/account |
| `docs/beta/invite-email.md`, step 2 | Resumatic reads it and proposes roles and facts, each shown next to the exact words it came from. | Resumatic reads it and finds roles and facts for you to check, each shown next to the exact words it came from. | outside |
| `docs/beta/invite-email.md`, step 3 | Confirm the facts that are true, edit the ones that are nearly right, and reject the rest. | Say “That’s right” to the facts that are true, fix the ones that are nearly right, and leave out the rest. | outside |
| `docs/beta/invite-email.md`, step 4 | … and lists the job's requirements your facts don't cover. | … and lists what the job asks for that your record doesn’t show. | outside |
| `docs/beta/invite-email.md`, step 5 | Read the resume, check any line's evidence in the margin, and download the PDF. | Read the resume, see where any line came from beside the page, and download the PDF. | outside |
| `docs/beta/invite-email.md`, your data | Your career data is kept in its own database, separate from every other user's. | Your record is kept in its own database, separate from everyone else’s. | outside |
| `docs/beta/invite-email.md`, during the beta | During the beta you can tailor [20] resumes a month. | During the beta you get [20] documents a month: each tailored resume, cover letter or interview preparation is one. | outside |
| `docs/beta/invite-email.md` and `public/email/resumatic-lockup.png` | The turnstile lockup | The green tile and the wordmark, redrawn from the system's `resumatic-lockup.svg` | outside |

## 4. Not shown to people, and why

Of the 208 `AppError` messages that use an earlier term, 57 are in the table above. The rest, by why a person never reads them:

| Category | Count | Why |
| --- | --- | --- |
| 5xx | 46 | A 503 shows the client's fallback (“Resumatic is busy right now…”), never the server's words. |
| sign-out codes | 3 | A 410 under `/api` signs the person out with the session note; a 401 does the same. |
| internal guard | 34 | A check on the server's own state or on a request the web app never sends: an upload's reserved key, digest or path, a store's own limits, a vault that isn't the caller's, a deletion step out of order, an idempotency key reused with other input. |
| workflow detail | 16 | Thrown inside a Workflow step. `SAFE_DETAILS` doesn't list it, so the run stores `GENERIC_DETAIL` instead. |
| transfer | 8 | Fenced vault replacement (`VaultOperations`, `finishImport`), run by an operator. |
| maintenance | 5 | Maintenance routes, fleet re-embedding and the maintenance fence. |
| admin | 1 | The pilot's identity probe, an operator tool. |
| MCP run() replacement | 2 | A connected app's tool call: `run` in `src/worker/mcp.ts` turns every failure into one of two fixed sentences. |
| OAuthError descriptions | 1 | Sent to the connecting app during OAuth, not shown by Resumatic. The four `OAuthError` descriptions in `src/worker/mcp.ts` use no earlier word. |
| replaced by caller words | 1 | The posting reader's `invalid` is replaced by the words `JobsPage` passes. |
| (no earlier word in this sense) | 34 | The term appears only in another sense: “upload” or “review” as a verb, or “document” for a letter or interview preparation. |
| `renderResumeHtml` | 1 | The resume itself (`src/render/template.ts`), printed from the person's own words: not interface words. |

The quota sentence for tailoring (`src/vault/vault.ts:3280`) counts “tailored resumes”, which isn't on the list of terms; the client replaces it with `quotaMessage` (`src/web/tailor.ts`), which stage 1 changed to documents.
