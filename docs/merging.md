# Finding what an upload says again

Every upload proposes all of its roles and facts afresh. A second resume brings a second copy of each job and each line, and a third brings a third. This document describes how the copies are found.

It is step 6 of the [pipeline design](taxonomy-pipelines-design.md), first part. The code is `src/pipeline/match.ts`. How a merge is stored, and what it does and doesn't change, is in [record.md](record.md).

**Status: the matcher for identical roles and facts exists and is tested. It runs only where `MATCH_SHADOW_ENABLED` is `"true"`, which is nowhere by default and is refused in production configuration. Where it runs, it only notes what it finds, in shadow. Nothing is merged, and the list of facts still shows every copy. Offering two different wordings as the same fact is not built.**

## What counts as the same

Nothing here is decided by likeness, and no model is asked.

- **Two roles** match when every field that names a role is the same: kind, organisation, title, a known start, and the same end or none in both. A role with no title, no known start, or an end that isn't known matches nothing, however alike two such roles look.
- **Two facts** match when they are of the same kind, sit in roles that match, and have the same wording once presentation is removed. Outside any role, only skills and credentials match: an accomplishment read without a job has no role that was found to be the same one.

These are exactly the two findings the record will confirm without the owner ([record.md](record.md), "Merging without asking"), and both use one definition of each (`roleKey` and `wording` in `src/shared/record.ts`). A test puts every finding the matcher makes in a real vault to the record's own check, and all are accepted.

"Senior Engineer" and "Sr. Engineer", "2019" and "2019-03", or a line with one word changed are not the same here. They are left for the owner to be offered.

## Which copy stands

Rows are read oldest first, and each later copy points at the **earliest** row that says the same thing. Three uploads of one resume give two copies pointing at the first, never a chain. The earliest row is the one the owner is most likely to have already reviewed.

## Running in shadow

With `MATCH_SHADOW_ENABLED=true`, reading an upload gains one stage after its facts are embedded:

- It looks across the whole record, not only the new upload, so copies that were already there are found too.
- Each finding is stored as a shadow link from the copy to the earliest row, stamped `identical-role/1` or `identical-wording/1`. What was found before is not stored again.
- **Nothing is merged.** A shadow link stands for nothing: every fact still stands for itself with its own one quote, the lists show every row, and tailoring hides repeats as it already does.
- It makes no model call, so it costs nothing and adds almost no time.
- **It cannot fail an upload.** A failure leaves the upload exactly as it is read today.

A person's export includes these links, marked as in shadow.

## What is not built

- **Offering different wordings as the same fact, or one as a fuller version of another.** That needs the judge, asked both ways about a small number of likely pairs. Nothing proposes these yet.
- **Offering roles that are nearly the same**, such as the same job with a different title, which is also what a promotion looks like.
- **Merges that show.** The record already confirms identical copies without the owner when it is asked to. What is missing is the review screens (step 7): a merged fact has to be shown as one fact with each of its quotes, and the owner has to be able to separate it, before any merge takes effect.
- **Measurement.** How often two facts offered as the same are not has to be measured before anything but identical wording merges without asking.
