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
   * needs no model, so it is stopped whatever a judge says. "judge" means only the judge can.
   */
  stoppedBy?: "check" | "judge";
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
  { later: "Handled 2 million events a day", earlier: "Handled 2 events a day", expect: "different", stoppedBy: "check", why: "one figure is scaled" },
  { later: "Managed the budget", earlier: "Did not manage the budget", expect: "different", stoppedBy: "check", why: "one denies what the other says" },
  { later: "Led the migration to Kubernetes", earlier: "Helped lead the migration to Kubernetes", expect: "different", stoppedBy: "check", why: "one claims more of the credit" },
  { later: "Wrote the on-call runbooks", earlier: "Reviewed the on-call runbooks", expect: "different", stoppedBy: "judge", why: "a different thing done to the same object" },
  { later: "Increased checkout conversion", earlier: "Reduced checkout conversion", expect: "different", stoppedBy: "check", why: "the outcome went the other way" },
  { later: "Trained the sales team on the new CRM", earlier: "Trained the support team on the new CRM", expect: "different", stoppedBy: "judge", why: "a different team was trained" },
];
