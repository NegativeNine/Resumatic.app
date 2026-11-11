# Brokered pilot plan

**Status: a plan, not started. It adds no code.**

It is the paid pilot that Gate 3 requires before any marketplace code is built ([system design](system-design.md), lines 308 and 1065), and its result is the decision rule for whether to build the marketplace at all ([design review](design-review-2026-11.md), decision 6). Every number below is a proposal for the owner, marked **Owner**. Every legal point is a question for counsel, marked **Counsel**.

Written on 11 November 2026 against `main` at `3d7c9fe`.

## What the pilot tests

The system design's launch order (line 308): agencies only, in two or three niches, as a paid pilot with kill criteria fixed in advance. Comparable marketplaces that charged per introduction or per hire have struggled, so the pilot has to show that evidence, consent and pay ranges change the outcome.

The pilot runs by hand. Staff called brokers arrange each introduction. The product is used only as each person already uses it. Nothing in it reads a vault for anyone but its owner, and nothing new leaves a vault except by its owner's own action through features that exist.

## The shape

| | Proposal | Who decides |
| --- | --- | --- |
| Demand | Agencies only. No in-house teams, staffing firms or job boards | Fixed by the system design |
| Niches | Two, at most three. Chosen where candidates sign up for the pilot, never by reading vaults | **Owner** |
| Markets | Only markets counsel has cleared for the pilot entity | **Owner**, **Counsel** |
| Agencies | 4 to 6 in each niche | **Owner** |
| Seats | 10 to 20 in total | **Owner** |
| Candidates | 50 to 150 in each niche who have given the pilot's consent | **Owner** |
| Length | 120 days: 90 to the seat-renewal decision, then 30 for introductions already accepted to reach an outcome | **Owner** |
| Charges | Seats monthly, and a fee for each accepted introduction. Candidates never pay anything | Shape fixed by the system design (lines 288 and 457); prices **Owner** |
| Locations | No EU candidates or organizations. The product does not keep data in a country yet (`src/web/pages/LegalPage.tsx`, line 101) | **Owner**, **Counsel** |

## What must be true before it starts

Each item is a precondition. The pilot does not start with any of them open.

### Legal

- [ ] **Counsel** has said whether the pilot entity is an employment agency or needs a recruiter licence in each pilot market, and the pilot runs only where the answer allows it ([system design](system-design.md), line 501).
- [ ] **Counsel** has confirmed that charging only agencies, with candidates never paying, keeps the exemptions that depend on it. Tailoring for an introduction is free and outside plan quotas (system design, line 457).
- [ ] **Counsel** has said whether a broker choosing candidates by hand, with the card preview as an aid, is an automated employment decision tool anywhere in the pilot's markets.
- [ ] **Counsel** has set the data roles: the platform for the pilot ledger, the agency as an independent controller of what a candidate gives it (system design, line 971), and the terms each agency signs.
- [ ] **Counsel** has set how long the pilot ledger is kept, and its lawful basis.
- [ ] **Counsel** has reviewed the agency agreement: pay ranges on every opening, no contact outside the introduction, deletion on a candidate's withdrawal, no use of what a candidate shares for any other opening or client.

### Consent wording

- [ ] The candidate's consent text exists, has been reviewed by counsel, and says in plain words:
  - what the broker sees before an introduction (the summary the candidate approved, and nothing from their account);
  - which agencies may see that summary, by name;
  - that their name, contact details and anything else are given to an agency only when they accept a named introduction, and only what they choose;
  - that an agency keeps what it was given under its own terms, and revoking a link cannot take back what it has read;
  - how to leave the pilot, and what happens to the ledger then;
  - that declining costs them nothing and is never shown to the agency at once.
- [ ] The consent is separate from the product's terms, can be refused without any effect on the product, and is recorded with its date and wording version.

### The card preview

- [ ] The owner-only card preview, being built this round, is in staging. It shows a person the card that would be built from their confirmed records. **This round**
- [ ] Because no path confirms a tag yet ([tagging.md](tagging.md), "What is not built"), the preview of a real vault may be empty. Then the candidate writes their pilot summary by hand, to a fixed template the broker supplies, and the preview is not used. **Owner** chooses whether the pilot waits for owner review of tags.
- [ ] The re-identification harness, also being built this round, has run over the summary template. A summary that singles a person out among the pilot's candidates is coarsened before any agency sees it. **This round**

### Operations

- [ ] The pilot ledger exists (below), with a named list of who can open it.
- [ ] Each agency has been checked by a broker: registry entry, domain, a named contact, and a payment method.
- [ ] Invoicing works. Nothing in the product charges an organization (`BILLING_ENABLED` is `"false"` in both environments in `wrangler.jsonc`, and the billing code covers seeker plans only, `src/shared/billing.ts`), so agencies are invoiced outside it. **Owner** chooses how.
- [ ] The kill criteria and their numbers are written into the ledger before the first introduction, and are not changed while the pilot runs.

## The process, step by step

1. **Invitation.** Beta users are invited to the pilot the way beta invitations go out today: an email from the team ([beta/invite-email.md](beta/invite-email.md)). The product sends nothing about the pilot. Email notices being built this round are content-free and are not used for this. **This round**
2. **Consent.** The candidate reads the consent text and agrees, or doesn't. Agreeing changes nothing in their account.
3. **The summary.** The candidate opens their own card preview, or fills in the template, and sends the broker a summary: occupation, seniority, years in bands, up to 12 skills, metro area or remote, job types, availability. No name, photo, employer names or dates (the system design's Anonymous level, line 322). Separately, they tell the broker which employers and agencies to block. Blocks name an employer, which is itself a clue to where someone works (system design, line 327), so they stay with the broker and never reach an agency. The broker never sees the candidate's account.
4. **Agencies sign on.** Each agency signs the agreement and names its seats. It states which companies it recruits for, so blocks can be checked.
5. **An opening.** An agency sends the broker an opening: the hiring company (checked by the broker), title, location, pay range and requirements. An opening without a pay range is refused.
6. **A shortlist, by hand.** The broker compares the opening with the summaries, leaves out every candidate who blocked the hiring company or the agency, and sends the agency the matching summaries without names. Nothing is ranked by anything but the opening's requirements. The broker records which summaries were sent, and why, in the ledger.
7. **A request.** The agency asks for an introduction to one summary. The ledger records a held credit.
8. **The candidate is asked.** The broker sends the candidate the agency's name, the opening, its hiring company and pay range. The candidate has seven days. They can tailor a resume for the opening in their own account first, as any user can.
9. **Decline or silence.** The ledger releases the credit. The agency is told "not now", no sooner than a random delay of up to three days, and with a reason only if the candidate gives one.
10. **Accept.** The candidate chooses what to give the agency and gives it themselves: a shared copy of chosen facts and a resume version (an existing feature: a fixed snapshot, a link that lasts seven days at most, revocable at any time; `src/vault/shares.ts`), and a contact channel of their choice. The ledger records the acceptance and the credit as charged, and the agency is invoiced.
11. **Outcome.** The broker asks both sides for the stage at 30, 60 and 90 days. A hire counts only when the candidate confirms it.
12. **Withdrawal.** A candidate can leave at any time. They revoke their link, which ends the copy at once and cannot take back what was read (`src/web/pages/LegalPage.tsx`, "Sharing a copy"). The broker asks the agency to delete what it holds, as the agreement requires, and removes the candidate's summary from the ledger.

## Who sees what

| Who | Before acceptance | After acceptance |
| --- | --- | --- |
| Candidate | The agency's name, the opening, its hiring company and pay range | The same, and the stages the agency reports |
| Broker | The candidate's pilot sign-up details (an address to reach them, the niche) and the summary they sent. Never their account | The same, and what the candidate said they shared, not its content |
| Agency | Summaries with no name, for openings it sent | What the candidate chose to give it: the copy's contents while the link lasts, and the contact channel |
| The product | Nothing new. The pilot adds no way for anyone but its owner to read a vault | A shared copy, as for any copy today |

## The pilot ledger

The ledger is a record outside every vault, kept by the brokers. It holds, for each candidate, a pilot ID, an address to reach them, their niche and the summary they sent; for each agency, its name, seats and agreement; and for each introduction, the opening's title and pay range, dates, states, the credit's state and the reported stages. It holds no resume, fact or copy link. **Counsel** sets its retention. It is the only source of the kill-criteria numbers.

## Kill criteria

These are fixed before the first introduction. A metric below its kill line at its checkpoint ends the pilot, and with it the marketplace as designed. A metric between the kill line and the target is a decision for the owner. All numbers are **Owner** proposals.

| Measure | Definition | Target | Kill line | Read at |
| --- | --- | --- | --- | --- |
| Paid acceptances per seat | Accepted introductions that were charged, per paying seat per month | 2 or more | Under 1, averaged over days 31 to 90 | Day 90 |
| Hires per hundred accepted introductions | Hires the candidate confirmed, per hundred introductions accepted at least 60 days before | 8 or more | Under 3 | Day 120 |
| Seat renewal at 90 days | Paying seats at day 90 that renew for the next period | 60% or more | Under 40% | Day 90 |

Reasons for these numbers. One paid acceptance a seat a month is the least at which a fee per acceptance can carry any part of a seat's cost; the cost model below says whether two does. Hires are counted only for introductions old enough to have reached a decision, and the pilot is too small for a precise rate, so the kill line is set well below the target. Renewal is the agencies' own judgement of value, and the one measure no broker effort can inflate.

**Stop at once,** whatever the measures say, if any of these happens: a candidate is identified to an agency before accepting; a candidate is charged anything; anything is shared that the candidate did not choose; an agency contacts a candidate outside an introduction. Each is reported to the owner the same day.

**Also recorded, not kill criteria:** the acceptance rate per agency; the time from a candidate's consent to their first accepted introduction; candidates leaving the pilot, and why; complaints; broker hours for each introduction.

## Loaded cost model

Every input is an assumption the owner sets. No price or cost here is a market figure, and none is filled in. The model gives the break-even number of paid acceptances per seat per month that Gate 3 asks for (system design, line 466).

| Input | Meaning | Unit | Set by |
| --- | --- | --- | --- |
| `S` | Paying seats | seats | **Owner** |
| `P_seat` | Seat price | money per seat per month | **Owner** |
| `P_intro` | Fee for each paid acceptance | money | **Owner** |
| `H_intro` | Broker hours for one introduction requested, accepted or not | hours | **Owner**, then measured in the pilot |
| `R` | Requests for each paid acceptance | ratio | **Owner**, then measured |
| `C_hour` | Loaded cost of a broker hour (pay, overhead) | money per hour | **Owner** |
| `C_run` | Model and platform cost of the tailoring runs one acceptance triggers | money | **Owner**, from staging measurement. Spend per model call is reserved and recorded in the vault (`src/workflows/models.ts`, `src/ai/usage.ts`); no real run has been measured |
| `F_pay` | Payment processing cost, as a share of revenue | ratio | **Owner**, from the processor's terms |
| `C_onboard` | Broker hours and checks to verify one agency, as money | money per agency | **Owner** |
| `A` | Agencies | agencies | **Owner** |
| `C_legal` | Counsel's fees for the pilot | money, once | **Owner**, from counsel's quote |
| `C_insure` | Insurance for the pilot, if counsel advises it | money per month | **Owner** |
| `C_tools` | Ledger, invoicing and support tools | money per month | **Owner** |
| `M` | Months the fixed costs are spread over | months | **Owner** |

**Per month:**

- Revenue: `S × P_seat + N × P_intro`, where `N` is paid acceptances in the month.
- Variable cost: `N × (R × H_intro × C_hour + C_run) + F_pay × revenue`.
- Fixed cost: `(C_legal + A × C_onboard) / M + C_insure + C_tools`.

**Break-even paid acceptances per seat per month,** where revenue equals variable plus fixed cost:

```
n* = ( fixed / S  −  P_seat × (1 − F_pay) ) / ( P_intro × (1 − F_pay)  −  R × H_intro × C_hour  −  C_run )
```

A value of `n*` at or below zero means seat fees alone cover the month. If the denominator is zero or below, no number of acceptances breaks even: each acceptance costs more to broker than it earns, and the pilot's price or process is wrong before any measure is read. If `n*` is above the target for paid acceptances per seat, the targets are inconsistent with the prices, and the owner resets one before the pilot starts.

The model is per pilot. A model per launch jurisdiction, with licences and compliance costs, is a Gate 3 deliverable for the marketplace itself (system design, line 466) and is not this one.

## After the pilot

- **Every measure at or above target:** the owner decides whether to start Phase C of the [technical specification](marketplace-technical-spec.md), after Gate 3.
- **Any measure below its kill line:** the marketplace as designed is not built. The seeker product carries on unchanged. The ledger is kept or deleted as counsel set.
- **In between:** the owner decides, with the measures and the recorded notes in front of them.
