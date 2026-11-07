import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { extractFacts } from "../../src/pipeline/distill";
import { analyzeJob, composeBody, selectFacts, verifyDraft, writeDraft } from "../../src/pipeline/tailor";
import { checkLine } from "../../src/grounding/verdict";
import { quoteIsVerbatim } from "../../src/grounding/quote";
import type { ResumeBody, ResumeReport } from "../../src/shared/api";
import type { FactRecord, RoleRecord } from "../../src/shared/types";
import { topMatches, toUnit } from "../../src/vault/search";
import { CASES } from "./cases";
import { credentials, restModels, wranglerVars } from "./rest-models";
import { requireCitedDraft, requireExpectedExtraction } from "./nonvacuity";

// Runs each case through the real pipeline: extract, confirm everything, analyze, select, write,
// verify, compose. Fails on any fabrication; writes eval-report.json with quality metrics.

const creds = credentials();
const vars = wranglerVars(process.env.EVAL_ENV || "staging");
const report: Record<string, unknown>[] = [];

afterAll(() => {
  if (report.length) writeFileSync("eval-report.json", JSON.stringify({ models: pick(vars, /^MODEL_/), cases: report }, null, 2));
});

describe.skipIf(!creds)("no fabrication", () => {
  it.each(CASES)("$name", async (c) => {
    const models = restModels(creds!, vars);

    const { extraction, dropped } = await extractFacts(models, c.resume);
    // Each synthetic case contains roles and facts; empty extraction is not a
    // successful absence-of-fabrication evaluation.
    requireExpectedExtraction(extraction, { roles: [1], facts: [1] });
    for (const x of [...extraction.roles, ...extraction.facts]) expect(quoteIsVerbatim(c.resume, x.quote), x.quote).toBe(true);

    // The user confirms everything the extractor proposed.
    const roles: RoleRecord[] = extraction.roles.map((r) => ({ id: `role-${r.key}`, kind: r.kind, org: r.org, title: r.title, startDate: r.startDate, endDate: r.endDate }));
    const facts: FactRecord[] = extraction.facts.map((f, i) => ({
      id: `fact-${i + 1}`,
      roleId: f.roleKey ? `role-${f.roleKey}` : null,
      kind: f.kind,
      text: f.text,
      level: f.level,
      quote: f.quote,
    }));
    const vectors = new Map((await models.embed(facts.map((f) => f.text))).map((v, i) => [facts[i]!.id, toUnit(v)]));

    const analysis = await analyzeJob(models, c.job);
    const selection = await selectFacts(models, async (q, k) => topMatches(q, vectors, k), analysis, facts);
    const draft = await writeDraft(models, analysis, selection, facts, roles);
    const verified = await verifyDraft(models, draft, selection, facts);
    const body = composeBody(verified, roles, facts, selection);
    requireCitedDraft(body);

    const byId = new Map(facts.map((f) => [f.id, f]));
    const selected = new Set([...selection.factIds, ...selection.skillIds]);
    const violations: string[] = [];
    for (const line of linesOf(body)) {
      const check = checkLine(line, byId, selected);
      if (!check.ok) violations.push(`"${line.text}": ${check.problems.join("; ")}`);
      if (line.factIds.length === 0) violations.push(`"${line.text}" cites nothing`);
    }
    const printed = textOf(body);
    for (const pattern of c.forbidden) {
      const hit = printed.match(pattern);
      if (hit) violations.push(`forbidden ${pattern} matched "${hit[0]}"`);
    }
    for (const s of body.sections) {
      if (!c.resume.includes(s.org)) violations.push(`section org "${s.org}" is not in the resume`);
    }

    report.push({
      case: c.name,
      extraction: { roles: extraction.roles.length, facts: extraction.facts.length, dropped },
      requirements: analysis.requirements.length,
      selected: selection.factIds.length,
      report: verified.report satisfies ResumeReport,
      gapRecall: gapRecall(c.expectedGaps, verified.report.gaps),
      lines: linesOf(body).map((l) => ({ status: l.status, text: l.text })),
      violations,
    });
    expect(violations).toEqual([]);
  });
});

function linesOf(body: ResumeBody) {
  return [...(body.summary ? [{ ...body.summary, roleId: null }] : []), ...body.sections.flatMap((s) => s.lines.map((l) => ({ ...l, roleId: s.roleId })))];
}

function textOf(body: ResumeBody): string {
  return [
    body.summary?.text ?? "",
    ...body.sections.flatMap((s) => [s.org, s.title ?? "", ...s.lines.map((l) => l.text)]),
    ...body.skills,
  ].join("\n");
}

function gapRecall(expected: string[], gaps: string[]): number | null {
  if (expected.length === 0) return null;
  const joined = gaps.join(" ").toLowerCase();
  return expected.filter((g) => joined.includes(g.toLowerCase())).length / expected.length;
}

function pick(record: Record<string, string>, pattern: RegExp): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => pattern.test(k)));
}
