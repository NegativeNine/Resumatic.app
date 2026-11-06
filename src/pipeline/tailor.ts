import type { Models } from "../ai/models";
import {
  AnalyzeOut,
  JudgeOut,
  RepairOut,
  WriteOut,
  analyzePrompt,
  judgePrompt,
  repairPrompt,
  writePrompt,
  type JudgeItem,
} from "../ai/prompts";
import {
  authoritativeFact,
  checkLine,
  fallbackFact,
} from "../grounding/verdict";
import type { ResumeBody, ResumeLine, ResumeSection } from "../shared/api";
import type {
  Analysis,
  Candidate,
  Draft,
  DraftLine,
  FactRecord,
  RoleRecord,
  Selection,
  VerifiedDraft,
} from "../shared/types";

/** Tunables for selection and the one-page budget. */
export const TAILOR = {
  perRequirement: 8,
  maxFacts: 18,
  maxPerRole: 6,
  maxSkills: 14,
  /** bge-m3 cosine below which a requirement counts as uncovered. */
  gapCosine: 0.45,
};

export async function analyzeJob(
  models: Models,
  jdText: string,
): Promise<Analysis> {
  const out = await models.complete(
    "analyze",
    analyzePrompt(jdText),
    AnalyzeOut,
  );
  return {
    company: out.company?.trim() || null,
    title: out.title?.trim() || null,
    requirements: [
      ...new Set(out.requirements.map((r) => r.trim()).filter(Boolean)),
    ].slice(0, 20),
  };
}

type Search = (queries: number[][], k: number) => Promise<Candidate[]>;

/**
 * Picks the confirmed facts that best answer the job: nearest facts per requirement by
 * embedding, reordered by the reranker, capped per role and overall. Skills are kept apart
 * and printed verbatim. Requirements no fact comes close to are recorded as gaps.
 */
export async function selectFacts(
  models: Models,
  search: Search,
  analysis: Analysis,
  facts: FactRecord[],
): Promise<Selection> {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const queries = await models.embed(analysis.requirements);
  const candidates = await search(queries, TAILOR.perRequirement);

  const best = new Map<string, number>();
  const gaps: string[] = [];
  for (const [index, requirement] of analysis.requirements.entries()) {
    const near = candidates.filter(
      (c) => c.query === index && byId.has(c.factId),
    );
    if (
      near.length === 0 ||
      Math.max(...near.map((c) => c.score)) < TAILOR.gapCosine
    ) {
      gaps.push(requirement);
      continue;
    }
    const scores = await models.rerank(
      requirement,
      near.map((c) => byId.get(c.factId)!.text),
    );
    near.forEach((c, i) => {
      const score = (scores[i] ?? 0) + c.score;
      if (score > (best.get(c.factId) ?? -Infinity)) best.set(c.factId, score);
    });
  }

  const ranked = [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id)!);
  const perRole = new Map<string, number>();
  const factIds: string[] = [];
  const skillIds: string[] = [];
  for (const fact of ranked) {
    if (fact.kind === "skill") {
      if (skillIds.length < TAILOR.maxSkills) skillIds.push(fact.id);
      continue;
    }
    if (factIds.length >= TAILOR.maxFacts) continue;
    const key = fact.roleId ?? "none";
    if ((perRole.get(key) ?? 0) >= TAILOR.maxPerRole) continue;
    perRole.set(key, (perRole.get(key) ?? 0) + 1);
    factIds.push(fact.id);
  }
  return { factIds, skillIds, gaps };
}

/**
 * The closed-world writer. It sees only the selected facts, under short aliases, and must cite
 * them; lines that cite unknown facts or roles are dropped here, before verification.
 */
export async function writeDraft(
  models: Models,
  analysis: Analysis,
  selection: Selection,
  facts: FactRecord[],
  roles: RoleRecord[],
): Promise<Draft> {
  const selected = selection.factIds
    .map((id) => facts.find((f) => f.id === id))
    .filter((f): f is FactRecord => !!f);
  const usedRoles = roles.filter((r) =>
    selected.some((f) => f.roleId === r.id),
  );
  const roleAlias = new Map(usedRoles.map((r, i) => [r.id, `R${i + 1}`]));
  const factAlias = new Map(selected.map((f, i) => [`F${i + 1}`, f]));
  const out = await models.complete(
    "write",
    writePrompt(
      analysis.requirements,
      usedRoles.map((r) => ({
        alias: roleAlias.get(r.id)!,
        org: r.org,
        title: r.title,
      })),
      [...factAlias.entries()].map(([alias, f]) => ({
        alias,
        roleAlias: f.roleId ? (roleAlias.get(f.roleId) ?? null) : null,
        text: f.text,
      })),
    ),
    WriteOut,
  );
  const roleByAlias = new Map(
    [...roleAlias.entries()].map(([id, alias]) => [alias, id]),
  );
  const resolve = (ids: string[]) =>
    ids
      .map((a) => factAlias.get(a.replace(/[\[\]\s]/g, ""))?.id)
      .filter((id): id is string => !!id);

  const lines: DraftLine[] = [];
  if (out.summary) {
    const factIds = resolve(out.summary.factIds);
    if (factIds.length)
      lines.push({
        id: crypto.randomUUID(),
        roleId: null,
        text: out.summary.text.trim(),
        factIds,
      });
  }
  for (const group of out.roles) {
    const roleId = roleByAlias.get(group.roleId.trim());
    if (!roleId) continue;
    for (const line of group.lines) {
      const factIds = resolve(line.factIds);
      if (factIds.length)
        lines.push({
          id: crypto.randomUUID(),
          roleId,
          text: line.text.trim(),
          factIds,
        });
    }
  }
  return { lines };
}

/**
 * Verification fails closed. Each line passes the deterministic checks and then the judge, or it
 * is repaired once and checked again, or it is replaced by the first fact it cites, or dropped.
 */
export async function verifyDraft(
  models: Models,
  draft: Draft,
  selection: Selection,
  facts: FactRecord[],
): Promise<VerifiedDraft> {
  const byId = new Map(facts.map((f) => [f.id, authoritativeFact(f)]));
  const selected = new Set([...selection.factIds, ...selection.skillIds]);
  const kept: DraftLine[] = [];
  const failed: { line: DraftLine; reason: string }[] = [];

  // Round 1: deterministic checks, then the judge on what survives.
  const passing = draft.lines.filter((line) => {
    const result = checkLine(line, byId, selected);
    if (!result.ok) failed.push({ line, reason: result.problems.join("; ") });
    return result.ok;
  });
  const verdicts = await judge(models, passing, byId);
  for (const line of passing) {
    const v = verdicts.get(line.id);
    if (v?.ok) kept.push({ ...line, status: "kept" });
    else
      failed.push({ line, reason: v?.reason ?? "the judge gave no verdict" });
  }

  // Round 2: one repair per failed line, then the same checks and the judge again.
  const repaired: DraftLine[] = [];
  const stillFailing: DraftLine[] = [];
  for (const { line, reason } of failed) {
    const cited = line.factIds
      .map((id) => byId.get(id))
      .filter((f): f is FactRecord => !!f);
    let text: string | null = null;
    if (cited.length && cited.every((f) => selected.has(f.id))) {
      try {
        text = (
          await models.complete(
            "repair",
            repairPrompt(line.text, reason, cited),
            RepairOut,
          )
        ).text.trim();
      } catch {
        text = null;
      }
    }
    const candidate = text ? { ...line, text } : null;
    if (candidate && checkLine(candidate, byId, selected).ok)
      repaired.push(candidate);
    else stillFailing.push(line);
  }
  const verdicts2 = await judge(models, repaired, byId);
  const repairedOk: DraftLine[] = [];
  for (const line of repaired) {
    if (verdicts2.get(line.id)?.ok)
      repairedOk.push({ ...line, status: "repaired" });
    else stillFailing.push(line);
  }

  // Fallback: the first cited, selected fact of the line's role, verbatim; otherwise drop.
  const replaced: DraftLine[] = [];
  let dropped = 0;
  for (const line of stillFailing) {
    const fact = fallbackFact(line, byId, selected);
    if (fact)
      replaced.push({
        ...line,
        text: fact.text,
        factIds: [fact.id],
        status: "replaced",
      });
    else dropped += 1;
  }

  // Keep draft order, and never print the same sentence twice.
  const finalById = new Map(
    [...kept, ...repairedOk, ...replaced].map((l) => [l.id, l]),
  );
  const seen = new Set<string>();
  const lines: DraftLine[] = [];
  for (const original of draft.lines) {
    const line = finalById.get(original.id);
    if (!line) continue;
    const key = line.text.toLowerCase();
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    lines.push(line);
  }
  const count = (status: string) =>
    lines.filter((l) => l.status === status).length;
  return {
    lines,
    report: {
      kept: count("kept"),
      repaired: count("repaired"),
      replaced: count("replaced"),
      dropped,
      gaps: selection.gaps,
    },
  };
}

async function judge(
  models: Models,
  lines: DraftLine[],
  byId: Map<string, FactRecord>,
): Promise<Map<string, { ok: boolean; reason: string }>> {
  const result = new Map<string, { ok: boolean; reason: string }>();
  if (lines.length === 0) return result;
  const aliases = new Map(lines.map((l, i) => [`L${i + 1}`, l]));
  const items: JudgeItem[] = [...aliases.entries()].map(([alias, l]) => ({
    alias,
    text: l.text,
    facts: l.factIds
      .map((id) => byId.get(id))
      .filter((f): f is FactRecord => !!f)
      .map((f) => ({ text: f.text, quote: f.quote })),
  }));
  const out = await models.complete("judge", judgePrompt(items), JudgeOut);
  for (const v of out.verdicts) {
    const line = aliases.get(v.id.trim());
    if (line && result.has(line.id)) {
      // Conflicting or repeated answers are ambiguous even if the last says
      // supported. Neither ordering nor another duplicate can make them safe.
      result.set(line.id, { ok: false, reason: "the judge gave duplicate verdicts" });
    } else if (line)
      result.set(line.id, {
        ok: v.verdict === "supported",
        reason: v.reason || v.verdict,
      });
  }
  return result;
}

/** Builds the resume from verified lines. Headers and skills come from the record, never from a model. */
export function composeBody(
  verified: VerifiedDraft,
  roles: RoleRecord[],
  facts: FactRecord[],
  selection: Selection,
): ResumeBody {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const toLine = (l: DraftLine): ResumeLine => ({
    id: l.id,
    text: l.text,
    factIds: l.factIds,
    status: l.status ?? "kept",
  });
  const summary = verified.lines.find((l) => l.roleId === null);
  const sections: ResumeSection[] = [];
  for (const role of [...roles].sort(byRecency)) {
    const lines = verified.lines
      .filter((l) => l.roleId === role.id)
      .map(toLine);
    if (lines.length === 0 && role.kind !== "education") continue;
    sections.push({
      roleId: role.id,
      kind: role.kind,
      org: role.org,
      title: role.title,
      startDate: role.startDate,
      endDate: role.endDate,
      ...(role.unknownEndStartDate ? { unknownEndStartDate: role.unknownEndStartDate } : {}),
      lines,
    });
  }
  const skills = selection.skillIds
    .map((id) => byId.get(id)?.text)
    .filter((t): t is string => !!t);
  return { summary: summary ? toLine(summary) : null, sections, skills };
}

function byRecency(a: RoleRecord, b: RoleRecord): number {
  const end = (r: RoleRecord) => r.unknownEndStartDate ?? r.endDate ?? (r.startDate ? "9999" : "");
  return (
    end(b).localeCompare(end(a)) ||
    (b.startDate ?? b.unknownEndStartDate ?? "").localeCompare(a.startDate ?? a.unknownEndStartDate ?? "")
  );
}
