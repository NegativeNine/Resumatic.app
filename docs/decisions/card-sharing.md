# Decision: who may see the private card

**Waiting for: the owner, and counsel before any visibility is turned on. Written on 11 November 2026 against `main` at `3d7c9fe`.**

## The question

The private card is a short, coded profile built from a person's confirmed records: occupation, seniority, skills and their evidence. Who may see it? Specifically: only its owner; also a coach; may job preferences feed it; and what has to be true before anyone else, such as a recruiter, can see it?

## Why it blocks what

- **The pipeline design left it open.** "Who may see the private card. Its preview is built from confirmed tags; its sharing rules need their own decision" ([taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md), "Still open", line 163). The roadmap says the same ([roadmap.md](../roadmap.md), taxonomy step 7).
- **Tags have not been shared with anyone.** "Tags are not shared with a coach or a connected app until that is separately decided" ([taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md), line 118). A card is made of tags.
- **The card preview is being built this round,** owner-only, from confirmed tags only, with a re-identification harness beside it and its own design document. It stores nothing; the card is computed on request. No path confirms a tag yet ([tagging.md](../tagging.md), "What is not built"), so on a real vault the preview is empty until owner review exists. **This round**
- **Visibility is the marketplace.** The system design's levels (Off, Notify me, Anonymous, Open) decide what recruiters see ([system-design.md](../system-design.md), "Consent and introductions", lines 316 to 325), and the [marketplace technical specification](../marketplace-technical-spec.md) lists what must hold first.

## Who could see it

| Viewer | What they would see | Risk |
| --- | --- | --- |
| The owner | Their own card, as a preview | None beyond today: it is built from their own confirmed records |
| A coach the owner names | The card as part of a shared copy | Low for re-identification: a coach already knows who the person is, and a copy's facts say more than a card. It is the first time tags leave a vault |
| A connected app | The card through a tool | Leaves the vault for a third party's model, under that company's terms |
| Recruiters | The card in search, at a visibility level | Re-identification, employer discovery, probing. The whole of the marketplace's controls apply |

## Options

1. **Owner only.** As being built this round.
2. **Owner, and a coach through a copy.** The owner chooses to add the card to a copy. It is fixed when the copy is made, like the rest of it.
3. **Owner, a coach, and a connected app.**
4. **Recruiters too,** through the visibility levels.

## Whether job preferences may feed it

The system design's card has a metro area or remote, job types and availability, and filters on a pay floor that is never shown (line 322 and 325). A person's vault already holds a place, job types, an available-from month and a pay floor ([seeker-release-status.md](../seeker-release-status.md), "Preferences"). But nothing reads preferences except their owner's form, export and a fenced move, and a test pins that (`test/unit/preferences-reach.test.ts`). The privacy notice says "nothing uses them yet" (`src/web/pages/LegalPage.tsx`, line 54).

**Proposal:** not yet. The owner-only preview may show which card fields would come from preferences, as empty fields named, without reading them. Preferences feed a card only when visibility is turned on, and then the pay floor filters and is never shown, as the system design says. That change adds the card builder to the reach test's lists, in a change someone reviews, and rewrites the privacy notice's sentence.

## Recommendation

**Option 2 now, after owner review of tags exists. Option 4 only after the gates. Option 3 not until asked for.**

| Rule | Proposal |
| --- | --- |
| The owner | Always sees their own card preview |
| A coach | Only on a copy the owner makes, and only if the owner ticks the card for that copy. It is a fixed part of the copy, rebuilt and compared on each read as resumes are, and the copy's schema version rises so older code refuses it |
| What the card holds | Confirmed tags only; never a tag of a fact `usableFacts()` leaves out; no quotes; no shadow judgements; years only as [years-per-skill.md](years-per-skill.md) decides |
| Preferences | Not read, until visibility is turned on |
| A connected app | No |
| Recruiters | Not until every item in the list below holds |

## What turning visibility on requires

Nothing a recruiter sees is built. Turning on any level above Off needs all of these:

1. **Counsel's sign-off** for each launch market (Gate 3: consent flows, notices, licensing), and explicit consent to automated matching at opt-in, with human review and a way to contest (system design, line 329).
2. **The re-identification test passed** against the Gate 3 attacker (system design, line 1065). The harness is being built this round. **This round**
3. **The brokered pilot passed** its kill criteria ([brokered-pilot-plan.md](../brokered-pilot-plan.md)).
4. **Owner review of tags,** so a card has confirmed tags to hold.
5. **Blocks and employer discovery controls:** the current employer confirmed as a company family, and a personal email before discoverability (system design, lines 327 and 329).
6. **Content-free notices.** Email notices are being built this round. **This round**
7. **The marketplace objects** in the [technical specification](../marketplace-technical-spec.md): shards, workspaces and threads.
8. **Live billing** for organizations.

## What changes once decided

**Code**

- For option 2: a card part in `ShareSelection` and the snapshot's field list, the rebuild in `ShareStore.read`, and a new snapshot schema version (`src/vault/shares.ts`). The outward canary's copy surfaces (`"copy by its link"` and `"copy as its coach"` in `test/integration/outward.ts`) then gather the card, and a test shows it holds no tag of a withheld fact.
- For preferences: nothing now. Later, the card builder joins the lists in `test/unit/preferences-reach.test.ts`.

**Docs**

- [taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md): "Who may see the private card" moves from "Still open" to "Decided".
- [seeker-threat-model.md](../seeker-threat-model.md): the coach row for a copy that holds a card.
- The privacy notice: a sentence on the card in "Sharing a copy". `test/web/legal.test.tsx` changes with it.

## Who decides

- **Owner:** each option; whether a coach may see the card; whether preferences feed it later.
- **Counsel:** everything in "What turning visibility on requires", and whether a card shared with a coach needs a sentence in the privacy notice before it ships.
