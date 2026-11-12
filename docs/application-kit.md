# Saved answers and the application kit

A person applying for a job is usually asked the same short questions again and again: their notice period, a portfolio link, whether they would relocate. Saved answers keep those answers in their own words, under labels they choose. An application kit puts together what they will send for one job: one resume version, a cover letter and interview preparation if they want them, and their answers to that employer's questions. The person approves the kit, downloads it and sends it themselves.

The types, caps, sentences and rules are in `src/shared/kit.ts`; the tables and their store are in `src/vault/application-kit.ts`; the judge's one question is in `src/ai/question-match.ts`.

**Status: built and tested with a stand-in judge. Matching by the judge is off everywhere and refused in production configuration (`APPLICATION_KIT_ENABLED`, [operations](seeker-operations.md)); without it, matching is the closed list and a label word for word. Nothing is submitted to an employer, and there is no queue across jobs.**

## Saved answers

An owner keeps up to 50. Each has a label of up to 80 characters and an answer of up to 4,000, both cleaned of characters that are not shown. Two labels that read the same once folded (case, apostrophes, punctuation and spacing) are one label: a second is refused, and the same label and answer sent twice return the one already kept. An edit names the revision it was read at.

A save is refused, in the words of the kind, when its label or its answer is on the refused list below. The list can grow after an answer was saved; such an answer is kept and shown with what it is about, and is never matched or used.

## The three states of a question

The employer's questions are pasted one per line, up to 30 of up to 1,000 characters. Each is cleaned and shown as text in a quote: it is someone else's words, never an instruction and never evidence. Every new or reworded question gets one of three states:

| State | When | What the owner does |
| --- | --- | --- |
| Asked every time | The question is on the refused list, or the judge said it is about a refused matter | Types an answer for this kit only. It is never saved and never matched |
| Matched | The question points at a saved answer: its words fold to a label's, or (switched on) the judge chose that label | Checks it. Its label and words are shown, and it counts only once confirmed at the saved answer's current revision |
| Needs your answer | Nothing fits | Types an answer, or picks a saved answer. A typed answer can also be kept as a new saved answer, unless the question, the label or the answer is on the list |

A question whose words are unchanged keeps its state and answer when the list is reordered or added to.

## The refused list

Some questions are never answered from a saved answer: work authorisation, visas and sponsorship; salary, pay and compensation; and the personal details equal-opportunity forms ask about, such as race, ethnicity, national origin, gender, sexual orientation, age, religion, disability and health, veteran status, criminal record, marital or family status, and pregnancy. The list (`REFUSED_KIND_WORDS`) is closed: whole words and phrases, a few stems, and an age bound with a number ("over 18").

It is read strictly on purpose. Each pasted line is a question of its own, so an equal-opportunity form's option lines ("Hispanic or Latino", "Male", "Decline to self-identify") must be refused on their own, and a saved answer labelled with one must never be matched. The cost is that some innocent questions stop and ask: "Which software package…" (pay), "Would you like to opt in…" (work status), "Have you written a white paper?" (race), "military experience", "health-tech". Nothing is lost but convenience.

The list is checked when an answer is saved, when a question is matched, when a kit is approved and when it is downloaded. A matched question, or the saved answer it uses, that today's list refuses is treated as asked every time: it can't be confirmed and blocks approval and download.

## What the judge is given

Only where `APPLICATION_KIT_ENABLED` is `"true"`, the typed-decision judge is configured and the owner has a saved answer the list takes, each question that neither the list nor a label settled is put to the judge as one closed choice. The request holds the question, as untrusted data in its state, and the labels, one criterion each. It never holds an answer's words: the item it is built from has no field for them. The choices are a label, none, or refused; a label is taken only at 0.8 and ahead of every other choice, and refused wins at 0.2.

The asking is a `match` run inside the Vault that reserves budget before each call. Any failure (the models can't be built, a call is refused or fails, an answer is malformed) makes the question ask. An answer is used only if no saved answer changed while it was asked, and a judge's match is always one the owner must check. A manipulated judge can at most propose a match the owner turns down, or make a question ask.

## Approval, and what returns a kit to draft

A kit can be approved when a resume is chosen and passes the resume gate (a fact marked sensitive since counts against it), each chosen document passes the document gate, and every question is answered: typed, or matched and checked at its saved answer's current revision. Every write to a kit makes it a draft again, even one that changes nothing: questions saved, an answer typed, a match checked or turned down, parts chosen. So does an edit to, or a deletion of, a saved answer it uses.

What can be chosen is worked out the same way, so it is bounded: the kit offers the 50 newest resume versions across the job's finished resumes (`MAX_KIT_RESUME_CHOICES`) and the 200 newest letter and preparation versions, each only if it passes its gate now. A version chosen before it fell out of that list is still shown as chosen and still gated.

The gates are worked out on every read and never written. An approved kit whose resume later uses a fact marked sensitive stays approved, says it needs attention and why, and can't be downloaded until it passes again.

## The download

Only an approved kit that still passes every check downloads. The ZIP holds:

- `resume.pdf` and `resume.docx`, as the resume's own downloads print them;
- `cover-letter.docx` and `interview-preparation.docx`, each only if chosen, as a shared copy would show them;
- `answers.txt`: for each question, "Question n", the question, "Your answer" and the answer, a matched one in its saved answer's words now.

The kit is read again after the files are made, and a kit that changed in between is refused. Nothing is sent anywhere: the person sends what they downloaded.

## Where it goes

| Table | Export | A vault moved to a replacement | Deleting a job | Deleting the account |
| --- | --- | --- | --- | --- |
| `saved_answers` | `savedAnswers`, revisions included | Moves, row for row | Stays: it is the owner's, not the job's | Erased |
| `application_kits` | `applicationKits` | Moves; an approved kit arrives approved and is gated again on every read | Erased with the job | Erased |
| `kit_questions` | `kitQuestions`, typed answers included | Moves | Erased with the job | Erased |

A kit is not work that keeps a job: a job with only a kit can be deleted. Resume and document IDs move unchanged, and no row holds a vault ID, storage key or run ID. A `match` run needs no Workflow stopped, so a vault that asked the judge can be deleted and moved.

Nothing else reads these tables. A shared copy, a coach's view, a connected app, tailoring, documents and `usableFacts()` read nothing of a kit, and an answer is never a fact or evidence. `test/unit/saved-answers-reach.test.ts` holds the store to the owner's calls, the export and the deletion of a job.

## What is not built

- Nothing is submitted to an employer, and no form is filled in.
- There is no list of kits across jobs; the Jobs list doesn't show a kit's state.
- The judge's thresholds have not been measured on real questions, and no eval covers it.
