# Finding what an upload says again

Every upload proposes all of its roles and facts afresh. A second resume brings a second copy of each job and each line, and a third brings a third. This document describes how the copies are found.

It is step 6 of the [pipeline design](taxonomy-pipelines-design.md), in shadow. The code is `src/pipeline/match.ts`. How a merge is stored, and what it does and doesn't change, is in [record.md](record.md).

**Status: two things exist and are tested with stand-in models. A matcher finds roles and facts that are word for word the same (`MATCH_SHADOW_ENABLED`). A second step asks the judge whether two differently worded lines say the same thing, and keeps the answer as an offer (`OFFER_SHADOW_ENABLED`). Both run only where switched on, which is nowhere by default, and both are refused in production configuration. Where they run they only note what they find, in shadow. Nothing is merged, nothing is offered to anyone, and the list of facts still shows every copy. The judge has not been run against real models for this.**

## What counts as the same

Nothing here is decided by likeness, and no model is asked.

- **Two roles** match when every field that names a role is the same: kind, organisation, title, a known start, and the same end or none in both. A role with no title, no known start, or an end that isn't known matches nothing, however alike two such roles look.
- **Two facts** match when they are of the same kind, sit in roles that match, and have the same wording once presentation is removed. A bullet is presentation. A number or a sign a line starts with is not: "1. Staatsexamen" and "2. Staatsexamen" are two credentials. Outside any role, only skills and credentials match: an accomplishment read without a job has no role that was found to be the same one.

These are exactly the two findings the record will confirm without the owner ([record.md](record.md), "Merging without asking"), and both use one definition of each (`roleKey` and `wording` in `src/shared/record.ts`). A test puts every finding the matcher makes in a real vault to the record's own check, and all are accepted.

"Senior Engineer" and "Sr. Engineer", "2019" and "2019-03", or a line with one word changed are not the same here. They are left for the owner to be offered.

## Which copy stands

Rows are read oldest first, and each later copy points at the **earliest** row that says the same thing. Three uploads of one resume give two copies pointing at the first, never a chain. The earliest row is the one the owner is most likely to have already reviewed.

## Running in shadow

With `MATCH_SHADOW_ENABLED=true`, reading an upload gains one stage after its facts are embedded:

- It looks across the whole record, not only the new upload, so copies that were already there are found too.
- Each finding is stored as a shadow link from the copy to the earliest row, stamped `identical-role/2` or `identical-wording/2`. What was found before is not stored again.
- **Nothing is merged.** A shadow link stands for nothing: every fact still stands for itself with its own one quote, the lists show every row, and tailoring hides repeats as it already does.
- It makes no model call, so it costs nothing and adds almost no time.
- **It cannot fail an upload.** A failure leaves the upload exactly as it is read today. It gets one try of at most three minutes and is not run again.

A person's export includes these links, marked as in shadow.

## Two wordings of one thing

Lines that differ in wording are never merged by a rule. With `OFFER_SHADOW_ENABLED=true`, reading an upload also works out which to **offer** the owner.

**Which pairs are asked about.** For each line the upload proposed, other than skills: the lines of the same kind, in the same role, from another upload or typed by the owner, that are nearest to it in meaning. At most two for each line, none below a set nearness, and at most sixty pairs for an upload. A pair with the same words is left to the rule above, and a pair that was linked or offered before is not asked about again. Roles count as the same role only when they are alike in every field that names a role.

**What is asked.** First, of the pair, and without a model: are the two lines qualified by the same words? Each is read against the closed list that keeps a line from being divided ([splitting.md](splitting.md), starting rule 1): shared credit and hedges, denials, alternatives, attempts and intentions. If one line has such a word and the other does not, or the two have different ones, nothing is offered and no model is asked. "Pursuing the PMP certification" is not "Completed the PMP certification", "Never handled customer escalations" is not "Handled customer escalations", and "Helped lead the migration" is not "Led the migration". A listed word or phrase is read however it is joined or marked, so "(in-progress)" and "(in progress)" are the same words. The list is wide on purpose, so some pairs a person would offer are not. It is still a list: it settles the words it holds and no others.

Then each direction separately: does this line say everything that one says?

1. The checks a resume line passes against its facts, which need no model. A different figure, a different name, a denial or a plan of an action those checks know, or an outcome going the other way settles that direction as no, whatever a judge would say.
2. The judge, in the form it already answers. Anything but one plain "supported" is a no, and an answer counts only in the call that asked its question.

| Each says everything the other says | Only one does | Neither does |
| --- | --- | --- |
| Offered as the same fact. The earlier one would stand for both | The one that says more is offered as a fuller version of the other. Both stay | Nothing |

**What only the judge can stop.** Some pairs pass every check that needs no model, in both directions, so nothing but the judge keeps them from being offered as the same. These kinds are known:

- **A different thing done, or the same thing done to something else, with no figure or name to show it.** "Wrote the on-call runbooks" and "Reviewed the on-call runbooks" have no figure, name or hedge to tell them apart. Nor do "Trained the sales team on the new CRM" and "Trained the finance team on the new CRM".
- **A hedge, a denial or an unfinished state that one line has in words the list does not hold.** "Almost finished the data warehouse migration" against "Finished the data warehouse migration"; "Declined to renew the vendor contract" against "Renewed the vendor contract"; "Ph.D. candidate in Statistics" against "Ph.D. in Statistics"; "Didnt negotiate vendor contracts", written without its apostrophe, against "Negotiated vendor contracts". The list does not know every way of saying that something did not happen or is not finished, and the claim checks read a denial or a plan only beside the verbs they know.
- **The same qualifying words about different things.** "Handled escalations but did not answer tickets" and "Did not handle escalations but answered tickets" each deny what the other says in the same words.

The labelled pairs mark which wrong offers are stopped without a model and which are not, and hold pairs of each of these kinds (`test/fixtures/match-pairs.ts`). The eval puts each to the real judge (`test/evals/match.eval.ts`). It has not been run.

An offer is only ever an offer. Nothing here confirms one, and in shadow nobody is shown one.

**An answer is about particular words.** The judge is asked while the upload is still being read, and either line can be reworded in the meantime. Each answer goes back to the vault with the two lines as the judge was asked about them, and an offer is kept only if both facts still say exactly that. Rewording a fact afterwards removes its offers, as it removes every judgement about its words ([record.md](record.md), "When words change").

Like the matcher, this step cannot fail an upload and gets one try of at most three minutes. If it runs out of time it is not run again, so the judge is never asked the same questions twice, and nothing is kept.

## What is not built

- **Offering roles that are nearly the same**, such as the same job with a different title, which is also what a promotion looks like.
- **Merges that show.** The record already confirms identical copies without the owner when it is asked to. What is missing is the review screens (step 7): a merged fact has to be shown as one fact with each of its quotes, and the owner has to be able to separate it, before any merge takes effect.
- **The eval against the real judge**, which needs model credentials and has not been run. It asks the judge the way the Worker does for the configuration it reads: in staging that is one typed decision for each question, held to the Worker's threshold.
- **Measurement.** How often two facts offered as the same are not has to be measured on real records before any offer is shown, and before anything but identical wording merges without asking.
