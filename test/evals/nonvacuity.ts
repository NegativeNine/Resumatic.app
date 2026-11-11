import type { ResumeBody } from "../../src/shared/api";

/** An absence-of-fabrication result is not useful when nothing was extracted. */
export function requireExpectedExtraction(
  extraction: { roles: readonly unknown[]; facts: readonly unknown[] },
  expected: { roles: readonly unknown[]; facts: readonly unknown[] },
): void {
  if (expected.roles.length > 0 && extraction.roles.length === 0)
    throw new Error("eval_no_roles");
  if (expected.facts.length > 0 && extraction.facts.length === 0)
    throw new Error("eval_no_facts");
}

/** Ordinary evaluations score empty predictions as misses; the one-shot pilot
 * additionally requires evidence that it exercised extraction. */
export function requirePilotExtraction(
  extraction: { roles: readonly unknown[]; facts: readonly unknown[] },
  expected: { roles: readonly unknown[]; facts: readonly unknown[] },
  pilot: boolean,
): void {
  if (pilot) requireExpectedExtraction(extraction, expected);
}

/** A draft must contain at least one substantive cited line to exercise verification. */
export function requireCitedDraft(body: ResumeBody): void {
  const lines = [
    ...(body.summary ? [body.summary] : []),
    ...body.sections.flatMap((section) => section.lines),
  ];
  if (!lines.some((line) => line.text.trim().length > 0 && line.factIds.length > 0))
    throw new Error("eval_no_cited_lines");
}

/**
 * A tagging run that tagged nothing wrong has shown nothing when there was nothing to tag. It is
 * refused when the labelled lines gave no candidate at all, and when a method the labels expect
 * tags from proposed none: a judge that declines everything is never wrong, and measures nothing.
 */
export function requireTagging(outcomes: readonly { found: boolean; expected: string | null; tagged: string | null }[]): void {
  if (!outcomes.some((outcome) => outcome.found)) throw new Error("eval_no_tag_candidates");
  const expected = new Set(outcomes.flatMap((outcome) => (outcome.expected === null ? [] : [outcome.expected])));
  for (const method of expected) if (!outcomes.some((outcome) => outcome.tagged === method)) throw new Error("eval_no_tags");
}
