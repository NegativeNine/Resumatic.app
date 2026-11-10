# The combined taxonomy

Resumatic describes work in the terms of two public classifications, held as one set of records:

- **ESCO** (European Commission) supplies the **skills and knowledge**: about 14,000 concepts, each with a preferred label, the other labels people use, and a description, plus about 3,000 occupations and the skills each one needs.
- **O\*NET** (U.S. Department of Labor) supplies what ESCO lacks: about 1,000 occupations described by their **tasks**, **work activities** and **software**, and the **job titles** people hold in them.
- The **official O\*NET - ESCO crosswalk** joins the two at the level of occupations.

This document says what is in the taxonomy, how it is built and loaded, how the app reads it, and what must be credited. The redesign of the reading and tailoring pipelines that uses it is proposed in [taxonomy-pipelines-design.md](taxonomy-pipelines-design.md).

**Status: the builder and the lookup exist and are tested on small synthetic files. No taxonomy has been built from the real downloads yet, no deployment binds one, and no pipeline reads one.** The first real build is the check on the layouts described below.

## What each source is used for

| Need | Source | Why |
| --- | --- | --- |
| Tag what a line of experience shows | ESCO skills and knowledge | Specific and numerous ("manage budgets", "Python"), with the labels people actually write |
| Name the tools in a line | O\*NET software, and ESCO where it names the same thing | O\*NET lists far more named software |
| Say what kind of work a line is | O\*NET work activities and tasks | ESCO has no equivalent list of activities |
| Label a role or a posting | ESCO occupation and O\*NET-SOC occupation | The crosswalk lets either stand for both |
| Know what an occupation usually involves | ESCO's essential and optional skills, O\*NET's activities and software | Read together through the crosswalk |

O\*NET's own skills list is short and general ("critical thinking") and is not loaded: it is too coarse to tag a line with.

## Records

Three kinds of record, written by the builder and read by the app (`src/taxonomy/types.ts`).

**Concepts.** One row per thing either source defines.

| Kind | From | ID |
| --- | --- | --- |
| `skill`, `knowledge` | ESCO skills pillar | `esco:skill:<uuid>` |
| `skill-group` | ESCO skills and knowledge hierarchy | `esco:skill:S1.2.3`, `esco:isced-f:0611` |
| `occupation` | ESCO occupations | `esco:occupation:<uuid>` |
| `occupation-group` | ISCO-08 groups as ESCO publishes them | `esco:isco:C2512` |
| `occupation` | O\*NET-SOC | `onet:occ:15-1252.00` |
| `activity` | O\*NET general, intermediate and detailed work activities | `onet:activity:<element id>` |
| `task` | O\*NET task statements | `onet:task:<task id>` |
| `tool` | O\*NET software examples | `onet:tool:<name>` |
| `tool-category` | O\*NET software categories | `onet:toolcat:<element id>` |

An ID names its source first. An ESCO ID is the concept's URI with `http://data.europa.eu/esco/` removed, so the URI can always be given back.

**Labels.** Every name a concept is known by, as the source writes it and in a comparison form (lower case, no accents, punctuation around words dropped, `c++`, `c#`, `.net` and `node.js` kept whole). Types: `preferred`, `alternative` (including O\*NET job titles), `hidden` (ESCO's hidden terms) and `derived` (made by the builder, below). Task statements are not labels.

**Relations.**

| Relation | Meaning | From |
| --- | --- | --- |
| `broader` | The concept above this one in its own hierarchy | Both |
| `essential`, `optional` | An occupation needs, or may need, a skill | ESCO |
| `skill-essential`, `skill-optional` | A skill needs, or may need, another skill | ESCO |
| `task-of`, `task-activity` | A task's occupation, and the activities it carries out | O\*NET |
| `performs` | An occupation has tasks that carry out an activity, with the count | Computed from O\*NET |
| `uses` | An occupation's people use a tool; whether postings name it | O\*NET |
| `matches` | An O\*NET occupation and an ESCO occupation, with the match type | The official crosswalk |
| `same-label` | An O\*NET tool and an ESCO concept whose labels compare equal | Computed |

## What the builder adds

The builder rewords nothing. It adds four things, each marked so it cannot pass for a source's own:

1. **Derived labels.** An ESCO label without its bracketed qualifier ("Python (computer programming)" also as "Python"), and an O\*NET software example without the final word "software". One-letter results are not made.
2. **IDs for software.** O\*NET's software examples have no IDs, so each gets one from its name. Examples whose names compare equal are one tool.
3. **`performs`.** Counted from O\*NET's Tasks to DWAs file.
4. **`same-label`.** Only when the label belongs to exactly one concept on each side, and never on a hidden term.

Nothing else is inferred. No skill is mapped to an activity. No occupation is matched to another except by the official crosswalk. Rows the builder cannot use (an unrecognised URI, a relation to a concept that isn't in the release) are set aside and counted in the manifest, by kind.

A concept that a file lists more than once is read once, as its first row has it. Each later row is counted as `esco_concept_repeated`, and again as `esco_concept_repeated_differs` when it says something the first row doesn't, so a manifest shows whether a repeat left anything behind.

## Building it

The builder reads the three official downloads from folders on disk:

```sh
node scripts/taxonomy/build.mjs \
  --esco <ESCO classification CSV package, unzipped> --esco-version 1.2.1 \
  --onet <O*NET CSV release, unzipped>               --onet-version 31.0 \
  --crosswalk <O*NET - ESCO occupations crosswalk>.csv \
  --out <folder>
```

It writes `concepts.ndjson`, `labels.ndjson` and `relations.ndjson`, the SQL that loads them (`d1/0001.sql` onwards), and `manifest.json`: every input file with its SHA-256 and row count, what came out by kind, what was set aside, and the credits below. The same files always give the same bytes, and the version (`esco-1.2.1+onet-31.0+<first eight characters of the content hash>`) names them.

### Getting the files

| File | Where | Notes |
| --- | --- | --- |
| ESCO classification, CSV, English | [Official v1.2.1 English CSV ZIP](https://ec.europa.eu/esco/download/ESCO%20dataset%20-%20v1.2.1%20-%20classification%20-%20en%20-%20csv.zip) | Public package verified on 10 November 2026. No email is required for this URL. For another package, use [ESCO's selector](https://esco.ec.europa.eu/en/use-esco/download) |
| O\*NET Database, CSV | `https://www.onetcenter.org/dl_files/database/db_31_0_csv.zip` | The 30.3 release renamed and reorganised the files. Earlier releases are not read |
| O\*NET - ESCO crosswalk (occupations) | [esco.ec.europa.eu, Other crosswalks](https://esco.ec.europa.eu/en/use-esco/other-crosswalks) | One CSV |

The **Taxonomy build** workflow (`.github/workflows/taxonomy.yml`) does the download and the build on GitHub: run it by hand with the verified default URL, and it attaches the built taxonomy to the run. It uses no secrets and changes nothing. When changing the ESCO version, change the URL too.

### What has and has not been checked

- **O\*NET layout:** file and column names are those of the O\*NET 31.0 Data Dictionary (`occupation_data`, `job_titles`, `task_statements`, `tasks_to_dwas`, `gwas_to_iwas_to_dwas`, `software_skills`).
- **ESCO layout:** the 19 files of the classification package, named `<file>_<language>.csv`. Column names are as published for v1.x.
- **Crosswalk layout:** its columns are found by name (an O\*NET code, an ESCO URI, a type of match), after the official project's metadata preamble.
- **Real O\*NET and crosswalk readers checked on 10 November 2026.** O\*NET 31.0 produced 31,201 concepts, 72,687 labels and 104,656 relations, with no reader issues. Its six input row counts matched the published figures: 1,016 occupations, 54,269 job titles, 18,838 task statements, 24,087 task-to-activity rows, 2,087 detailed work activities and 31,821 software rows. The official crosswalk produced 4,253 mappings with no reader issues after fixing preamble handling.
- **Full real-data build checked on 10 November 2026.** The [manifest](taxonomy-build-2026-11-10.json) records version `esco-1.2.1+onet-31.0+c036f953`, 49,438 concepts, 207,939 labels and 265,406 relations. ESCO's unique counts match 13,939 skills/knowledge concepts and 3,039 occupations; its input contains 25 repeated concept rows. That build did not compare those rows with their first occurrences; the builder now counts the ones that differ, so the next build will say whether any label was left behind. Three of 4,253 crosswalk mappings name occupations absent from the current releases and are set aside, leaving 4,250 mappings. One self-relation and five ambiguous same-label joins are also set aside. All 17 generated SQL files loaded into SQLite, with matching row counts, no orphan references and a successful integrity check. Remote D1 loading, vector indexing and pipeline quality remain pending.

## Loading it

A taxonomy is loaded once into a D1 database of its own and never changed. A new version is a new database, and the binding is moved to it.

```sh
npx wrangler d1 create resumatic-taxonomy-<version>
for f in <folder>/d1/*.sql; do npx wrangler d1 execute resumatic-taxonomy-<version> --remote --file "$f"; done
```

Then bind it as `TAXONOMY` in the environment that should read it. The binding is optional: where it is absent, `taxonomyFor(env)` is null and the app behaves as it did before. Nothing in this repository binds it yet.

Anything derived from the taxonomy (a tag on a fact, an occupation on a role) must store the taxonomy version it was made with, so that a later version can be told apart and re-checked.

## Reading it

`src/taxonomy` gives the pipelines four reads. None of them decides what a text means.

| Call | Answers |
| --- | --- |
| `mentions(text)` | The labels that appear word for word in a text, with their positions and concepts. The longest wording wins. A single short or everyday word ("go", "excel") is marked `weak` |
| `lookup(label)` | The concepts that carry exactly this label |
| `broader(id)` | The concepts above this one, nearest first |
| `profile(occupation)` | The occupation through both sources: ESCO's skills, O\*NET's activities and software, with each item saying which occupation's record it comes from and how the crosswalk relates it |

A mention is a candidate, never a tag. Deciding that a line shows a skill is a separate, checked step (see the design).

Limits today: English only, and exact wording only. Finding the activity or skill a line describes in other words needs a vector index of the concepts, which is the next step.

## Credits

Both sources are free to reuse with credit. A product that shows taxonomy data must carry both notices, and the manifest of every build repeats them with the O\*NET release filled in:

> This service uses the ESCO classification of the European Commission.

> This service includes information from the O\*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O\*NET® is a trademark of USDOL/ETA. Resumatic has modified all or some of this information. USDOL/ETA has not approved, endorsed, or tested these modifications.

- ESCO: reuse is allowed for any purpose under Commission Decision 2011/833/EU. A modified or adapted version must be clearly indicated as such; "What the builder adds" above is that indication, and it is repeated in each manifest.
- O\*NET: Creative Commons Attribution 4.0. Credit the named release, link the licence, and say where changes were made.

The notices are not in the app yet because the app shows no taxonomy data yet. They go on the privacy and terms pages in the same change that first shows any.

## Tests

- `scripts/taxonomy-build.test.mjs`: the CSV reader, both source readers, the crosswalk reader, joining, the SQL (loaded into SQLite as written), the build command, and that the same files always give the same bytes.
- `test/unit/taxonomy.test.ts`: the four reads over records in memory.
- `test/integration/taxonomy-d1.test.ts`: the same records loaded into D1 answer every read identically.

The test files under `test/fixtures/taxonomy` are synthetic and say so. `test/support/taxonomy-fixture.ts` is generated from them by `node scripts/taxonomy/fixture.mjs`, and a test fails if it is out of date.
