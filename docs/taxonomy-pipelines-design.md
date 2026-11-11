# Pipelines around the taxonomy: design

**Status: agreed by the owner on 10 November 2026, with the three starting rules under "Decided" below. Built so far: the taxonomy ([taxonomy.md](taxonomy.md)), the record ([record.md](record.md)), dividing lines in shadow ([splitting.md](splitting.md)), noting identical copies and offers of the same fact in shadow ([merging.md](merging.md)), and tagging facts and roles in shadow from labels found word for word ([tagging.md](tagging.md)). All are switched on nowhere, none has been run against the real models, and none has been measured. Nothing is shown to anyone and tailoring reads none of it. Each step still ships switched off and is measured before anyone is shown its results.**

The aim, in the owner's words: rearchitect around the taxonomy; merge duplicates; and break a single-line experience into its constituent parts without inventing anything or changing its meaning.

## What happens today

**Reading an upload** (`src/workflows/distill.ts`, `src/pipeline/extract`):

1. The file becomes text. Word files keep their paragraph boundaries (`src/pipeline/docx.ts`).
2. A model proposes roles and facts, each with a quote from the text.
3. `verifyExtraction` checks every quote is in the text, then **replaces each fact's wording with its whole source line** and drops any further fact from the same line. Skills are the exception: each is one literal item from a skills list.
4. Facts are saved as proposals, embedded, and reviewed by the owner.

So one line is one fact, however many things it says. That rule exists for a good reason, written in the code: a model's paraphrase or a part of a line can drop a qualifier or a negation, and deterministic checks cannot prove a paraphrase means the same.

**Duplicates.** Every upload proposes all of its roles and facts again. A second resume produces a second copy of each job. `selectFacts` hides exact repeats when a resume is tailored; nothing merges them in the record.

**Tailoring** (`src/pipeline/tailor.ts`). Requirements are phrases read from the posting. Facts are chosen by embedding similarity to each phrase, then a reranker. A requirement with no fact above a similarity threshold is a gap. Nothing says what matched, only that two texts are near each other.

## Principles

Every stage below is held to these. They are what "without inventing or changing meaning" means in code.

1. **The source line is the record.** A fact always points at words copied from the upload. Nothing derived is ever shown as a quote.
2. **A part is a view of its line, not a new sentence.** A part is a set of character ranges in the line. Its words are those ranges and nothing else. This prevents new words, but a selection can still change meaning by dropping context. Range checks and the contextual meaning checks below must both pass; ranges alone do not establish entailment.
3. **When in doubt, the line stays whole.** A split that fails any check is discarded and the line remains one fact, exactly as today.
4. **A tag never changes a fact's words.** A tag links a fact or a part to a concept chosen from a closed list of candidates taken from the taxonomy. A model can pick or decline; it cannot write a concept.
5. **A merge never blends.** Two statements become one fact only when each says everything the other says. The wording kept is one source's own. A merged fact that neither source states is never written.
6. **Every judgement is stamped and reversible.** A split, tag or merge records the taxonomy version and the model that made it, starts as a proposal, and can be undone by the owner.

## The record

Additions to the vault. Existing rows keep their meaning; nothing is rewritten.

| Addition | Holds |
| --- | --- |
| A fact can have several pieces of evidence | Today a fact has one quote. A merged fact keeps the quote from every upload that states it |
| Parts of a fact | For a line that has been split: each part's kind, its ranges in the line, and what it is a result of |
| Tags | A fact or part, a concept ID, how it relates (uses a tool, shows a skill, is an activity), who decided, the taxonomy version, and proposed, confirmed or rejected |
| A role's occupations | The ESCO and O\*NET occupation a role is closest to, as tags on the role |
| Links between facts | "Same as" (merged) and "a fuller version of" (kept apart, shown together) |

Saved resume versions, shared copies and documents capture the facts they used when they were made. They are not affected.

These are built, and [record.md](record.md) says how each is stored and what the record refuses. One choice made there belongs here too. A merged fact's further evidence is not copied onto it: each upload's line stays its own fact with its own quote, and a confirmed "same as" link makes one fact stand for the others. Its evidence is then read as its own quote and theirs. Nothing is moved, so a merge is undone exactly by rejecting the link. Roles are linked the same way, and a merge of two facts holds only while their roles are one.

## Reading, redesigned

```
text → lines → roles → facts (one per line, as today)
                         ├─ split into parts      (new, checked, optional per line)
                         ├─ tag with concepts     (new, checked)
                         └─ match against the record: same, fuller, or new   (new, checked)
```

Steps 1 to 4 of today's reading stay as they are, including the whole-line rule. The three new steps each add proposals beside the line fact. If all three are switched off, reading is exactly today's.

### Splitting a line

A model proposes how a line divides. It answers with ranges, never with words:

- **Clauses.** Each claim the line makes, as ranges that include its verb and everything the verb governs. "Designed and built the API" is two clauses that share "the API".
- **Results.** A clause that states an outcome of another ("…, cutting deploy time from 40 minutes to 6") and which clause it is the outcome of.
- **Mentions.** Tools, named things and figures inside a clause. A mention is never a claim by itself.

The proposal is then checked. All of the checks are on the ranges, and any failure keeps the line whole:

| Check | How | Guards against |
| --- | --- | --- |
| Ranges are real | In bounds, in order, not overlapping within a part | A malformed answer |
| Nothing is lost | Every number, name and content word of the line is inside some part. Only a closed list of joining words may be left out | A dropped figure or qualifier |
| Qualifiers stay attached | A line with a negation, a hedge or an intention ("not", "helped", "assisted", "proposed", "up to", "part of") is not split in the first version | "Helped lead X and Y" becoming "lead Y" |
| Scope is not raised | The existing level check (`scopeRank`) on each clause must not exceed the line's | A part reading as more senior than its line |
| Numbers stay with their subject | The existing number checks (`checkClaim`) on each clause against the line | A figure moving to the wrong claim |
| Reads the same alone | The judge is asked, for each clause, whether the line states it with nothing added and nothing changed when it is read alone. It must answer yes with high confidence | Meaning that depends on the rest of the line |
| Nothing unsaid | The judge is asked whether the parts together say everything the line says | A split that is accurate but incomplete |

A part is shown under its line, in the line's own words. It is never printed on a resume as it stands: the writer still composes each resume line and is still held to the cited facts by the existing checks and judge. What changes is that the writer can cite one part of a line without the rest, and that a requirement can match one part.

### Tagging

For a fact or a part:

1. **Candidates** come only from the taxonomy: labels found word for word in the text (`mentions`), concepts near the text in a vector index of the taxonomy, and the usual skills, activities and software of the role's occupation (`profile`) to order them. The occupation's profile never adds a tag by itself.
2. **A decision per candidate.** The judge is asked a closed question: does this text say the person did this, used this, or knows this? Yes with high confidence makes a proposed tag. Anything else makes none. A weak mention (a short everyday word that is also a label) needs the same yes.
3. **A skill from a skills list** whose text unambiguously identifies one concept by its source label can receive a proposed tag without a model. A label shared by multiple concepts, a derived label, or a weak everyday word requires disambiguation; an exact spelling alone does not decide which concept the owner meant.

Roles get their occupations the same way: candidates from the title (ESCO's other labels and O\*NET's job titles) and from the role's facts, then a closed decision, then the owner's confirmation.

### Merging

Roles first. Automatic identity requires the same kind, organisation and title, and known compatible date anchors (including an explicit ongoing status where applicable). Two absent or unknown dates do not establish identity: those roles are offered to the owner. Roles that agree on organisation and overlap in time but differ in title are offered to the owner, never merged alone, because that is also what a promotion looks like.

Then facts, within one role:

| The new fact, against one already in the record | Result |
| --- | --- |
| Same words after presentation-only cleaning, in a confirmed identical role | The same fact. The new upload's quote is added to it as further evidence. Cleaning cannot remove qualifiers, negation, dates, numbers or meaningful punctuation |
| Each says everything the other says (judge, both directions, high confidence) | Offered as the same fact. If accepted, one wording is kept and both quotes |
| One says everything the other says and more | Kept apart and linked as a fuller version. Tailoring prefers the fuller one |
| Anything else | A new fact |

Candidates for the judge are found by shared tags, shared numbers and names, and embedding similarity, so it is asked about few pairs. A wording is never composed from two statements.

## Tailoring, redesigned

1. The posting's requirements are tagged with concepts by the same candidate-then-decision step, and the posting gets an occupation.
2. Facts and parts that share a concept with a requirement, or sit directly above or below it in the taxonomy, are candidates first. Hierarchy and crosswalk links do not establish coverage: a broad skill does not prove a narrower skill, and a related occupation does not prove an individual's experience. The requirement must still be checked against the cited evidence, including level, qualifiers and duration. Embedding similarity remains a fallback, including when tags are absent or uncertain.
3. Coverage states which requirement is supported by which confirmed facts, with concepts explaining the match. No tag, a failed lookup or an uncertain decision means unknown, not a claim that the person lacks experience. If the available evidence does not support a requirement after the fallback check, describe it as not evidenced in this record. Never infer a confirmed gap solely from an absent concept.
4. Writing and checking are unchanged: a closed set of facts, citations, deterministic checks, the judge, one repair, then the fact's own words.

Tags support the **coded profile** the private card needs. **Years per skill** additionally requires an evidenced or owner-confirmed interval for using that skill; a mention in a five-year role does not establish five years of use. Count supported intervals once where they overlap, preserve date precision, and leave duration unknown where no interval is supported. Any role-duration estimate must be explicitly labelled as an estimate and must not satisfy a posting's years requirement as an established fact.

## Where career text goes

The taxonomy is public reference data in a database of its own. Looking a line up in it sends the line's words to that database as query values and stores nothing there. The vector index is queried with an embedding of the text, made on Workers AI as fact embeddings are. Parts, tags, links and occupations are career data and live in the owner's vault with everything else, are exported with it and are deleted with it. Tags are not shared with a coach or a connected app until that is separately decided.

## Models

No stage needs a new kind of model call. The design is written to sit on the model work already open, and changes none of it.

- **Closed decisions.** Splitting, tagging and merging all ask closed questions: a state, a question, named choices, a probability for each, fail closed. That is what the typed-decision judge added for staging does for resume lines (`src/ai/decision-judge.ts`, #25) and what the relevance scorer does for a requirement and a fact (#27). The new stages use the same kind of call through one small interface, with the schema-constrained `judge` route as the fallback where typed decisions aren't configured.
- **Proposing ranges** for a split uses the extraction route, whichever model it points at.
- **Embeddings.** #27 makes the embedding model a setting each vault moves to in its own time, and gives requirement searches and stored facts different inputs. The taxonomy's vector index is therefore built with one stated model, recorded with the index. A line is embedded with that model to look concepts up, whatever model the vault's own facts use, and the lookup is a query in #27's sense.
- **Ranking.** Matching by concept comes before similarity, not instead of it. The reranker, whichever one is configured, still orders the facts that share a concept with a requirement.

## Order of work

Each step is a pull request, off by default, with its own tests. Steps 3 onward run in shadow first: proposals are stored and measured but shown to nobody.

| # | Step | Depends on |
| --- | --- | --- |
| 1 | The taxonomy: builder, records, lookup | Done in this change |
| 2 | First real build (made and checked on 10 November, and to be made again with the builder as it now is: [taxonomy.md](taxonomy.md)), loaded into staging; a vector index of the concepts | Access to the staging account |
| 3 | The record: evidence per fact, parts, tags, links. No behaviour change | Built: [record.md](record.md) |
| 4 | Splitting, in shadow, with labelled examples in the extraction evals | 3. Built: [splitting.md](splitting.md). Not yet run against the real models or measured on real lines |
| 5 | Tagging facts, roles and postings, in shadow | 2, 3. Built in shadow for facts and roles, from labels found word for word ([tagging.md](tagging.md)). Vector candidates wait for step 2's index; parts and postings are not tagged. Not run against the real judge or measured |
| 6 | Merging roles and facts, in shadow, then offered in review | 3, 5. Built in shadow: identical roles and facts are found by rule, and two wordings of one thing are put to the judge and kept as offers ([merging.md](merging.md)). Not yet run against the real judge or measured. Offering them in review waits for step 7 |
| 7 | Review screens: parts under a line, tags, merge offers | 4 to 6 |
| 8 | Tailoring by concept, coverage by concept, years per skill | 5 |

## What must be measured before anything is shown

- **Splitting:** on labelled lines, how often an accepted split changes meaning. The target is zero on the labelled set; a single failure sends the rule that allowed it back for tightening. How often a good split is refused is tracked but is not a blocker.
- **Tagging:** precision of proposed tags on labelled facts, separately for word-for-word and vector candidates.
- **Merging:** how often two facts offered as the same are not. Automatic merging is limited to identical words until this is known.

These need real resumes with consent, as the existing extraction evals do. Synthetic lines can exercise the checks but cannot set a threshold.

## Decided

The owner agreed these on 10 November 2026. Each is a starting rule: it can be loosened once the measurements above say it is safe to.

1. **Qualified lines stay whole.** The first version does not split a line that contains a hedge, a negation or an intention. It leaves some lines whole that a person would split.
2. **A coach sees the line, not its parts.** The owner reviews parts as they review facts. A shared copy shows the line.
3. **Only identical wording merges without asking.** In a role confirmed to be the same one. Everything else is offered.

## Still open

- **Languages.** The first build is English. ESCO is published in 28 languages and O\*NET in English only, so other languages would have skills and occupations from ESCO but no activities or software.
- **Who may see the private card.** Its preview is built from confirmed tags; its sharing rules need their own decision.
