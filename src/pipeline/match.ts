import type { Models } from "../ai/models";
import { JudgeOut, judgePrompt, type JudgeItem } from "../ai/prompts";
import { checkClaim } from "../grounding/claims";
import { roleKey, wording, type RoleIdentity } from "../shared/record";

// Finding what an upload says again (step 6 of docs/taxonomy-pipelines-design.md, first part).
//
// Every upload proposes all of its roles and facts afresh, so a second resume brings a second copy
// of each job and each line. This finds the copies that are word for word the same. It uses no
// model and decides nothing by likeness: two roles match only when every field that names a role
// is the same, and two facts only when they are of one kind, in roles that match, with the same
// wording. Those are the two findings the record itself will confirm without the owner
// (src/vault/record.ts), and both sides use the same definitions, from src/shared/record.ts.
//
// Anything less than identical is never merged by a rule. Two different wordings can only be
// offered to the owner, and `offers` below is what works out which to offer.

/** The rules that made a match, stamped on it. Raise the number when what counts as identical changes. */
export const IDENTICAL_ROLE_METHOD = "identical-role/2";
export const IDENTICAL_WORDING_METHOD = "identical-wording/2";

export interface MatchRole extends RoleIdentity {
  id: string;
}

export interface MatchFact {
  id: string;
  roleId: string | null;
  kind: string;
  text: string;
}

/** `from` says again what `to` already said. `to` is always the earliest row that says it. */
export interface IdenticalMatch {
  kind: "role" | "fact";
  from: string;
  to: string;
}

/**
 * Every role and fact that repeats an earlier one word for word. Rows are given oldest first, and
 * each later copy is matched to the earliest, so any number of copies point at one row and no
 * row points at more than one.
 */
export function identicalMatches(roles: readonly MatchRole[], facts: readonly MatchFact[]): IdenticalMatch[] {
  const matches: IdenticalMatch[] = [];
  /** The earliest role with each identity, and for every role the role that stands for it. */
  const firstRole = new Map<string, string>();
  const stands = new Map<string, string>();
  for (const role of roles) {
    const key = roleKey(role);
    const first = key === null ? undefined : firstRole.get(key);
    if (first === undefined) {
      if (key !== null) firstRole.set(key, role.id);
      stands.set(role.id, role.id);
    } else {
      matches.push({ kind: "role", from: role.id, to: first });
      stands.set(role.id, first);
    }
  }
  const firstFact = new Map<string, string>();
  for (const fact of facts) {
    // An accomplishment read without a job has no role that was found to be the same one. A skill
    // or a credential is the same item wherever it is listed.
    if (fact.roleId === null && fact.kind === "accomplishment") continue;
    const words = wording(fact.text);
    if (!words) continue;
    const key = JSON.stringify([fact.roleId === null ? null : (stands.get(fact.roleId) ?? fact.roleId), fact.kind, words]);
    const first = firstFact.get(key);
    if (first === undefined) firstFact.set(key, fact.id);
    else matches.push({ kind: "fact", from: fact.id, to: first });
  }
  return matches;
}

// ---------------------------------------------------------------- offers

/** The check that made an offer, stamped on it. Raise the number when the questions or the pre-check change. */
export const ENTAILMENT_METHOD = "entailment/1";

/** Two facts of one kind in one role whose wording differs. `later` was read after `earlier`. */
export interface OfferPair {
  later: { id: string; text: string };
  earlier: { id: string; text: string };
}

/**
 * What to offer the owner about a pair. `same`: each says everything the other says, and the
 * earlier fact would stand for both. `fuller`: `from` says everything `to` says, and more.
 */
export interface Offer {
  relation: "same" | "fuller";
  from: string;
  to: string;
}

const JUDGE_ITEMS_PER_CALL = 20;

/** How near in meaning two lines must be before the judge is asked about them, and how many are asked. */
export const OFFER_MIN_COSINE = 0.6;
export const OFFERS_PER_FACT = 2;
export const MAX_OFFER_PAIRS = 60;

/**
 * Works out, for each pair, whether one fact says everything the other says. Each direction is
 * asked on its own: first the checks a resume line passes against its facts, which need no model
 * and settle any pair whose figures or names differ, then the judge, in the form it already
 * answers. A direction holds only if both say so. Nothing is composed and no wording changes:
 * the answer is which of the two existing facts, if either, could stand for the other.
 */
export async function offers(models: Models, pairs: readonly OfferPair[]): Promise<Offer[]> {
  // "x.e": does the later fact say everything the earlier one says? "x.l": the other way round.
  const items: JudgeItem[] = [];
  pairs.forEach((pair, index) => {
    if (checkClaim(pair.earlier.text, [{ text: pair.later.text }]).ok)
      items.push({ alias: `${index + 1}.e`, text: pair.earlier.text, facts: [{ text: pair.later.text, quote: null }] });
    if (checkClaim(pair.later.text, [{ text: pair.earlier.text }]).ok)
      items.push({ alias: `${index + 1}.l`, text: pair.later.text, facts: [{ text: pair.earlier.text, quote: null }] });
  });
  const holds = new Map<string, boolean>();
  for (let at = 0; at < items.length; at += JUDGE_ITEMS_PER_CALL) {
    const batch = items.slice(at, at + JUDGE_ITEMS_PER_CALL);
    const out = models.judge ? await models.judge(batch) : await models.complete("judge", judgePrompt(batch), JudgeOut);
    for (const verdict of out.verdicts) {
      const id = verdict.id.trim();
      // Two answers for one question are no answer, whatever either says.
      holds.set(id, !holds.has(id) && verdict.verdict === "supported");
    }
  }
  const asked = new Set(items.map((item) => item.alias));
  const found: Offer[] = [];
  pairs.forEach((pair, index) => {
    const laterSaysAll = asked.has(`${index + 1}.e`) && holds.get(`${index + 1}.e`) === true;
    const earlierSaysAll = asked.has(`${index + 1}.l`) && holds.get(`${index + 1}.l`) === true;
    if (laterSaysAll && earlierSaysAll) found.push({ relation: "same", from: pair.later.id, to: pair.earlier.id });
    else if (laterSaysAll) found.push({ relation: "fuller", from: pair.later.id, to: pair.earlier.id });
    else if (earlierSaysAll) found.push({ relation: "fuller", from: pair.earlier.id, to: pair.later.id });
  });
  return found;
}
