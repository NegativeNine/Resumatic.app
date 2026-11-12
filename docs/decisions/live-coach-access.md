# Decision: live read-only access for a coach

**Waiting for: the owner, and counsel on the wording. Written on 11 November 2026 against `main` at `3d7c9fe`.**

## The question

May a coach the owner names read the owner's records as they are now, rather than a copy fixed when it was made? If so: read what (one job, or the whole vault), with or without the words each fact came from, for how long, ended how, and recorded how?

The brief for this memo says the scope the owner decided on 9 November includes live read-only access to one job or to the whole vault. That decision is not written down anywhere in the repository. This memo takes it as the starting point and asks the owner to confirm it, with the details below.

## Why it blocks what

Everything a coach reads today is a fixed copy, and the repository promises that in three places:

- The threat model's row "Coach receives future edits or private evidence" ([seeker-threat-model.md](../seeker-threat-model.md), line 27): "Vault loads fixed fact snapshots, exact resume versions and saved document versions; explicit field allowlist".
- Its coach limits ([seeker-threat-model.md](../seeker-threat-model.md), line 54): "A coach never gains access to subsequently created content", and a grant lasts "at most seven days".
- The privacy notice (`Privacy()` in `src/web/pages/LegalPage.tsx`, lines 127 and 130): "A link lasts seven days at most" and "The copy is fixed when you make it. Later changes to your facts and resumes don’t reach it." Those sentences are pinned by `test/web/legal.test.tsx`.

The code holds to it. `snapshotSelection` copies an explicit list of fields from confirmed facts when the copy is made (`src/vault/shares.ts`), and `ShareStore.read` rebuilds each resume and document from its saved version on every read and compares it exactly. A copy lasts at most seven days (`SHARE_TTL_MS` in `src/shared/sharing.ts`).

The system design always meant more: coaches get "a working view of a client's vault" (line 301), and grants are "scoped (whole vault read-only, or one application)" (line 933). Live access cannot be built without rewriting the three promises above, which is why it waits on this decision.

## What live access would show

| Item | One job | Whole vault | Recommendation |
| --- | --- | --- | --- |
| Confirmed facts and roles, in their own words | The facts cited by the job's resumes and documents, and their roles | All of them | Yes. Only facts `usableFacts()` allows, read at each request, so a fact marked sensitive disappears at once |
| The words a fact came from (its quote) | | | **No.** A fact's text is already its whole source line (`verifyExtraction`, as [taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md) describes, line 13). A quote can hold other people's names and hidden text an upload carried. Connected apps never receive quotes either ([seeker-threat-model.md](../seeker-threat-model.md), line 66) |
| Facts still proposed, not confirmed | | | No. They are a model's reading of an upload until the owner confirms them |
| Uploaded files and their text | | | No |
| The job's posting | Yes | Every saved job's | Yes, as text, marked as the employer's words |
| The job's status and date applied | Yes | Yes | Owner's choice, off by default. It says where someone is applying |
| The owner's notes on a job | | | No, as for connected apps |
| Resumes, cover letters, interview preparation | The job's | All | Yes, finished versions only, each passing the gate it passes to be shared today (`assertGroundedResume` in `src/vault/snapshots.ts`, `sharedDocument` in `src/vault/document-shares.ts`) |
| Fit previews | The job's | All | Not in the first version. The system design keeps fit previews with the candidate, so that tailoring stays outside the EU AI Act's employment annex (line 492); a copy never holds one today. **Counsel** says whether a coach may see them |
| Job preferences | | | No. Nothing reads them but their owner (`test/unit/preferences-reach.test.ts`) |
| Shadow parts, tags and offers | | | No. Shown to nobody ([record.md](../record.md)) |

## Options

1. **Keep fixed copies only.** No change. Coaches keep asking for a new link when something changes.
2. **Live access to one job.** The coach sees one saved job and what was made for it, as it is now.
3. **Live access to the whole vault.** The coach sees every confirmed fact and every job.
4. **Both, chosen per grant.** The owner picks one job or the whole vault each time.

## Recommendation

**Option 4, built as option 2 first.** One job is the common case for coaching, and it limits what a later change can expose. The whole vault follows once one job has run with real coaches.

| Rule | Proposal |
| --- | --- |
| Who | One coach account, named by sign-in address and bound to its account ID at take-up, exactly as a copy's coach is today (`openForCoach` in `src/vault/shares.ts`) |
| How long | At most 30 days, which is how long a connected app's offline access lasts (`MCP_GRANT_TTL_MS` in `src/shared/mcp.ts`). The owner can renew it |
| Checked when | On every read. First in the coach's own vault, reached by `myVault(c)` from the session, as `coachClient` is (`src/worker/routes.ts`, `src/vault/vault.ts`): its `requireOwner` checks the coach's session generation and security epoch, so a sign-out everywhere ends live reads at once, and that vault says which grant and where it is kept, as it does for the coach's comment routes. Then in the owner's vault, again after every `await`: live grant, the coach's account ID and address from their own session, and the owner's security epoch. Live data is never served to a share-session cookie, which a sign-out everywhere does not end (the comment above the coach comment routes in `src/worker/routes.ts`) |
| Revocation | Ends at the next request. A changed security epoch, deleting the job (for one-job access) or deleting the account ends it too. The coach is told the access ended, with a 409 and never a 410 |
| Audit | The owner's vault records each day the coach read anything, and what kind (facts, a job, a resume), with counts. The owner sees it. Nothing about the coach's browser or network is kept |
| Writes | None new. Comments and suggested wording stay as they are |
| Models | A live read calls no model |

## The threats it opens

| Threat | Control proposed |
| --- | --- |
| The owner adds something later that they would not have shared | One-job access by default; a plain line on the whole-vault choice saying later facts are included; sensitive marks apply at each read |
| A coach's account is taken over, and the attacker reads live data for weeks | 30 days at most; each read passes the coach's own vault first, so signing out everywhere ends it; never served to a share-session cookie; the owner's audit shows the reads |
| A coach copies everything | Unchanged from today: what a reader can see they can keep. The notice says so |
| A second account under the coach's address | Bound to the account ID at take-up, as copies are |
| Live reads reveal the owner's activity (new jobs, statuses) | Status and dates off by default; notes never |
| Polling loads the owner's vault | Reads counted under the coach's own rate limit |
| What is read is treated as evidence or an instruction | Live views are text to show; nothing a coach reads goes back into any prompt |

## What changes once decided

**Code**

- A store of its own (for example `CoachAccessStore` in `src/vault/coach-access.ts`) with a table for grants and one for the daily read log, added as one new vault migration appended after whatever is last at the time.
- The tables are in the owner's export and erased with the vault. Grants are left out of transfer, with that reason in a comment, as other credentials and grants are (`TRANSFER_TABLES` in `src/shared/operations.ts`); the read log travels.
- Vault methods that return field maps written in the method, never `FactView` or `ApplicationView`, as connected apps' methods do.
- Owner routes to grant, list and revoke; coach routes reached from the client list (`src/web/pages/ClientsPage.tsx`).
- A new surface, `"coach's live view"`, in the outward canary (`test/integration/outward.ts`).
- Tests for each denial: a stranger, the owner, a second account, revoked, expired, a changed epoch, the coach after signing out everywhere, a share-session cookie with no coach session, a job out of scope, a deleted job, and a fact marked sensitive after the grant.

**Docs**

- [seeker-threat-model.md](../seeker-threat-model.md): rewrite the row at line 27 and the paragraph at line 54, and add a row for live access.
- The privacy notice: a new part of "Sharing a copy" for live access. The sentence "The copy is fixed when you make it" stays true of copies. `test/web/legal.test.tsx` changes with it.
- [seeker-release-status.md](../seeker-release-status.md): the coach sharing row.

## Who decides

- **Owner:** whether to build it; one job, whole vault or both; quotes or not; how long; whether status and dates are shown; what the audit shows.
- **Counsel:** the privacy notice wording; whether a coach or coaching firm reading live data is a processor or a separate controller, and whether that needs terms with coaching firms.
