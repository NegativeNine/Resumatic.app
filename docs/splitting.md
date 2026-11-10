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
| 5 | A claim made of separate pieces does not reach across a figure to join them | "Led a team of 5 and shipped 3 products" becoming "Led 3 products" | No |
| 6 | Each claim passes the checks a resume line passes against its facts: numbers, names, scope, denied and planned actions | "2" for "2 million"; "40%" for "up to 40%"; "architecting" for "assisted in architecting" | No |
| 7 | The judge finds that the line states each claim as the claim reads alone | "Led the billing product" from "Led the design team and shipped the billing product" | Yes |
| 8 | The judge finds that the claims together say everything the line says | A division that is accurate but leaves something unsaid | Yes |

The judge is asked in the form it already answers: is this line supported by these facts? For check 7 the claim is the line and the whole line is its one fact. For check 8 the whole line is the line and the claims are its facts. Anything but "supported" keeps the line whole, and so does a missing or repeated answer.

## Starting rule 1: which lines are never divided

A line stays whole if it has any of these in it. The list is wide on purpose: it leaves some lines whole that a person would divide. It is in `QUALIFYING_WORDS` and `QUALIFYING_PHRASES`, and it is the place to loosen once divisions are measured.

- **Shared or partial credit:** helped, assisted, supported, contributed, participated, involved, partly, jointly, part of, member of, one of.
- **Negation and exception:** not, no, never, none, without, cannot, unable, except, lack, any word ending in *n't*, rather than, instead of, failed to.
- **Alternatives:** or, either, versus, and/or. "Python or Go" is not "Python" and "Go".
- **Intention, attempt and possibility:** proposed, planned, intended, expected, will, would, could, should, may, might, pending, potential, tried, attempted, learning, exploring, if, unless, up to, plans to, in progress.
- The commonest negations in Spanish, German and French, as the reader already guards skills.

"May 2021" is a month and does not count. A line of fewer than four words or more than eighty is not divided either.

## What only the judge can stop

Checks 2 to 6 cannot tell that a verb has been paired with the wrong object when no figure lies between them. "Wrote weekly incident reviews" is made of the words of "Wrote the on-call runbooks and ran weekly incident reviews" and passes every check that needs no model. Only check 7 refuses it.

So the safety of dividing rests, for that kind of error, on the judge. The labelled lines mark which wrong divisions are caught without a model and which are not (`test/fixtures/split-lines.ts`), and the eval puts each of them to the real judge.

## Running in shadow

With `SPLIT_SHADOW_ENABLED=true`, reading an upload gains one stage after its facts are embedded and before it is marked ready:

- It asks about the lines the reading proposed, other than skills.
- What passes every check is stored as a shadow division on its fact, stamped `split/1` and with the two models that made and judged it.
- **It cannot fail an upload.** A model failure, a refused answer or running out of time leaves every line whole and the upload finishes as it would have. It gets one short try.
- It adds model calls to every upload, and the upload is marked ready after them. Before this is switched on anywhere people are waiting, move it after "ready".
- The Workflow's own state holds counts only: how many lines, how many divided, and how many stayed whole for each reason.

A person's export includes their shadow divisions, marked as such. No screen shows them, a coach's copy does not hold them, and tailoring does not read them.

## What has and has not been measured

- **Tested with stand-in models:** every check, on labelled lines that include wrong divisions made of the line's own words (`test/unit/split.test.ts`); the stage on and off, a failing model and a refused division (`test/integration/split-shadow.test.ts`).
- **Not run:** the eval against the real models (`npm run evals`, `test/evals/split.eval.ts`). It needs model credentials. It puts every labelled wrong division to the real judge, where none may pass, and reports what the real proposing model does with each line.
- **Not measured:** how often an accepted division changes a line's meaning. The target is zero on labelled lines, and the labelled lines so far are made up. That needs real resumes given with consent, as the extraction evals do.

Nothing is shown to anyone until that is measured.
