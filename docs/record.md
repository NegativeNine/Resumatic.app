# The record beside the lines

A vault holds a person's facts and roles, each with the quote it was read from. This document describes what the vault can now hold *about* those lines: how a line divides into parts, which taxonomy concepts a line or a role shows, and which facts or roles say the same thing.

It is step 3 of the [pipeline design](taxonomy-pipelines-design.md). The vocabulary and the rules that need no storage are in `src/shared/record.ts`; the tables and the store are in `src/vault/record.ts`.

**Status: the tables, the store and its rules exist and are tested. Three things write to them, all in shadow and only where switched on, which is nowhere by default: divisions of lines ([splitting.md](splitting.md)); notes of roles and facts that repeat an earlier one word for word, and offers of two wordings as the same fact ([merging.md](merging.md)); and tags on facts and job roles ([tagging.md](tagging.md)). By default nothing is merged, no screen shows any of it, and tailoring does not use it. The owner-only review increments below are optional. Existing pipeline model judgements remain in shadow; the proposal review never promotes them.**

## What is kept

| Judgement | Tables | What it says |
| --- | --- | --- |
| How a line divides | `fact_splits`, `fact_parts` | The claims a line makes, the outcome of each, and the tools, names and figures inside them |
| A tag | `record_tags` | That a fact, a part of one, or a role shows a concept from the [taxonomy](taxonomy.md) |
| A link | `record_links` | That two facts or two roles say the same thing, or that one fact is a fuller version of another |

None of these changes a fact, a role or a quote. Each is a row beside them, and removing the row removes the judgement.

## What every judgement carries

- **What made it:** a rule in the code, a model, or the owner; the model's name if one did; the rule or check and its version (`identical-wording/3`); the taxonomy build it was made against; and how sure the check was, where it says.
- **What was decided:** it starts as *proposed*. Only the owner confirms or rejects it, with the one exception under "Merging without asking" below. A model never decides.
- **Whether it is in shadow.** A shadow judgement is stored to be measured and shown to nobody. The owner cannot decide it, it merges nothing, and nothing but measurement reads it. A judgement that shows and one in shadow can exist side by side.

The owner undoes a judgement by deciding it the other way. A rule or a model that proposes the same thing again never reopens what the owner decided.

## Parts of a line

A part is a list of positions in its fact's text and a kind. No wording is stored for it: its words are read from the line each time, so a part cannot say anything its line doesn't.

| Kind | Is |
| --- | --- |
| Clause | One claim the line makes |
| Result | A claim that states an outcome of another, and which one |
| Mention | A tool, a named thing or a figure inside a claim. Never a claim by itself |

**A part is whole words.** A range can start and end only at the edge of a run of characters with no space in it. It may leave off brackets and quotation marks before a run, and brackets, quotation marks and sentence punctuation after it. An em dash separates runs as a space does. So from "Led migration (Python, Go)" a part can take "Python", but:

| Line has | A part can't take | Because it would say |
| --- | --- | --- |
| unhelpful | helpful | the opposite |
| co-founder | founder | more than the line |
| -5% | 5% | the opposite sign |
| 40% | 40 | a different amount |
| $1.2M | 1.2M | a different unit |
| CI/CD | CI | half a name |
| 2019–2021 | 2021 | one end of a range |

The record also refuses parts that are out of order, overlap inside one part, repeat, or don't fit together: a division needs at least one clause, a result must lead to a clause, and a mention must sit inside a claim.

**What the record does not check.** Whether a part means what the line means cannot be told from positions. Whether a line with "helped" or "not" in it may be divided at all, whether anything was left out, whether each part reads the same alone, and whether a result is the outcome of the claim it names are checked where a division is proposed (step 4), and a division that passes here can still be refused there.

**One division at a time.** A new proposal replaces one nobody has decided. It never replaces a division the owner accepted, and one the owner turned down is not stored again. The owner dividing a line themselves replaces whatever stood. A skill is one item and has no parts.

## Tags

A tag names a concept by its taxonomy ID, with the concept's kind and its label at the time, so a tag can be read without the taxonomy at hand. How it relates follows from the kind of concept:

| On | Concept | Relation |
| --- | --- | --- |
| A fact or a part | Skill, knowledge, or a group of them | shows |
| A fact or a part | Tool, or a category of tools | uses |
| A fact or a part | Work activity, or a task | does |
| A role | Occupation, or a group of them | occupation |

A role is tagged only with occupations, and only a role is. What a role shows is what its facts show.

The record checks that the ID is in the taxonomy's own form. It cannot check that the concept exists; the step that proposes tags chooses only from the taxonomy's candidates. A fact, part or role holds at most 64 tags.

## Links, and how a fact has several pieces of evidence

`same` merges one fact into another, or one role into another. **Nothing is moved or rewritten to do it.** Both rows stay, each with its own quote. Once the link is confirmed, the fact it points to stands for both, and its evidence is read as its own quote followed by the quote of each fact merged into it. That is how one fact keeps the quote from every upload that states it. Separating two facts is rejecting the link, and each stands alone again exactly as it was.

`fuller` says one fact states everything another does and more. Both stay and neither stands for the other.

- **Facts merge only inside one role.** Two facts can be linked where it shows only if they sit in the same role, in roles that were merged, or in no role. If the owner later separates the roles, the merges between their facts stop holding, and they hold again if the roles are rejoined. No row changes either time; each link says whether it holds.
- **One at a time.** A fact or role is merged into one other at most, and never in a circle. Two items are joined one way at a time. The owner's own choice replaces an offer nobody had decided; nothing else replaces anything.
- **What the owner separated stays separate.** Once the owner turns down a merge of two facts or two roles, no rule or model proposes that merge again, whichever of the two it would have stand for both. A rule also merges nothing without asking that would put the two back in one group: not one of them into a fact the other stands in, and not a fact that stands for one of them into the other. Merges between facts whose roles are apart for now are counted, because they hold again when the roles are rejoined. Only the owner joins the two again. An offer that the owner's own choice replaced is recorded as turned down by the owner and counts here like any other, though the owner never said the two differ: the two are not offered as the same again, and a rule merges nothing that would bring them together. Such a merge can still be offered for the owner to accept. A finding kept in shadow is not affected: it stands for nothing.
- A fact or role holds at most 128 links.

### Merging without asking

One judgement can be confirmed by a rule instead of the owner, and the record checks the grounds itself before it stores it:

- **Two facts** of the same kind, in one role, whose wording is identical once presentation is removed: bullets, paired Markdown marks, runs of spaces, the shape of quotation marks, and one full stop at the very end. Case, numbers, dates, and every other mark must match. That includes a number or a sign a line starts with: "1. Staatsexamen" and "2. Staatsexamen" are two credentials, and "- 5% churn" is not "+ 5% churn". A dash, a plus or a heading mark is a bullet only when a word follows it, and a leading number never is one, because what was read from an upload lost its list numbers when it was read. Outside any role this applies to skills and credentials only: an accomplishment that was read without a job has no role that was found to be the same one, so it is offered instead.
- **Two roles** alike in every field that names a role: the same kind, organisation and title, the same known start, and the same end or none in both. A missing title, an unknown date, or a date written more exactly in one than the other is not enough.

Anything else a rule or a model finds is stored as an offer. The owner can separate a merge made this way, and no rule will make it again: not as it was, not the other way round, and not by way of a third fact or role.

## When words change

A judgement is about particular words. These rules are triggers in the vault's storage, so they hold for every writer, including code written before the record existed.

| Change | Goes | Stays |
| --- | --- | --- |
| A fact is reworded | Its parts; its tags, confirmed or not; every link from it; every `fuller` link to it; undecided and rejected offers to merge into it | Facts already merged into it. Their quotes stay beside it, as its own original quote does |
| A fact changes in any other way (state, level, role) | Nothing | Everything |
| A role's kind or title changes | Its occupation tags | |
| Any field that names a role changes | Every link from it; undecided and rejected offers to merge into it | Roles already merged into it |
| A fact or role is deleted, as a retried reading of an upload does to what it proposed | Everything about it | |
| A division is replaced or turned down | The tags on its parts | |

Dropping a confirmed tag when its fact is reworded is deliberate: the tag was confirmed for words that are gone. It is a starting rule and can be loosened once tagging is measured.

## Where it goes

- **Export.** `factSplits` (each with its parts and their words), `conceptTags` and `recordLinks` are in the JSON export, in every state, shadow judgements included and marked.
- **A vault moved to a replacement** takes all four tables with it.
- **Deleting the account** deletes them with everything else.
- **The card preview** reads confirmed, non-shadow tags of usable facts and confirmed jobs, and shows their owner only taxonomy groups ([visibility-design.md](visibility-design.md)).
- **Nowhere else.** A coach's copy, a connected app and a saved resume version hold what they held before. A copy shows the line, not its parts.

## What is not built

- Divisions are proposed only in shadow and only where switched on (step 4, [splitting.md](splitting.md)). Identical copies are noted the same way, and so are offers of two wordings as the same fact (step 6, [merging.md](merging.md)). Tags are proposed the same way, on facts and job roles only; a part gets none yet (step 5, [tagging.md](tagging.md)).
- Existing non-shadow divisions and tags have the separately gated owner review below. Pipeline divisions and tags still run only in shadow and cannot be promoted through it. Semantic offers have no review screen or decision route. Deterministic identical copies have their own gated review.
- Tailoring does not read tags, parts or merges (step 8). The list of facts still shows every fact, including one merged into another.
- A fact's record does not yet hold when a skill was used, which years per skill needs.

## Owner review of identical copies

`IDENTICAL_REVIEW_ENABLED=true` enables the first review increment in staging. It is absent by default, and production configuration refuses it until rollout acceptance is recorded. It exposes no model split, tag or semantic offer.

- In To check and All facts the owner can choose **Group identical copies**. This calls `POST /api/v2/record/identical`; merely opening Facts, reading the vault or counting Today writes no links. Grouping uses the existing deterministic identity rules, roles first, and never rewrites or deletes a source row. New uploads are grouped only when the owner asks again.
- A grouped item shows each source quote and source-context control. Copies with different review states, privacy marks, levels or review warnings remain separate questions. The earliest identical row supplies the group identity; its state or privacy never replaces another copy's.
- **Keep the copy … separate** rejects its deterministic link. Repeating grouping or adding another upload respects that choice. **Show these identical copies together again** is an explicit owner action, not an automatic reopen.
- The decision route `POST /api/v2/record/links/:id` accepts only non-shadow deterministic links, checks both current row revisions, and rechecks identical identity before rejoining. Another owner's ID is not found. Shadow and model links cannot be decided through it.
- Every row, its words and its evidence remain intact. Export contains the decisions in the existing record-link tables; no migration, coach-copy change or tailoring-by-merge behavior is added.

Real staging acceptance, including two owner sessions and large vault performance, remains required before production enablement. The separate measurement bars for model proposals are unchanged.

## Owner review of existing parts and tags

`RECORD_PROPOSAL_REVIEW_ENABLED=true` adds a separate owner review panel under All facts. It is off by default and refused in production configuration until the measurement and rollout requirements are met. It neither switches a pipeline on nor turns a shadow judgement into a visible proposal. Since every current pipeline writes only shadow judgements, the panel initially has nothing to review on real vaults.

`GET /api/v2/record/proposals` reads only existing non-shadow splits and tags on facts, roles and parts. It shows the original line, its source quote and context control, the parts as exact slices, their kinds and outcome relationships, and the stored taxonomy labels. Reading writes nothing. A rejected split is no longer shown and its part tags are removed by the existing record rule; rejected fact and role tags stay visible so the owner may explicitly reconsider them.

The owner can confirm a tag, reject it, accept parts or keep a line whole. `POST /api/v2/record/proposals/:kind/:id` accepts only an existing non-shadow split or tag in that owner's vault. It compares the current subject revision, judgement state and decision generation with what the panel showed. Decision generations increase even within one clock tick, so a confirm/reject/confirm sequence cannot let an old screen overwrite a later choice. Editing or deleting the subject invalidates its old proposals through the existing triggers.

No original wording, source evidence, shared copy or tailoring input is changed by these decisions, and no migration or proposal-creation route is added. The existing, separately gated owner-only card preview may use a newly confirmed non-shadow tag of a usable fact or role; a part's tag counts there only after its split is confirmed as well. Showing model proposals still requires the measurement bars and explicit rollout acceptance; this flag remains off everywhere.
