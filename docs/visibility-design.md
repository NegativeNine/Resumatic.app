# Visibility and the private card

**Status: Nothing is published. Visibility is Off for everyone and nothing can change it; the owner alone can preview their card, where `CARD_PREVIEW_ENABLED=true`.**

This page says what a card holds, how it is built, how it would be coarsened before anyone else saw it, and what the re-identification harness measures. It applies the marketplace sections of the [system design](system-design.md) ("Consent and introductions" and "Matching") to what the code builds today. The [taxonomy pipelines design](taxonomy-pipelines-design.md) left open who may see the private card; that is still open, and nothing here decides it.

## Levels

The four visibility levels, as the system design sets them. Only Off is built, and it is the only level any account has.

| Level | Recruiters see | The candidate gets | Built |
| --- | --- | --- | --- |
| Off (default) | Nothing; no card exists | Tailoring only | Yes: everyone is at Off |
| Notify me | Nothing; the card is matched but never shown | Openings that fit, with company, title and pay range, and a way to raise a hand | No |
| Anonymous | A card: occupation, seniority, years in bands, skills, each marked evidenced or self-declared, metro area or remote, availability. No name, photo, employer names or dates | Introduction requests | No |
| Open | The card plus current title, employer names and shareable statements; the name appears only after acceptance | Introduction requests | No |

There is no visibility setting, no way to publish, no store of cards, no tool for a connected app and no path for a coach. The preview is computed on each request, shown to its owner and kept nowhere.

## What a card holds

The preview is built only from what the owner has confirmed, and from nothing else: `src/vault/card.ts` reads the material in the Vault, and `src/pipeline/card.ts` builds the card in the Worker from the taxonomy. It holds no name, employer, title, date, row ID or wording of a fact. Every label on it is the taxonomy's own `Concept.label`, never the label a tag stored.

| Field | System design | Preview | Why |
| --- | --- | --- | --- |
| Occupation | From the taxonomy | One taxonomy occupation, from a confirmed occupation tag on the most recent confirmed job | Parents of an occupation belong to the ladder, not the card |
| Seniority | From the two ladders | Left out | Facts store a work-ownership level and the people ladder is not stored. Mapping either to a seniority word would invent a claim |
| Total years | In bands | One overall band, from the dates of confirmed jobs | Education, project and volunteer roles would inflate "experience" |
| Years per skill | In bands | Left out | Needs evidenced or owner-confirmed intervals of use, which wait for an owner decision |
| Skills | Up to 12 evidenced skills at their canonical parent level, each with its evidence label | Up to 12 skill groups or tool categories, from confirmed tags on accomplishments and credentials | Every skill shown is evidenced, so no per-skill evidence label is needed |
| Self-declared skills | Only on an opt-in, labelled | Left out | Skills-list facts are self-declared, and the opt-in does not exist |
| Industries | Listed | Left out | Nothing in the record states one; deriving it from an occupation would add a claim no confirmed fact makes |
| Education level | If shared | Left out | Nothing lets the owner choose to share it |
| Metro area or remote | Listed | Left out | It lives only in the owner's job settings, which nothing may read without a per-use owner decision ([release status](seeker-release-status.md)) |
| Job types | Listed | Left out | The same |
| Availability | Listed | Left out | The same |

The page says the last three are left out, in the owner's own words for them.

## Rules

**Material.** The Vault reads, in one synchronous turn with no await and no write:

- the confirmed, non-shadow tags of `usableFacts()` of kind accomplishment or credential, with relation `shows` or `uses`, and the confirmed tags of the parts of a division the owner has accepted;
- the dates of confirmed jobs, and the confirmed occupation tags on them.

A concept is barred when any non-shadow tag, in any state, names it on a fact marked sensitive or on a part of that fact's division. It stays barred even where an unmarked fact shows it too, because a card that showed it would still say what the marked line says. Shadow tags are never read: they are kept to be measured. Skills-list facts are left out because they are self-declared; `does` tags because they are activities and tasks, and a card lists skills.

**Skills.** Skills are ranked by how many facts show them, then by ID. The first 24 are read, and each is shown as its group, at most 12 groups, each once.

- A skill or a piece of knowledge is shown as its nearest skill group, and a tool as its nearest tool category. A skill group or a tool category is shown as itself.
- Nearest means the fewest `broader` steps. A tie at one level goes to the lowest ID. A concept stops being followed once it has its group.
- A concept the taxonomy does not hold, one of another kind, and one with no group within 12 levels, are left off.
- Every skill is walked together, one level at a time: at each level one `fromAny` for the nodes not yet asked about and one `concepts` for the concepts not yet read. The walk reads at most 400 concepts. Where the next level would pass that, it stops, and whatever has no group yet is left off. The card then shows less, never something wrong.

**Occupation.** The occupation comes from the most recent confirmed job: current jobs first, then the latest end, then the latest start. Within a job the order is ESCO's occupation, then O\*NET's, then an ISCO group, then by ID. ESCO comes first because only it has an ISCO group above it, which the ladder needs.

**Band.** Overall experience comes from confirmed jobs, with overlaps counted once.

- A month is year × 12 + month − 1. A year alone reads earliest as January and latest as December.
- A job with no end is current and runs to the UTC month of now. No end counts past now.
- The band is unknown when any confirmed job has no known start. That includes a job with an unknown end, which keeps its start apart.
- The shortest reading of every job and the longest are each joined and counted. The band is given only when both fall in the same band; otherwise it is unknown.
- The bands are under 2 years, 2 to 5, 5 to 10 and 10 or more: edges at 24, 60 and 120 months. The top band is open, because years track age.

**The ladder.** Before anyone saw a card, it would be coarsened until its whole description is shared by enough cards. The harness (`scripts/reid/ladder.mjs`) states the rule; nothing in the app publishes.

| Rung | Occupation | Place | Band | Skills |
| --- | --- | --- | --- | --- |
| 0 | The occupation | Metro | Fine: the card's own four bands | 12 |
| 1 | The occupation | Region | Fine | 6 |
| 2 | ISCO unit group | Region | Wide: under 5 years, or 5 or more | 3 |
| 3 | ISCO minor group | Region | Wide | 1 |
| 4 | ISCO sub-major group | Country | None | 0 |

At every rung, a card that says remote says that instead of a place. "Fewer skills" keeps the most popular of the card's own skills, popularity being how many trust-signalled cards hold a group, with ties to the lower ID.

**Counting.** A card is placed at the finest rung where the cards not yet placed that share its exact description include at least k = 10 trust-signalled cards. Otherwise it is suppressed and stays at Notify me. Cards placed at a finer rung are not counted toward a coarser description: they can be told apart from it, so they are not in its anonymity set. Untrusted cards are placed with their group but never count toward it.

**Handles.** A card's handle is the first 16 hex characters of SHA-256(`secret|id|levelEpoch`). `levelEpoch` counts the times the card's assigned rung, suppressed included, has changed. A card that goes from rung 0 to 1 and back to 0 has three handles, and never gets its first one back. A handle made from the rung alone would have returned it, and linked the card across the change, which the system design forbids.

**Bands match.** The harness's fine band edges (`FINE_BANDS` in `scripts/reid/ladder.mjs`) are the card's (`experienceOf` in `src/pipeline/card.ts`). The harness imports no app code, so the two must change together.

## The re-identification harness

`scripts/reid/` holds a pure, seeded harness with no I/O, and `scripts/reid.test.mjs` runs it (`node --test scripts/reid.test.mjs`, also run by `npm run test:scripts` and CI).

**What is standard.** ISCO-08's four levels, as the standard publishes them: 10 major, 43 sub-major, 130 minor and 436 unit groups, 619 in all. The harness refuses a manifest whose `ISCOGroups_en.csv` does not hold 619 rows. From the 11 November build's manifest it takes 3,043 occupations, 640 skill groups and 134 tool categories.

**What is synthetic.** Everything else, and the code says so:

- which occupation sits under which unit group, and so on up, spread in ISCO-08's counts;
- one country of 40 regions and 300 metros of Zipf sizes, and 4,000 employers, each in one metro;
- each unit group's 25 skill groups;
- every seeker. Occupation is drawn by Zipf (s = 1). 15% are remote. Months of experience are exponential with a mean of 108, capped at 540. Each has 3 to 12 groups from their unit's 25, and 85% carry trust signals.
- Half have a public profile. Its occupation is exact 80% of the time, otherwise a sibling in the same unit. Its metro is exact 90% of the time. Its months are off by N(0, 12). It keeps each skill with p = 0.6 and adds 2 from the unit's profile.

**The attackers.**

- **Profile join.** For each published card, the profiles consistent with it at its rung: the occupation at the rung's level, the metro or region, and a band reachable within 12 months. It names the one profile with the most skills in common, when one stands alone at the top. It is also run against every card at rung 0, with no ladder, as the baseline.
- **Employer files.** The five largest employers each know their own staff's exact occupation and metro, their months to within 6, and 80% of each person's skills. Each singles out an employee when exactly one is consistent with a published card. A shown skill the employer does not know of counts against an employee only past half of what the card shows. Wrong singlings-out are reported.
- **Fake accounts.** For each of 200 targets drawn by the seed, separately, k − 1 fakes with the target's rung-0 description, then the cards published again. It succeeds when the target is placed at rung 0 and every other card sharing its description is a fake. `insider` knows the target's exact description, as a colleague or former employer would: the worst case. `profile` builds the fakes from the target's public profile: a lower bound. Each mode is run with fakes that carry trust signals and fakes that don't.

**Results.** Seed 20261111, 20,000 seekers, k = 10, as the test prints them. Every card was published: none at rung 0 or 1, 58 at rung 2, 2,419 at rung 3 and 17,523 at rung 4.

| Attacker | Targets | Guesses | Right | Wrong | Rate |
| --- | --- | --- | --- | --- | --- |
| Profile join, laddered | 20,000 | 0 | 0 | 0 | 0.00% |
| Profile join, no ladder | 20,000 | 9,649 | 5,847 | 3,802 | 29.23% |
| Employer files, laddered | 5,078 | 224 | 2 | 222 | 0.04% |
| Employer files, no ladder | 5,078 | 4,832 | 2,926 | 1,906 | 57.62% |
| Fake accounts, insider, untrusted | 200 | 0 | 0 | 0 | 0.00% |
| Fake accounts, insider, trusted | 200 | 179 | 179 | 0 | 89.50% |
| Fake accounts, profile, untrusted | 200 | 0 | 0 | 0 | 0.00% |
| Fake accounts, profile, trusted | 200 | 0 | 0 | 0 | 0.00% |

These rates describe a made-up population and say nothing about real cards. The profile-based fake-account rate is a lower bound; the insider rate is the worst case.

What the run does show about the rule itself: in a population this size, cards described this finely almost never share a description, so nearly every card falls to the ISCO sub-major group and the country, which tells a recruiter very little. The employer's few singlings-out were nearly all wrong, which is itself harm: a wrong guess points at a real employee. And trust signals are the whole defence against fake accounts: untrusted fakes change nothing, which the test asserts, while nine trusted fakes made by an insider expose almost every trust-signalled target.

## Proposed pass thresholds

For the owner to decide. None is met by anything yet: the synthetic rates above are not evidence for real cards.

1. **Profile join:** at most 0.1% of published cards re-identified, at 50% profile coverage.
2. **Employer files:** at most 1% of an employer's employees with a published card singled out, and at most 1% of its guesses wrong. In the synthetic run, 0.04% were singled out rightly, but 222 of 224 guesses were wrong.
3. **Fake accounts:** untrusted fakes change nothing, which the test asserts. The insider rate with trusted fakes must be judged against what a trust-signalled account costs, which is not defined. The ladder alone does not stop k − 1 trusted insider fakes.

## What Gate 3 still needs

- Tags measured on lines given with consent, and the owner's review of tags. Until then every real card is empty.
- Real card distributions, in place of the synthetic population.
- Block-aware publication: a card that blocks an employer published only beside enough others blocking it.
- Difference attacks across handle changes over time.
- The counter per jurisdiction and the shards that enforce the minimum.
- Defined trust signals and what each costs.
- Counsel.
- The owner's sharing rules: who may see a card, and when.

## Open decisions

1. **Seniority.** Map the work and people ladders to a seniority value, define another source, or leave it off the card?
2. **Self-declared skills.** Should skills-list facts ever appear, labelled "self-declared", behind an opt-in?
3. **Activities.** Should `does` tags count as skills?
4. **Parent level.** Is the nearest skill group the right level, or should it be a fixed ESCO depth?
5. **Bands.** Are the edges right? Should the top be capped at 10 years? Should project, volunteer and education roles count?
6. **Occupation choice.** The latest job's occupation, or the one with the most evidence?
7. **Ladder.** Are the rungs, their order, the skills kept per rung and k = 10 right? Should a handle also change when a card's description changes within a rung?
8. **Attacker thresholds.** Adopt the proposed thresholds above, or set others?
9. **Trust signals.** Which signals count, and what must a trusted account cost, given that the insider attack needs only k − 1 of them?
10. **Job settings and the card.** Should location, availability and job types ever reach the card, and under what per-use decision?
11. **Credits elsewhere.** Should the credits appear wherever taxonomy labels are shown, beyond the legal pages and the section's link?
12. **Staging.** Should `CARD_PREVIEW_ENABLED` be switched on in staging, where a taxonomy is bound?
