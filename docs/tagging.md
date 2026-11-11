# Tagging facts and roles with taxonomy concepts

A line of experience shows things the [taxonomy](taxonomy.md) has names for: software it uses, something it knows, a kind of work it does. A job has an occupation. This document describes how a fact or a job is given those names as tags, and what stops a tag from saying anything the person's own words don't.

It is step 5 of the [pipeline design](taxonomy-pipelines-design.md), for facts and job roles, from labels found word for word. The code is `src/pipeline/tag.ts`. What a tag is stored as is in [record.md](record.md).

**Status: the tagger exists and is tested with stand-in models and a made-up taxonomy. It runs only where `TAG_SHADOW_ENABLED` is `"true"` and a taxonomy is bound and wholly loaded, which is nowhere. It has not been run against the real judge, and nothing has been measured.**

## Candidates

A candidate is one of the taxonomy's own concepts whose label stands, word for word, in the words being tagged (`mentions` in [taxonomy.md](taxonomy.md)). Nothing else is ever a candidate.

| What is tagged | Its words | Its candidates |
| --- | --- | --- |
| A job the reading proposed, with a title | The title | Occupations only, ESCO's and O\*NET's, by any of their labels. O\*NET's job titles are among them |
| A fact the reading proposed | Its text | Skills, knowledge and their groups; work activities; software and its categories. Never an occupation |

- **An occupation named in a line is not a candidate for the fact.** "Reported to the IT project manager" names someone else's occupation. A job's occupation comes from its title alone. A course, a project or volunteering is given none, and neither are the groups above occupations, whose names are not job titles.
- **One candidate for each concept,** from the strongest of its labels that was found. A firm label comes before a weak one, which is a short everyday word that is also a label. Then the source's preferred label, another the source lists, a hidden term, and a label the builder made. Then where the label stands in the text, then the concept's ID.
- **A job keeps its first four candidates and a fact its first six.** For a fact in a job whose occupation has been decided, the candidates that occupation usually involves come first: its skills, activities and software in both sources (`profile`, read for the first eight occupations an upload's titles put forward). That only orders them. An occupation's record never adds a candidate, and nothing is tagged because it is usual for the job.
- A concept's kind and label are taken from the taxonomy's own record of it. A label whose concept has no record, or a record of a kind that cannot tag the row, gives no candidate.

## What decides

| Candidate | Decided by | Stamped |
| --- | --- | --- |
| The one concept a listed skill names, under the rule below | The rule. No model is asked | `mention-label/1`, by a rule |
| Every other candidate, firm or weak | The judge | `mention-judge/1`, with the judge's model |

A method names where a candidate came from, a label found in the subject's own words, and what decided it. Its number is raised when its rule or the questions below change. Every tag also carries the taxonomy version it was made against.

The judge is asked in the form it already answers: is this line supported by this fact? The line is a fixed sentence around the concept's preferred label. The one fact is the subject's own words.

| Concept | The line put to the judge |
| --- | --- |
| Software | `Used the software: <label>` |
| A category of software | `Used this kind of software: <label>` |
| Knowledge | `Knows: <label>` |
| A skill | `Did or can do: <label>` |
| A group of skills or knowledge | `Has skills or knowledge in: <label>` |
| A work activity | `Did this work: <label>` |
| An occupation | `Worked in the occupation: <label>` |

`<label>` is the preferred label, followed by ` (also called <the label that was found>)` when the two are not the same label. The fact is the fact's text, after `Skill: ` or `Credential: ` for those kinds, or `Job title: ` and the title. The judge is shown a short alias for each question and no ID of a fact, a role or a concept.

A tag needs exactly one "supported" for its question, from the call that asked it. "Unsupported", "overstated", no answer, two answers, and an answer to a question the call did not ask all leave no tag, for a firm label as for a weak one. The judge's own bar is the bar: the chat judge is told that doubt is not support, and the typed-decision judge says "supported" only at 0.8 or above. One wording is asked once, and every row with it takes the answer. A wording is the kind of subject, a fact's kind, the words and the concept.

## The rule

A skill's text is what the reading model gave, which can differ in case from what the upload wrote. The rule applies only where the text is one item of its line, character for character, and is the label itself apart from letter case.

A fact is tagged without a model when all of these hold:

1. It is a skill, and its text is one whole item of the line it was read from, exactly as the upload wrote it. The reading accepts an item without regard to case or Markdown marks and keeps the model's own string, so a list that says `sql` can be stored as `SQL`. The rule does not apply to that.
2. One label is found in the text, it is firm, and it belongs to one concept.
3. The label is the source's preferred label for the concept, or another the source lists. Never a hidden term, and never a label the builder made.
4. The text is that label and nothing else, apart from letter case.
5. Looked up among every kind of concept, the text is the label of that concept and no other.

The examples below are from the made-up taxonomy the tests use.

| The rule tags | The judge is asked about | Because |
| --- | --- | --- |
| `SQL`, `C++`, `Microsoft Excel` | `Python (advanced)` | Other words beside the label |
| `Golang`, another name ESCO lists | `Kubernetes` | Two concepts carry the label: O\*NET's software and ESCO's knowledge |
| `Python (computer programming)`, the label whole | `Go`, `sql`, `PYTHON` | A weak word |
| `Container Orchestration`, the label in other case | `python3`; `Amazon Web Services AWS` | A hidden term; a label the builder shortened |
| | `SQL ✗`, `SQL?`, `~~SQL~~` | A mark beside the label |
| | `Microsoft ✗ Excel`, `Microsoft-Excel` | A mark between the label's words |
| | `SQL`, where the list said `sql` | The text is the reading model's spelling |
| | A credential; a label an occupation shares | The rule is for listed skills that mean one thing |

## What only the judge can stop

Nothing looks for a hedge, a denial or an intention before the judge is asked. A label is a candidate wherever it stands, so these all reach the judge, and only its answer keeps them from being tagged:

- **A label the line only mentions.** "Hired and onboarded two Python developers" names a skill that is someone else's.
- **A label the line denies.** "Never used Kubernetes in production".
- **A label the line intends.** "Planning to learn Python next year".

So the safety of a tag from a line rests on the judge. The labelled examples mark which wrong tags are stopped without a model and which are not (`test/fixtures/tag-lines.ts`), and the eval puts each to the real judge (`test/evals/tag.eval.ts`). It has not been run.

## What is never done

- **A model never names a concept.** It answers yes or no about a candidate the taxonomy's labels put forward. The reason it gives is not read, and a reply that names another concept changes nothing.
- **An occupation's profile, the hierarchy and the crosswalk never add a tag.** A broader skill is not tagged because a narrower one is, and an occupation is not tagged because the crosswalk relates it to one that is.
- **A missing tag is unknown, never missing experience.** A cap, a decline, a failure, or a skill said in other words all leave no tag, and none of them says the person lacks anything.
- **A tag changes nothing.** A fact's words, its quote and its state are as they were, and a tag decided about words a fact or a job no longer has is not kept.

## Running in shadow

With `TAG_SHADOW_ENABLED=true` and a taxonomy bound as `TAXONOMY`, reading an upload gains one stage, after the stages that note copies, offers and divisions and before the upload is marked ready. Without both, reading is exactly as it is today: nothing is looked up and no model is asked.

- It first asks the taxonomy which version it is. A database with nothing in it, one loaded part of the way, or one that cannot be reached ends the stage there.
- It tags this upload's rows only: its first 20 jobs and first 120 facts, as the reading proposed them. A fact its owner has marked sensitive when the stage starts is left out before the cap, so its words go neither to the taxonomy's database nor to the judge. Words already marked arrive marked, so a second upload of a marked line is left out too.
- **A line marked while the stage runs is asked about no more, and keeps no tag.** Before every judge call about facts the stage asks the vault which of them are marked now, and leaves their questions out; a call left with nothing is not sent. The vault reads the mark again as it stores each tag, and stores none for a marked fact. Two things are not undone: the lookups in the taxonomy's database, which all come at the start of the stage, and a judge call already under way when the mark lands. With the typed-decision judge a call of up to 20 questions goes out four at a time, so the rest of that call still goes out. The stage's result counts the candidates left out as `withheld`.
- **Every read of the taxonomy comes before anything is asked or stored.** A taxonomy that cannot be read ends the stage with nothing asked and nothing kept.
- **Tags are stored as they are decided:** the rule's tags, then each judge call's answers, roles before facts. A failed call, a refused reservation or running out of time ends the stage, and what was stored stays. A tag stands alone, unlike a division or an offer, so nothing is gained by discarding answers already paid for.
- A tag is stored in shadow on its fact or job, proposed, with its method, its model and the taxonomy version. It is stored only if the row still says exactly the words that were decided about, and rewording a fact or retitling a job afterwards removes its tags ([record.md](record.md), "When words change").
- **What was decided before is not asked again.** A tag counts when it was made against the same taxonomy version, by the same method and the same model. A row that holds the tag itself is left alone. A row whose words another row holds the judge's yes for is tagged without asking. So a second upload of the same lines asks nothing, and a reading that is retried asks only about what is left.
- **A decline leaves nothing, and is asked again.** No row says that the judge declined a candidate. It is asked about again when the same upload is read again, or the same line is uploaded again.
- **It cannot fail an upload.** It gets one try of at most three minutes and is not run again, so the judge is never asked the same questions twice in one reading. Every judge call is reserved against the daily spending cap before it is sent, and a refusal ends the stage with the code `quota`.
- It adds judge calls to an upload, and the upload is marked ready after them.
- The Workflow's own state holds counts and, if the stage ended early, a code: no line, title or label.

**Where the words go.** Each line's and each job title's words go to the taxonomy's own database as bound query values, in their comparison forms. That database holds public reference data and nothing is written to it. The judge receives the fact's text or the job's title with the taxonomy's labels, as every judge call sends them.

A person's export includes their shadow tags, marked as such, with each concept's label. No screen shows them, a coach's copy and a connected app do not hold them, and tailoring does not read them.

## The caps

Whatever is over a cap is left untagged, which means unknown. The stage's result counts what each cap left.

| Cap | Value | Reason |
| --- | --- | --- |
| Jobs in one upload | 20 | More jobs than a resume lists |
| Facts in one upload | 120 | A long resume's lines and skills |
| Words looked through | 3,000 | Six lookups a word, 74 to a D1 statement: under 400 statements |
| Candidates for one job | 4 | Two labels in a title, each in both sources |
| Candidates for one fact | 6 | Three things in a line, each in both sources |
| Occupation profiles read | 8 | A profile is the dearest read |
| Questions to the judge | 120 | What offers may ask in its one three-minute try |

The row that would take the words looked through past 3,000 is left, and so is every row after it. A cut to four or six is made before anything already decided is taken out, so a reading that is retried considers the same candidates. Roles are asked about first, in calls of 20 questions: seven calls at most for the chat judge, or 120 typed decisions.

These numbers come from arithmetic, not from measurement.

## What is not built

- **Vector candidates:** concepts near a line in meaning that its words do not name. They wait for the index of step 2. When vector candidates are built, a concept found word for word in a subject's text is never also a vector candidate for it, so a subject holds one row for a concept and its method names the one source.
- **Tags on parts of a line.** A part gets none yet ([splitting.md](splitting.md)).
- **Tags on postings** and their requirements.
- **Any screen, and the owner's review.** Nothing shows a tag, and nobody can confirm or reject one.
- **Any use of tags:** matching and coverage by concept, years per skill, the private card. A reading tags every fact it proposed that is not marked sensitive, whatever is decided about the fact later, and a fact marked after it was tagged keeps its tags. Nothing reads the tags, so nothing has to be held back yet: the first use of them for anyone but their owner has to leave out the tags of every fact `usableFacts()` leaves out.

## What has and has not been measured

- **Tested with stand-in models and a made-up taxonomy:** candidates, the rule, the questions and their answers, the caps and what was decided before, on labelled examples that include wrong tags only the judge can stop (`test/unit/tag.test.ts`); the stage off, on, without a taxonomy, beside a line marked sensitive before it starts and while it asks the judge, retried, failing and out of time, and where its tags go (`test/integration/tag-shadow.test.ts`).
- **Not run:** the eval against the real judge (`npm run evals`, `test/evals/tag.eval.ts`). It needs model credentials. It asks the judge the way the Worker does for the configuration it reads, fails if a candidate labelled wrong is tagged, refuses a run that found no candidate or in which a method proposed no tag where the labels expect some, and reports precision for each method.
- **Not measured:** the precision of each method's tags. That needs lines given with consent and the real taxonomy: the labelled examples and the taxonomy they are read against are made up, and cannot set a threshold. Nor has the stage's cost in D1 statements been run against a deployed Worker.

Nothing is shown to anyone until that is measured.
