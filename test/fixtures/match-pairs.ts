// Labelled pairs of lines for offering two wordings as the same fact. Every line here is made up.
// They exercise the checks and say what each is for; they cannot set a threshold. How often two
// facts offered as the same are not has to be measured on real records given with consent.

export interface PairExample {
  later: string;
  earlier: string;
  /**
   * What a careful reader would say: the two say the same thing; the later or the earlier says
   * everything the other does and more; or they are different claims.
   */
  expect: "same" | "later-fuller" | "earlier-fuller" | "different";
  /**
   * For a pair that must never be offered as the same: what stops it. "check" is a check that
   * needs no model, so nothing is offered about the pair whatever a judge says. "judge" means
   * only the judge can.
   */
  stoppedBy?: "check" | "judge";
  /**
   * For a pair only the judge can stop because one line is hedged, denied or left unfinished in
   * words the closed list of qualifying words does not hold: those words. The list reads such a
   * pair as two lines qualified alike, so it settles nothing about it.
   */
  unlisted?: string;
  why: string;
}

export const MATCH_PAIRS: PairExample[] = [
  { later: "Cut deploy time from 40 minutes to 6 minutes", earlier: "Reduced deploy time from 40 minutes to 6 minutes", expect: "same", why: "one verb for another, every figure the same" },
  { later: "Built the billing API used by 3 product teams", earlier: "Built the billing API that 3 product teams use", expect: "same", why: "the same claim turned round" },
  { later: "Mentored 2 junior engineers every quarter", earlier: "Mentored 2 junior engineers", expect: "later-fuller", why: "the later line adds how often" },
  { later: "Ran the on-call rota", earlier: "Ran the on-call rota for a team of 12", expect: "earlier-fuller", why: "the earlier line adds for whom" },
  { later: "Led a team of 8 engineers", earlier: "Led a team of 5 engineers", expect: "different", stoppedBy: "check", why: "a different figure" },
  { later: "Built the billing API in Python", earlier: "Built the billing API in Go", expect: "different", stoppedBy: "check", why: "a different tool" },
  { later: "Cut costs by 30%", earlier: "Cut costs by up to 30%", expect: "different", stoppedBy: "check", why: "one figure is hedged" },
  { later: "Cut cloud costs by 30%", earlier: "Cut cloud costs by upto 30%", expect: "different", stoppedBy: "check", why: "one figure is hedged, with the hedge written as one word" },
  { later: "Handled 2 million events a day", earlier: "Handled 2 events a day", expect: "different", stoppedBy: "check", why: "one figure is scaled" },
  { later: "Managed the budget", earlier: "Did not manage the budget", expect: "different", stoppedBy: "check", why: "one denies what the other says" },
  { later: "Led the migration to Kubernetes", earlier: "Helped lead the migration to Kubernetes", expect: "different", stoppedBy: "check", why: "one claims more of the credit" },
  // A denial, an attempt or something unfinished that only one line has. No list of verbs knows
  // "handle", "complete" or "negotiate", so nothing but the closed list of qualifying words
  // settles these without a model.
  { later: "Handled customer escalations", earlier: "Never handled customer escalations", expect: "different", stoppedBy: "check", why: "one denies what the other says, with a verb no list knows" },
  { later: "Negotiated vendor contracts", earlier: "Didn\u00B4t negotiate vendor contracts", expect: "different", stoppedBy: "check", why: "one denies what the other says, with an accent for its apostrophe" },
  { later: "Migrated the billing system", earlier: "Tried to migrate the billing system", expect: "different", stoppedBy: "check", why: "one was only attempted" },
  { later: "Built a new billing system", earlier: "Planned to build a new billing system", expect: "different", stoppedBy: "check", why: "one was only planned" },
  { later: "Completed the PMP certification", earlier: "Pursuing the PMP certification", expect: "different", stoppedBy: "check", why: "one is still under way" },
  { later: "AWS Solutions Architect certification", earlier: "AWS Solutions Architect certification (in progress)", expect: "different", stoppedBy: "check", why: "one is not finished" },
  { later: "Google Professional Cloud Architect certification", earlier: "Google Professional Cloud Architect certification (in-progress)", expect: "different", stoppedBy: "check", why: "one is not finished, written with a hyphen" },
  { later: "Certified ScrumMaster", earlier: "Certified ScrumMaster (ongoing)", expect: "different", stoppedBy: "check", why: "one is still under way, in a word of its own" },
  { later: "B.S. Computer Science, May 2027", earlier: "B.S. Computer Science, anticipated May 2027", expect: "different", stoppedBy: "check", why: "one is only expected" },
  { later: "Wrote the on-call runbooks", earlier: "Reviewed the on-call runbooks", expect: "different", stoppedBy: "judge", why: "a different thing done to the same object" },
  { later: "Increased checkout conversion", earlier: "Reduced checkout conversion", expect: "different", stoppedBy: "check", why: "the outcome went the other way" },
  { later: "Trained the sales team on the new CRM", earlier: "Trained the finance team on the new CRM", expect: "different", stoppedBy: "judge", why: "a different team was trained" },
  { later: "Handled escalations but did not answer tickets", earlier: "Did not handle escalations but answered tickets", expect: "different", stoppedBy: "judge", why: "each denies what the other says, in the same words" },
  // A hedge, a denial or something unfinished that only one line has, in words the closed list
  // does not hold. The list is still a list: nothing but the judge stands between each of these
  // and an offer, so each is here for the eval to put to it.
  { later: "Finished the data warehouse migration", earlier: "Almost finished the data warehouse migration", expect: "different", stoppedBy: "judge", unlisted: "almost", why: "one stops short of what the other says, in a word the list does not have" },
  { later: "Renewed the vendor contract", earlier: "Declined to renew the vendor contract", expect: "different", stoppedBy: "judge", unlisted: "declined to", why: "one refuses what the other says was done, in words the list does not have" },
  { later: "Ph.D. in Statistics", earlier: "Ph.D. candidate in Statistics", expect: "different", stoppedBy: "judge", unlisted: "candidate", why: "one degree is not finished, in a word the list does not have" },
  { later: "Negotiated vendor contracts", earlier: "Didnt negotiate vendor contracts", expect: "different", stoppedBy: "judge", unlisted: "didnt", why: "one denies what the other says, in a contraction written without its apostrophe" },
];
