# The combined taxonomy

Resumatic describes work in the terms of two public classifications, held as one set of records:

- **ESCO** (European Commission) supplies the **skills and knowledge**: about 14,000 concepts, each with a preferred label, the other labels people use, and a description, plus about 3,000 occupations and the skills each one needs.
- **O\*NET** (U.S. Department of Labor) supplies what ESCO lacks: about 1,000 occupations described by their **tasks**, **work activities** and **software**, and the **job titles** people hold in them.
- The **official O\*NET - ESCO crosswalk** joins the two at the level of occupations.

This document says what is in the taxonomy, how it is built and loaded, how the app reads it, and what must be credited. The redesign of the reading and tailoring pipelines that uses it is set out in [taxonomy-pipelines-design.md](taxonomy-pipelines-design.md).

**Status: the builder and the lookup exist and are tested on small synthetic files, and one build from the real downloads was made and checked on 10 November 2026 (see "What has and has not been checked"). The builder changed after it, so the build was made again from the same downloads on 11 November 2026 and that build was loaded into a D1 database on the staging account. The staging deployment binds it as `TAXONOMY` through its hand-applied configuration; the committed configuration binds none. Three parts of the app read one where it is bound and switched on, which is nowhere yet: tagging in shadow, where `TAG_SHADOW_ENABLED=true` ([tagging.md](tagging.md)); the owner's card preview, which reads it with the owner's confirmed tags that are not in shadow, where `CARD_PREVIEW_ENABLED=true`; and the operator's build of the vector index, where `TAXONOMY_VECTORS` is bound beside it and tagging is switched on. Its concepts can be indexed as vectors for tagging in shadow; no index has been built on staging.**

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

**Labels.** Every name a concept is known by, as the source writes it and in a comparison form (lower case, no accents, punctuation around words dropped, `c++`, `c#`, `.net` and `node.js` kept whole). An accent is dropped however the text encodes it, as one character or as a letter followed by a combining mark, and a character nobody sees (a soft hyphen, a zero-width space) does not end a word. Types: `preferred`, `alternative` (including O\*NET job titles), `hidden` (ESCO's hidden terms) and `derived` (made by the builder, below). Task statements are not labels.

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
4. **`same-label`.** Only when the label belongs to exactly one concept on each side. On the O\*NET side the label must be a name O\*NET itself gives the software: a name the builder shortened (item 1) is never joined on, because what is left of "Migration software" is ESCO's "migration", the movement of people. On the ESCO side a hidden term is never joined on; a label without its bracketed qualifier is.

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

The output folder is replaced, not added to, so that no file of an earlier build is left to be loaded with the new ones. The builder does that only to a folder that is new, empty, or holds an earlier build, which it knows by the `manifest.json` a build writes last. It refuses any other folder with something in it, and any folder that the files it is reading are in, and it removes nothing when it refuses. Naming the folder the downloads are kept in, or a checkout, as `--out` stops the build. The folder the files are in is known by what it is on disk and not by how a path to it is written, so it is refused all the same when `--out` or the files are named through a link.

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
- **Rebuilt and loaded on 11 November 2026.** The [manifest](taxonomy-build-2026-11-11.json) records version `esco-1.2.1+onet-31.0+3f810824`: the same 49,438 concepts and 207,939 labels, and 265,342 relations, 64 fewer than before, all of them `same-label` relations that rested only on a name the builder had shortened (101 remain; 2 ambiguous joins are set aside, where there were 5). None of ESCO's 25 repeated concept rows differs from its first occurrence. The 17 SQL files loaded into SQLite with matching counts and a clean integrity check, and then into the staging D1 database `resumatic-taxonomy-esco-1-2-1-onet-31-0-3f810824` with the documented loop; there `taxonomy_meta` names the version and the three tables hold exactly the counts it records.
- **The 10 November build is not the one to load.** The builder has changed since it was made, in two ways. It no longer joins an O\*NET software example to an ESCO concept on a name it shortened itself: 64 of that build's 165 `same-label` relations rested on nothing else, among them "Migration software" joined to ESCO's "migration" of people. The same downloads therefore give other relations and so another version; the concepts, the labels and every other relation are as they were. And its SQL now says what the taxonomy is in its last statement, with the count of records, where that build's SQL said it in the first file before any record was in. The app reads a database loaded from that build's SQL as not loaded (see "Loading it").

## Loading it

A taxonomy is loaded once into a D1 database of its own and never changed. A new version is a new database, and the binding is moved to it.

```sh
npx wrangler d1 create resumatic-taxonomy-<version>
for f in <folder>/d1/*.sql; do npx wrangler d1 execute resumatic-taxonomy-<version> --remote --yes --file "$f" || break; done
npx wrangler d1 execute resumatic-taxonomy-<version> --remote --command "SELECT key, value FROM taxonomy_meta"
```

Every file is run, in order, and the loop stops at the first one that fails. `--yes` answers the question wrangler asks before it runs a file on a remote database (the database serves no queries meanwhile, and nothing reads this one yet). Asked at a terminal and answered "no", wrangler leaves the file out without an error, and the loop would go on to the next. The last statement of the last file says what the taxonomy is: its format, version, content hash and sources, and how many concepts, labels and relations it has (`records`). It writes those rows together or not at all, and only when the three tables hold exactly as many rows as the builder wrote. So a database names a version only if every record is in it:

- The last command above prints the version that is in `manifest.json`, and how many records the database was found to hold. If it prints no rows, the load is not complete.
- A load that left a file out ends with the last file failing: `NOT NULL constraint failed: taxonomy_meta.value`.
- The app reads a database without those rows as not loaded, and `info()` fails with "the taxonomy is not loaded". That holds for a database with nothing in it, for one loaded part of the way, and for one loaded from SQL made before the builder wrote the counts.

A load that failed is started again in a new database, and the old one is deleted rather than repaired. The check is a count of rows, made once as the load ends. It does not compare contents, and the app does not count again when it reads: a taxonomy's database is not written to after its load. To count again by hand, for instance before a binding is moved to a database, compare what was written with what is there:

```sh
npx wrangler d1 execute resumatic-taxonomy-<version> --remote --command "SELECT (SELECT value FROM taxonomy_meta WHERE key = 'records') AS written, (SELECT COUNT(*) FROM concepts) AS concepts, (SELECT COUNT(*) FROM labels) AS labels, (SELECT COUNT(*) FROM relations) AS relations"
```

Then bind it as `TAXONOMY` in the environment that should read it. The binding is optional: where it is absent, `taxonomyFor(env)` is null and the app behaves as it did before. Nothing in this repository binds it yet.

Anything derived from the taxonomy (a tag on a fact, an occupation on a role) must store the taxonomy version it was made with, so that a later version can be told apart and re-checked.

## Reading it

`src/taxonomy` gives the pipelines four reads. None of them decides what a text means.

| Call | Answers |
| --- | --- |
| `mentions(text)` | The labels that appear word for word in a text, with their positions and concepts. The longest wording wins. A single word that is thin evidence is marked `weak` (below) |
| `lookup(label)` | The concepts that carry exactly this label |
| `broader(id)` | The concepts above this one, nearest first |
| `profile(occupation)` | The occupation through both sources: ESCO's skills, O\*NET's activities and software, with each item saying which occupation's record it comes from and how the crosswalk relates it. Every occupation the crosswalk relates to it is read, however many (in the 10 November build one O\*NET occupation has 82), closest match first and those of one match type in ID order |

A mention is a candidate, never a tag. Deciding that a line shows a skill is a separate, checked step (see the design).

A mention of one word is `weak` when any of these holds:

- the word is one or two characters long ("go", "R");
- only a label the builder made carries it ("Testing", which is O\*NET's "Testing software" shortened);
- every label a source wrote for it has a capital, and the text writes it as none of them does: "excel" for Excel, "Did" or "did" for DID, "PYTHON" for Python.

A capital alone is not evidence, because every line starts with one. A label that is itself lower case ("communication") is an everyday word and is matched however the text writes it. How the text writes a word is how a person reads it: a character nobody sees in the word or straight after it, and an accent encoded another way, are not another spelling, in the text or in a label. The flag goes by spelling and nothing else: an everyday word that the text writes exactly as its label is written ("Chef at a 40-seat bistro", beside the software called Chef) is not marked, and telling those apart belongs to the checked step.

In every other way the comparison is exact. These count as other spellings: two letters a typesetter joined into one character ("Conﬂuence"), a curly apostrophe where the label has a straight one, a plain digit where the label has a superscript ("PM2" for PM²). A word is compared without the punctuation around it, so one word is never a firm match for a label that ends in punctuation the word reader leaves out: "Act!", "Kahoot!" and four more in the 10 November build are weak however the text writes them.

The text these reads are given is someone else's (an upload, a job posting), so what reading it can cost is bounded. `mentions` refuses a text of more than 20,000 characters, and `lookup` finds nothing for one: no label is over a hundredth of that. Within the limit, a word may carry any number of combining marks and unseen characters. They are dropped before the word is put in its comparison form, and a word too long to be any way of writing its label is not compared with it, so the time a pile of marks on one letter takes to read grows with the pile and not with its square.

Limits today: English only, and exact wording only. Concepts a line describes in other words are found in the vector index below.

## The vector index

One taxonomy version has one Vectorize index of its own, with the concepts tagging uses (skills, knowledge and their groups, work activities, software and its categories, and occupations) as vectors. It is built once by an operator, on staging only:

1. `npx wrangler vectorize create resumatic-taxonomy-<hash8> --dimensions=1024 --metric=cosine`. Only cosine is supported; the build checks the metric and stops with `metric` otherwise.
2. `npx wrangler vectorize create-metadata-index resumatic-taxonomy-<hash8> --property-name=kind --type=string`, run before anything is put in. Vectors added before it cannot be filtered, and the build will not finish over them; make a new index instead.
3. Bind it in the staging overlay with `"vectorize": [{ "binding": "TAXONOMY_VECTORS", "index_name": "…" }]`, next to `TAXONOMY`, and set `PILOT_SHARED_BUDGET` to `"false"`. In pilot mode no `@cf/` model is called, and the build stops with `unavailable`. Set `TAXONOMY_INDEX_BUILD_ENABLED=true` for the operator build; this leaves tagging of uploads off. `TAG_SHADOW_ENABLED=true` also permits a build, but is not required. Both switches default off and the operator build switch is refused in production configuration. The committed configuration binds neither database.
4. Through Access, send `POST /admin/taxonomy/vectors/build` with `{"taxonomyVersion":"…"}`, then poll `GET /admin/taxonomy/vectors`.

Each concept is embedded as its preferred label, its kind and the first 500 characters of its description, with Qwen3 0.6B. A build reserves its spend against `DAILY_SPEND_CAP_USD` in an operator ledger, and is started again to resume. One index holds one taxonomy version.

- **The manifest.** The index describes itself in a record of its own, `manifest`: the taxonomy version, the model, the size, the form of document (`label-kind-description/1`), the kinds, how many concepts it holds, and how far a build has got. Tagging reads the index only when the manifest says it is a complete build of the bound version, by this model and form, for these kinds. A build refuses an index whose manifest names another build: a new version gets a new index.
- **The build** (`src/workflows/taxonomy-index.ts`) pages through the concepts in ID order, 100 at a time. Each page is embedded as documents, then put in together with the manifest's new place, so a build started again goes on after the last page that is in, and a page put in twice leaves the index as it was. A concept ID over 64 bytes is stored under `h:` and its digest, with the ID in the vector's metadata.
- **Complete** means three things: the index counts exactly one vector per concept and the manifest; a lookup filtered by kind finds the first and the last concept as their own nearest match; and that match scores between 0.99 and 1.01, which only cosine gives. Until then tagging reads nothing from it.
- **Starts.** Each start of a build is a Workflow instance named `taxonomy-index-<hash8>-<n>`. A start is refused while any of the twenty is live, even when an earlier one has been deleted, and otherwise takes the first free name; two starts at once take the same name, and the platform refuses the second instance under it. `GET /admin/taxonomy/vectors/build/<id>` gives a build's status and `DELETE` removes it; after twenty attempts the earlier ones are deleted first.
- **What it holds** is public reference data: no line of anyone's is put in it. The routes and the Workflow's state hold counts, codes and concept IDs only.

How tagging uses the index is in [tagging.md](tagging.md). The index is deleted by hand when its version is retired.

## Credits

Both sources are free to reuse with credit. A product that shows taxonomy data must carry both notices, and the manifest of every build repeats them with the O\*NET release filled in:

> This service uses the ESCO classification of the European Commission.

> This service includes information from the O\*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O\*NET® is a trademark of USDOL/ETA. Resumatic has modified all or some of this information. USDOL/ETA has not approved, endorsed, or tested these modifications.

- ESCO: reuse is allowed for any purpose under Commission Decision 2011/833/EU. A modified or adapted version must be clearly indicated as such; "What the builder adds" above is that indication, and it is repeated in each manifest.
- O\*NET: Creative Commons Attribution 4.0. Credit the named release, link the licence, and say where changes were made.

The notices are on the privacy notice and the beta terms, and `test/web/legal.test.tsx` holds them word for word to the latest manifest.

## Tests

- `scripts/taxonomy-build.test.mjs`: the CSV reader, both source readers, the crosswalk reader, joining, the SQL (loaded into SQLite as written, whole and with each file left out in turn), the build command, and that the same files always give the same bytes.
- `test/unit/taxonomy.test.ts`: the four reads over records in memory.
- `test/integration/taxonomy-d1.test.ts`: the same records loaded into D1 answer every read identically, and a database that does not hold all of them is read as not loaded.
- `test/unit/taxonomy-vectors.test.ts`: lookups in the vector index, what makes an index ready, and what a concept's document is. `test/unit/taxonomy-index.test.ts` and `test/integration/taxonomy-index.test.ts`: the build, its refusals, its routes and their Access check, over an index in memory (`test/support/fake-vectorize.ts`). No real Vectorize index has been built.

The test files under `test/fixtures/taxonomy` are synthetic and say so. `test/support/taxonomy-fixture.ts` is generated from them by `node scripts/taxonomy/fixture.mjs`, and a test fails if it is out of date.
