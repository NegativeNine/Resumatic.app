# Dividing a line into its claims

One line of a resume often says several things: "Designed and built the API, cutting deploy time from 40 minutes to 6." This document describes how such a line is divided into the claims it makes, and what stops a division from saying anything the line doesn't.

It is step 4 of the [pipeline design](taxonomy-pipelines-design.md). The code is `src/pipeline/split.ts`. What a division is stored as is in [record.md](record.md).

**Status: the splitter exists and is tested with stand-in models. It runs only where `SPLIT_SHADOW_ENABLED` is `"true"`, which is nowhere by default and is refused in production configuration. Where it runs, what it keeps is in shadow: stored to be measured, shown to nobody, read by nothing. It has not been run against the real models, and nothing has been measured.**

## How a line is divided

1. **A model marks the line by word number.** It is shown the line with its words numbered and answers with ranges of numbers for each clause, each result and each mention. It never writes a word, so a division cannot contain one the line doesn't.
2. **Every check below must pass.** If any fails, the line stays whole, exactly as it is read today.

| # | Check | Stops | Needs a model |
| --- | --- | --- | --- |
| 1 | The line has no hedge, negation, alternative or intention in it (starting rule 1) | "Helped lead X and Y" becoming "lead Y" | No. Decided before any model is asked |
| 2 | The parts are whole words of the line and fit together ([record.md](record.md)) | "helpful" for "unhelpful"; a result of nothing | No |
| 3 | There are at least two claims | Storing a division that divides nothing | No |
| 4 | Every word that carries meaning is inside a claim. Only a joining word ("and", "then", "by") may be left out | A dropped figure, unit or qualifier | No |
| 5 | A part made of separate pieces does not reach across a figure to join them. This holds for a mention as for a claim | "Led a team of 5 and shipped 3 products" becoming "Led 3 products"; a mention of "revenue 20%" in "Grew revenue 40% and headcount 20%" | No |
| 6 | Each part, a mention included, passes the checks a resume line passes against its facts: numbers, names, scope, denied and planned actions | "2" for "2 million", as a claim or as a mention; "40%" for "up to 40%"; "architecting" for "assisted in architecting" | No |
| 7 | A result comes after the claim it is named as the outcome of | In "Rebuilt the checkout, raising conversion by 12%, and led the design team", the rise in conversion named as the outcome of leading the design team | No |
| 8 | The judge finds that the line states each claim as the claim reads alone | "Led the billing product" from "Led the design team and shipped the billing product" | Yes |
| 9 | The judge finds that the line states each result with the claim it is named as the outcome of, the two read together | "Trained 4 new hires cutting import time from 2 hours to 5 minutes" from "Trained 4 new hires and rewrote the importer, cutting import time from 2 hours to 5 minutes" | Yes |
| 10 | The judge finds that the claims together say everything the line says | A division that is accurate but leaves something unsaid | Yes |

The judge is asked in the form it already answers: is this line supported by these facts? For check 8 the claim is the line and the whole line is its one fact. For check 9 the line is the claim followed by its result, in the line's own words and order, and the whole line is its one fact; naming another claim for the same result asks a different question. For check 10 the whole line is the line and the claims are its facts. Anything but "supported" keeps the line whole, and so does a missing or repeated answer. The questions for an upload can take several calls, and an answer counts only in the call that asked its question: one call never answers for another.

## Starting rule 1: which lines are never divided

A line stays whole if it has any of these in it. The list is wide on purpose: it leaves some lines whole that a person would divide. It is in `QUALIFYING_WORDS` and `QUALIFYING_PHRASES`, and it is the place to loosen once divisions are measured.

- **Shared or partial credit:** helped, assisted, supported, contributed, participated, involved, partly, jointly, part of, member of, one of.
- **Negation and exception:** not, no, never, none, without, cannot, unable, except, lack, any word ending in *n't*, rather than, instead of, failed to.
- **Alternatives:** or, either, versus, and/or. "Python or Go" is not "Python" and "Go".
- **Intention, attempt and possibility:** proposed, planned, intended, expected, will, would, could, should, may, might, pending, potential, tried, attempted, learning, exploring, if, unless, up to, plans to, in progress.
- The commonest negations in Spanish, German and French, as the reader already guards skills.

The list is read against the line's words, whichever mark stands for an apostrophe and whatever spacing they came with. "Didn`t", "didn´t" and "didn‘t" are *didn't*, and "up to" is the same phrase across a line break or a space that does not break.

"May 2021" is a month and does not count. A line of fewer than four words or more than eighty is not divided either.

Check 7 is a starting rule of the same kind. A line that states an outcome before what led to it, such as "Doubled sign-ups in 6 weeks by rebuilding the onboarding flow", stays whole when the outcome is marked as a result. A result is put to the judge read after its claim, and that is the line's own order only when the result comes second.

## What only the judge can stop

Checks 2 to 7 cannot tell that a verb has been paired with the wrong object when no figure lies between them. "Wrote weekly incident reviews" is made of the words of "Wrote the on-call runbooks and ran weekly incident reviews" and passes every check that needs no model. Only check 8 refuses it.

Nor can they tell which of the claims before a result it is the outcome of. Check 7 settles a result named as the outcome of a claim that comes after it. Between two claims that both come before it, only check 9 can refuse the wrong one.

So the safety of dividing rests, for those two kinds of error, on the judge. The labelled lines mark which wrong divisions are caught without a model and which are not (`test/fixtures/split-lines.ts`), and the eval puts each of them to the real judge.

## What no check establishes

That a mention is a tool, a name or a figure. A mention is held to the checks above as a part of the line: whole words inside a claim, never across a figure, and never a figure without the word that scales or hedges it. Whether those words name a tool is the proposing model's word alone. Nothing reads a mention yet; when tagging is built (step 5), each tag on one is a judgement of its own.

## Running in shadow

With `SPLIT_SHADOW_ENABLED=true`, reading an upload gains one stage after its facts are embedded and before it is marked ready:

- It asks about the lines the reading proposed, other than skills.
- What passes every check is stored as a shadow division on its fact, stamped `split/2` and with the two models that made and judged it.
- **It cannot fail an upload.** A model failure, a refused answer or running out of time leaves every line whole and the upload finishes as it would have. It gets one short try.
- It adds model calls to every upload, and the upload is marked ready after them. Before this is switched on anywhere people are waiting, move it after "ready".
- The Workflow's own state holds counts only: how many lines, how many divided, and how many stayed whole for each reason.

A person's export includes their shadow divisions, marked as such. No screen shows them, a coach's copy does not hold them, and tailoring does not read them.

## What has and has not been measured

- **Tested with stand-in models:** every check, on labelled lines that include wrong divisions made of the line's own words (`test/unit/split.test.ts`); the stage on and off, a failing model and a refused division (`test/integration/split-shadow.test.ts`).
- **Not run:** the eval against the real models (`npm run evals`, `test/evals/split.eval.ts`). It needs model credentials. It puts every labelled wrong division to the real judge, where none may pass, and reports what the real proposing model does with each line beside the labelled division, with the claim each result was named as the outcome of.
- **Not measured:** how often an accepted division changes a line's meaning. The target is zero on labelled lines, and the labelled lines so far are made up. That needs real resumes given with consent, as the extraction evals do.

Nothing is shown to anyone until that is measured.
