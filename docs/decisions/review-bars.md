# Decision: the bars before parts, tags and offers are shown for review

**Waiting for: the owner (the bars, the labelled sets, the budget) and counsel (the consent wording). Written on 11 November 2026 against `main` at `3d7c9fe`.**

## The question

Pipeline step 7 shows the owner the parts of a line, the tags on a fact and the offers to merge two facts, for them to confirm or reject. What must be measured, and how well must each stage do, before anything is shown? How many labelled examples does that take, given with what consent, and who pays for the model calls?

## Why it blocks what

- **The design says measure first, and sets only one bar.** "Splitting: … The target is zero on the labelled set." Tagging needs "precision of proposed tags on labelled facts, separately for word-for-word and vector candidates", and merging "how often two facts offered as the same are not". Both need numbers. All three "need real resumes with consent" ([taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md), "What must be measured before anything is shown", lines 144 to 150).
- **Step 7 waits on steps 4 to 6 being measured** ([taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md), "Order of work"). Each of those docs ends "Nothing is shown to anyone until that is measured" ([splitting.md](../splitting.md), [tagging.md](../tagging.md), [merging.md](../merging.md)).
- **Confirmed tags wait on step 7,** and the private card, years per skill and matching by concept all read confirmed tags only.
- **No eval of these stages has been run.** `test/evals/split.eval.ts`, `test/evals/tag.eval.ts` and `test/evals/match.eval.ts` exist and need model credentials. The labelled lines in `test/fixtures/` are made up and "cannot set a threshold" ([tagging.md](../tagging.md), "What has and has not been measured").
- **The eval budget is already short.** With staging's typed-decision judge the first pilot needs at least 66 weighted attempts, and 50 are authorised, so its preflight refuses to start ([roadmap.md](../roadmap.md), line 10; [seeker-release-status.md](../seeker-release-status.md); `PILOT_CALL_BUDGET_TOO_SMALL` in `scripts/first-staging-evals.mjs`).

## The bars proposed

A rate bar is met only when the whole of an exact two-sided 95% interval (Clopper-Pearson) around the measured rate is on the right side of it, not just the rate itself. That stops a small, lucky sample from passing. A zero bar is met only by zero failures observed on at least the named set; the interval rule does not apply to it, since an interval around zero always reaches above zero. Every number is an **Owner** proposal.

| Stage | Measure | Bar | Labelled set | Why this bar |
| --- | --- | --- | --- | --- |
| Splitting (step 4) | Divisions that change a line's meaning, among divisions that pass every check | **Zero**, already set. On at least 300 passing divisions, zero means the true rate is under about 1% with 95% confidence | Lines from at least 30 people, enough to give 300 passing divisions | A part that says something the line doesn't is a fabrication the owner may not notice |
| Tagging by a label found word for word, decided by the rule (`mention-label/1`) | Precision: proposed tags that are right | Lower 95% bound **at least 0.95** (about 390 right in 400) | At least 400 proposed tags, or every such tag the set yields if fewer, read as a pass only at the same bound | No model decides these; a wrong one is a fault in the rule, and should be rare |
| Tagging by a label found word for word, decided by the judge (`mention-judge/1`) | Precision | Lower 95% bound **at least 0.95** | At least 400 proposed tags | The owner confirms each tag, but a wrong one shown often teaches them to confirm without reading |
| Tagging from vector candidates (being built this round, shadow only) | Precision | Lower 95% bound **at least 0.85** (about 355 right in 400) | At least 400 proposed tags | Concepts the words do not name are harder; shown labelled as suggestions |
| All tagging | Tags from lines that only mention, deny or intend the concept ([tagging.md](../tagging.md), "What only the judge can stop") | **Zero** in the labelled cases of those kinds | At least 50 such lines | Each is a claim the person did not make |
| Merging (step 6) | False offers: pairs offered as the same fact that are not | Upper 95% bound **at most 5%** (no more than 7 false in 300) | At least 300 offers | An offer is only an offer, but accepting a wrong one hides a fact behind another |
| Merging | Pairs no deterministic check stops ([merging.md](../merging.md), "What only the judge can stop") | **Zero** offered in the labelled cases of those kinds | At least 50 such pairs | Each would merge two different claims |

Each stage is measured with the models and the taxonomy build it will run with. A change to a prompt, a model, a method or its version stamp (`split/3`, `mention-judge/1`) measures it again.

Refusals are tracked but are not bars. How often a good division is refused, or a right tag not proposed, says what the owner misses, not what they are wrongly shown ([taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md), line 146).

## The labelled sets and consent

**Where the lines come from.** From people who give their lines for this purpose, never from reading vaults. The measurement adds no way for staff to read one.

**Proposal.**

1. A separate request, by email from the team as beta invitations are ([beta/invite-email.md](../beta/invite-email.md)), asking a person to give one resume for measurement.
2. The person sends the file they choose, after reading what it is for. They can remove names and employers first.
3. Two people label each line on their own, and a third settles disagreements, as the extraction evals' full assessment requires independent labelling ([seeker-operations.md](../seeker-operations.md), line 245).
4. The files and labels stay outside Git, as real consenting users' fixtures already must ([seeker-operations.md](../seeker-operations.md), line 151). They are deleted when the measurement is done, or when the person asks.
5. Only the counts and the rates go into the repository.

**The consent says,** in plain words: what is measured; that named staff read and label the lines; that lines go to the model providers named in the privacy notice; where the files are kept and when they are deleted; that saying no changes nothing in the person's account; and how to withdraw. **Counsel** reviews the wording and its lawful basis.

**Size.** About 30 to 40 resumes are expected to give the sets above: a resume has tens of lines, most lines carry one or more labels a tag can come from, and offers come only where a person uploaded more than one resume. This is an estimate to check against the first ten resumes, not a measurement. Merging needs people who give two or more resumes each.

## The eval budget

A typed-decision request reserves six weighted attempts (`scripts/first-staging-evals.mjs`, the comment on the call budget; [seeker-operations.md](../seeker-operations.md), line 117). From that, and from each stage's own caps, the measurement needs roughly:

| Stage | Requests for one item | Weighted attempts for one item | Items | Weighted attempts |
| --- | --- | --- | --- | --- |
| Splitting | One proposal, then about three judge questions | About 24 | About 600 lines asked, to reach 300 passing divisions | About 14,400 |
| Tagging | Up to six candidates, one typed decision each ([tagging.md](../tagging.md), "The caps") | Up to 36 | About 400 facts | Up to 14,400 |
| Merging | Two directions | 12 | About 1,000 pairs asked, to reach 300 offers | About 12,000 |

**About 40,000 weighted attempts in all,** against 50 authorised today. Every figure in this table is arithmetic from the code's reservation rule and an assumed ratio (lines that pass, pairs that are offered), not a measurement. The money it costs depends on the models' prices, which the owner sets in the evaluation's price configuration.

**The budget question for the owner:** authorise a measurement budget separate from the pilot's 50, in weighted attempts and in money, and say whether it is spent stage by stage (splitting first, as its bar is already set) or all at once.

## Options

1. **Measure as above, then show each stage that passes its bars.** Stages pass and are shown one at a time.
2. **Show nothing until all three pass.**
3. **Lower bars for a small group of owners who agree to review knowingly,** before measurement.

## Recommendation

**Option 1, starting with splitting.** Its bar is set, its eval exists, and parts are only views of the line. Option 3 shows unmeasured judgements to real people, which the design rules out.

## What changes once decided

**Code**

- The three evals report the measure, the count and the interval for each method, and fail below the bar, as the release check does for extraction (`scripts/check-release.mjs`).
- Each stage's switch stays refused in production configuration until its bar is met and recorded (`scripts/validate-config.mjs`, as for `SPLIT_SHADOW_ENABLED` and `TAG_SHADOW_ENABLED`).

**Docs**

- [taxonomy-pipelines-design.md](../taxonomy-pipelines-design.md): the bars under "What must be measured before anything is shown".
- [splitting.md](../splitting.md), [tagging.md](../tagging.md), [merging.md](../merging.md): the measured results, once there are any.
- [seeker-release-status.md](../seeker-release-status.md): each stage's row.
- [roadmap.md](../roadmap.md): the eval budget's row.

## Who decides

- **Owner:** the bars; the size of each set; the measurement budget and its order.
- **Counsel:** the consent wording and its lawful basis, and how long the files may be kept.
