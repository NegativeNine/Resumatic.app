# Decision: what counts as years of using a skill

**Waiting for: the owner, with counsel on one point. Written on 11 November 2026 against `main` at `3d7c9fe`.**

## The question

When may Resumatic say that a person used a skill for a number of years? What counts as an evidenced or owner-confirmed interval of using it?

## Why it blocks what

- **The agreed pipeline design sets the rule but not the evidence.** "Years per skill additionally requires an evidenced or owner-confirmed interval for using that skill; a mention in a five-year role does not establish five years of use" ([taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md), line 114). What an interval is, and where it comes from, is not settled.
- **The system design disagrees with itself.** Its derived facts say "6 years of Go" is "computed from the dates of roles with evidence of Go, counting overlapping roles once, and the user confirms or corrects it" ([system-design.md](../system-design.md), line 173). Its rules on equivalences say "Skill years count only dated evidence of the skill, not a whole role that mentions it once" (line 269). The pipeline design follows the second.
- **It blocks** pipeline step 8, "years per skill" ([taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md), "Order of work"), the roadmap's taxonomy step 6 ([roadmap.md](../roadmap.md)), the card's years per skill in bands (system design, line 352), and the "Time" check, under which "durations and 'years of' phrases must equal confirmed derived facts" (system design, line 248).

**What the code holds today.** A role has a start and an end, each a year or a year and month as the source gave it (`src/shared/api.ts`, the comment on role dates; `roles` in `src/vault/schema.ts`). A fact has no dates of its own, and the record says so: "A fact's record does not yet hold when a skill was used" ([record.md](../record.md), line 117). There is no derived-fact table. A resume line that states a number of years passes only if a cited fact states that number, because the claim checks hold every number to the cited facts (`checkClaim` in `src/grounding/claims.ts`).

## Options

| # | Option | An example that counts | Strength |
| --- | --- | --- | --- |
| 1 | **Explicit dated statements only.** An interval or a duration in a fact's own words, about that skill | "Built Go services from 2019 to 2023"; "Five years of Python" on a skills list | Evidenced: code reads the interval from the words, as it reads numbers today |
| 2 | **A confirmed tag on a fact inside a dated role, labelled as an estimate.** The role's dates bound the interval | A confirmed Go tag on a line in a role from 2018 to 2023 | Bounds only. Use of the skill may have been one week of those five years |
| 3 | **Intervals the owner enters.** The owner says when they used the skill, from and to, in the vault | "Go, from 2019 to 2023", entered or confirmed by the owner | Owner-confirmed: the owner's own statement, as a fact they type is |

## Recommendation

**Options 1 and 3 count. Option 2 is shown only to the owner, labelled as an estimate, and never satisfies a years requirement.**

| Rule | Proposal |
| --- | --- |
| What counts | An interval read by code from a confirmed fact's own words (option 1), or entered or confirmed by the owner (option 3) |
| Overlaps | Dated intervals for one skill are counted once where they overlap |
| Undated durations | A duration with no place in time ("Five years of Python") is never added to anything, because it cannot be checked for overlap. A skill's total is the larger of its longest single stated duration and the de-overlapped union of its dated intervals. Only an interval the owner confirms can place a duration in time, and then it counts as that interval |
| Precision | Kept as given. "2019 to 2023" is counted in years; an interval given in months is counted in months. A sum is never stated more exactly than its least exact part |
| An open end | A current role's open end counts up to today only in an interval the owner confirmed |
| No interval | Duration unknown. Never zero, never "less than" |
| Estimates | Option 2 is shown to the owner as "within roles covering about N years (estimate)", so they can confirm a real interval. It never reaches a resume, a card, a match report, a copy or a connected app, and it never meets a posting's years requirement |
| Hierarchy | Years of a narrow skill are not years of its broader group, and the reverse, as a tag on one is not a tag on the other ([tagging.md](../tagging.md), "What is never done") |

The reason: a role's length says how long the person held the job, not how long they used one skill in it. Treating the two as one would print a number the person never stated. Options 1 and 3 keep every stated year traceable to the person's words.

## What changes once decided

**Code**

- A table of skill intervals in the vault: the skill (a fact or a confirmed concept), start, end, precision, where it came from (a fact's words or the owner) and its state. A new appended vault migration; exported, moved and erased with the vault.
- A pure module that reads an interval or a duration from a fact's words and sums intervals with their precision, beside the claim checks in `src/grounding/`, with tables of examples in unit tests.
- Derived years stored with their inputs, confirmed by the owner before first use, and cited like any fact, so a resume line stating years passes `checkClaim` only by citing them.
- The owner's review: propose intervals from dated statements; show estimates as estimates.
- The card builder reads only counted intervals, in capped bands.

**Docs**

- [taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md): line 114 points here.
- [system-design.md](../system-design.md): line 173 changes to match line 269.
- [record.md](../record.md): line 117, once intervals are kept.

## Who decides

- **Owner:** which options count, and how estimates are shown to them.
- **Counsel:** years of experience track age, and the design already caps them in bands for that reason (design review, regulation finding 20). Counsel says whether years per skill may appear on a card at all, and in what bands.
