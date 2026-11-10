# Pipelines around the taxonomy: design

**Status: proposal. Nothing here is built except the taxonomy itself ([taxonomy.md](taxonomy.md)). No pipeline code changes until this is agreed.**

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
2. **A part is a view of its line, not a new sentence.** A part is a set of character ranges in the line. Its words are those ranges and nothing else. No text is generated when a line is split, so nothing can be invented at that step.
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
3. **A skill from a skills list** whose text is exactly one concept's label is tagged without a model.

Roles get their occupations the same way: candidates from the title (ESCO's other labels and O\*NET's job titles) and from the role's facts, then a closed decision, then the owner's confirmation.

### Merging

Roles first. Two roles are the same when their kind, organisation, title and dates all agree; that is the rule `selectFacts` already applies when it hides repeats. Roles that agree on organisation and overlap in time but differ in title are offered to the owner, never merged alone, because that is also what a promotion looks like.

Then facts, within one role:

| The new fact, against one already in the record | Result |
| --- | --- |
| Same words after cleaning | The same fact. The new upload's quote is added to it as further evidence |
| Each says everything the other says (judge, both directions, high confidence) | Offered as the same fact. If accepted, one wording is kept and both quotes |
| One says everything the other says and more | Kept apart and linked as a fuller version. Tailoring prefers the fuller one |
| Anything else | A new fact |

Candidates for the judge are found by shared tags, shared numbers and names, and embedding similarity, so it is asked about few pairs. A wording is never composed from two statements.

## Tailoring, redesigned

1. The posting's requirements are tagged with concepts by the same candidate-then-decision step, and the posting gets an occupation.
2. Facts and parts that share a concept with a requirement, or sit directly above or below it in the taxonomy, are chosen first. Embedding similarity remains as the fallback for requirements that match no concept.
3. Coverage is stated in concepts: which requirement is met by which facts, through which skill, tool or activity. A gap is a required concept no confirmed fact carries.
4. Writing and checking are unchanged: a closed set of facts, citations, deterministic checks, the judge, one repair, then the fact's own words.

Two things fall out of the tags without a model: **years per skill** (the months of the roles whose confirmed facts carry a concept, counted once where roles overlap) and the **coded profile** the private card needs.

## Where career text goes

The taxonomy is public reference data in a database of its own. Looking a line up in it sends the line's words to that database as query values and stores nothing there. The vector index is queried with an embedding of the text, made by the same Workers AI model that already embeds facts. Parts, tags, links and occupations are career data and live in the owner's vault with everything else, are exported with it and are deleted with it. Tags are not shared with a coach or a connected app until that is separately decided.

## Models

The closed questions above are what the typed-decision judge added for staging (`src/ai/decision-judge.ts`) does: a state, a question, named choices, a probability for each, fail closed. Splitting, tagging and merging use it through one small interface, with the existing schema-constrained `judge` route as the fallback where it isn't configured. Proposing ranges for a split uses the extraction route. No stage needs a new kind of model call.

## Order of work

Each step is a pull request, off by default, with its own tests. Steps 3 onward run in shadow first: proposals are stored and measured but shown to nobody.

| # | Step | Depends on |
| --- | --- | --- |
| 1 | The taxonomy: builder, records, lookup | Done in this change |
| 2 | First real build, loaded into staging; a vector index of the concepts | The ESCO download link |
| 3 | The record: evidence per fact, parts, tags, links. No behaviour change | |
| 4 | Splitting, in shadow, with labelled examples in the extraction evals | 3 |
| 5 | Tagging facts, roles and postings, in shadow | 2, 3 |
| 6 | Merging roles and facts, in shadow, then offered in review | 3, 5 |
| 7 | Review screens: parts under a line, tags, merge offers | 4 to 6 |
| 8 | Tailoring by concept, coverage by concept, years per skill | 5 |

## What must be measured before anything is shown

- **Splitting:** on labelled lines, how often an accepted split changes meaning. The target is zero on the labelled set; a single failure sends the rule that allowed it back for tightening. How often a good split is refused is tracked but is not a blocker.
- **Tagging:** precision of proposed tags on labelled facts, separately for word-for-word and vector candidates.
- **Merging:** how often two facts offered as the same are not. Automatic merging is limited to identical words until this is known.

These need real resumes with consent, as the existing extraction evals do. Synthetic lines can exercise the checks but cannot set a threshold.

## Open questions for the owner

1. **Qualified lines.** The first version does not split a line that contains a hedge or a negation. That is the safe rule and it leaves some lines whole that a person would split. Is that acceptable to start?
2. **Who sees parts.** Proposed here: the owner reviews parts as they review facts, and a coach's copy shows the line, not its parts. Agreed?
3. **Automatic merging.** Proposed here: only identical wording merges without asking. Everything else is offered. Agreed?
4. **Languages.** The first build is English. ESCO is published in 28 languages and O\*NET in English only, so other languages would have skills and occupations from ESCO but no activities or software.
