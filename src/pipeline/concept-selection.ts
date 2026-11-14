import type { Models } from "../ai/models";
import { JudgeOut, judgePrompt, type JudgeItem } from "../ai/prompts";
import { authoritativeFact } from "../grounding/verdict";
import { checkClaim } from "../grounding/claims";
import { cleanExtractedText } from "../shared/clean";
import type { ConceptCoverage, FactConceptEvidence, ConceptSelection } from "../shared/concept-tailoring";
import type { Analysis, Candidate, FactRecord, RoleRecord, Selection } from "../shared/types";
import type { Taxonomy } from "../taxonomy";

export interface ConceptSelectionContext {
  taxonomy: Pick<Taxonomy, "get" | "adjacent">;
  taxonomyVersion: string;
  model: string;
  requirements: ConceptSelection["requirements"];
  evidence: FactConceptEvidence[];
}
const EXTRA_CONCEPT_CANDIDATES = 4;
const MAX_COVERAGE_QUESTIONS = 240;

/**
 * Adds concept retrieval to the same embedding candidates; neither a tag nor a hierarchy edge
 * is coverage. Only an independently checked whole-line fact can support the full requirement.
 */
export async function selectConceptFacts(
  models: Models,
  search: (queries: number[][], k: number) => Promise<Candidate[]>,
  analysis: Analysis,
  facts: FactRecord[],
  roles: RoleRecord[],
  coverage: Map<string, string[]> | undefined,
  context: ConceptSelectionContext,
  limits: { perRequirement: number; maxFacts: number; maxPerRole: number; maxSkills: number; gapCosine: number },
): Promise<Selection> {
  // Explicitly selected owner duration receipts print exactly as selected, but are not general
  // retrieval/coverage evidence or writer inputs. Their own snapshot proof is checked by Vault.
  const durations = facts.filter((fact) => !!fact.skillDuration);
  const ordinary = facts.filter((fact) => !fact.skillDuration);
  const byId = new Map(ordinary.map((fact) => [fact.id, fact]));
  const roleKeys = new Map(roles.map((role) => [role.id, role.org && role.title && role.startDate
    ? JSON.stringify([role.kind, role.org.trim(), role.title.trim(), role.startDate, role.endDate, role.unknownEndStartDate ?? null]) : role.id]));
  const duplicate = (fact: FactRecord) => fact.origin !== "extracted" ? `id:${fact.id}` : JSON.stringify([
    fact.kind === "skill" ? "skill" : fact.roleId === null ? "loose" : roleKeys.get(fact.roleId) ?? fact.roleId,
    fact.kind, cleanExtractedText(fact.text), fact.level,
  ]);
  const queries = await models.embed(analysis.requirements, { purpose: "query" });
  const fallback = await search(queries, limits.perRequirement * 4);
  const evidence = context.evidence.filter((entry) => entry.taxonomyVersion === context.taxonomyVersion && byId.get(entry.factId)?.text === entry.factText && byId.get(entry.factId)?.revision === entry.factRevision);
  const validConcepts = await context.taxonomy.get([...new Set(evidence.map((entry) => entry.conceptId))]);
  const hints = new Map(evidence.filter((entry) => validConcepts.has(entry.conceptId)).map((entry) => [`${entry.factId}:${entry.conceptId}`, entry]));
  const adjacent = new Map<string, string[]>();
  const best = new Map<string, { tier: number; score: number }>();
  const decisions: ConceptCoverage[] = [];
  let asked = 0;
  for (const [index, requirement] of analysis.requirements.entries()) {
    const tagged = context.requirements[index];
    // The requirement's exact original text must still be the one that was tagged.
    const concepts = tagged?.text === requirement && tagged.status === "tagged" ? tagged.concepts : [];
    const exact = new Set(concepts.map((concept) => concept.conceptId));
    const related = new Set<string>();
    for (const concept of concepts) {
      if (!adjacent.has(concept.conceptId)) adjacent.set(concept.conceptId, (await context.taxonomy.adjacent(concept.conceptId)).map((other) => other.id));
      for (const id of adjacent.get(concept.conceptId)!) related.add(id);
    }
    const tier = new Map<string, number>();
    for (const entry of hints.values()) {
      const value = exact.has(entry.conceptId) ? 2 : related.has(entry.conceptId) ? 1 : 0;
      if (value > (tier.get(entry.factId) ?? 0)) tier.set(entry.factId, value);
    }
    const near: { factId: string; score: number }[] = [];
    const seen = new Set<string>();
    const append = (id: string, score: number) => {
      const fact = byId.get(id);
      if (!fact || seen.has(duplicate(fact))) return;
      seen.add(duplicate(fact)); near.push({ factId: id, score });
    };
    // Preserve every ordinary embedding candidate even where the taxonomy finds candidates.
    for (const candidate of fallback.filter((candidate) => candidate.query === index)) {
      append(candidate.factId, candidate.score);
      if (near.length >= limits.perRequirement) break;
    }
    const originalCount = near.length;
    for (const [id] of [...tier].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      append(id, fallback.find((candidate) => candidate.query === index && candidate.factId === id)?.score ?? 0);
      if (near.length >= originalCount + EXTRA_CONCEPT_CANDIDATES) break;
    }
    const scores = near.length ? await models.rerank(requirement, near.map((candidate) => byId.get(candidate.factId)!.text)) : [];
    const ranked = near.map((candidate, i) => ({ ...candidate, tier: tier.get(candidate.factId) ?? 0, rank: (scores[i] ?? 0) + candidate.score }))
      .sort((a, b) => b.tier - a.tier || b.rank - a.rank);
    const checked: string[] = [], supported: string[] = [];
    let unfinished = false;
    const items: JudgeItem[] = [];
    for (const candidate of ranked) {
      // Low cosine has never been proof of absence. Concept candidates may be useful below it;
      // the full evidence check, rather than the cosine or tag, makes the coverage decision.
      const fact = authoritativeFact(byId.get(candidate.factId)!);
      if (!checkClaim(requirement, [fact]).ok) { checked.push(candidate.factId); continue; }
      if (asked + items.length >= MAX_COVERAGE_QUESTIONS) { unfinished = true; continue; }
      items.push({ alias: candidate.factId, text: requirement, facts: [{ text: fact.text, quote: fact.quote }] });
    }
    if (items.length) {
      asked += items.length;
      const response = models.judge ? await models.judge(items) : await models.complete("judge", judgePrompt(items), JudgeOut);
      const verdicts = new Map<string, boolean | null>();
      const expected = new Set(items.map((item) => item.alias));
      for (const verdict of response.verdicts) {
        const id = typeof verdict.id === "string" ? verdict.id.trim() : "";
        if (!expected.has(id)) continue;
        // Duplicate or malformed answers establish neither support nor absence.
        verdicts.set(id, verdicts.has(id) || id !== verdict.id || !["supported", "unsupported", "overstated"].includes(verdict.verdict)
          ? null : verdict.verdict === "supported");
      }
      for (const item of items) {
        if (typeof verdicts.get(item.alias) !== "boolean") unfinished = true;
        else checked.push(item.alias);
        if (verdicts.get(item.alias) === true) supported.push(item.alias);
      }
    }
    for (const candidate of ranked) {
      const prior = best.get(candidate.factId);
      if (!prior || candidate.tier > prior.tier || candidate.tier === prior.tier && candidate.rank > prior.score)
        best.set(candidate.factId, { tier: candidate.tier, score: candidate.rank });
    }
    coverage?.set(requirement, supported.slice(0, 3));
    decisions.push({ requirement, status: supported.length ? "supported" : unfinished || !checked.length ? "unknown" : "not_evidenced", factIds: supported.slice(0, 3),
      conceptStatus: concepts.length ? "tagged" : "unknown", concepts: concepts.map((concept) => ({ id: concept.conceptId, label: concept.label,
        factIds: supported.filter((id) => hints.has(`${id}:${concept.conceptId}`)) })) });
  }
  const factIds: string[] = [], skillIds: string[] = [...new Set(durations.map((fact) => fact.id))].slice(0, Math.min(12, limits.maxSkills)), selected = new Set(durations.map(duplicate)), counts = new Map<string, number>();
  for (const [id] of [...best].sort((a, b) => b[1].tier - a[1].tier || b[1].score - a[1].score)) {
    const fact = byId.get(id)!;
    const key = duplicate(fact);
    if (selected.has(key)) continue;
    if (fact.kind === "skill") { if (skillIds.length < limits.maxSkills) { skillIds.push(id); selected.add(key); } continue; }
    const role = fact.roleId === null ? "none" : roleKeys.get(fact.roleId) ?? fact.roleId;
    if (factIds.length >= limits.maxFacts || (counts.get(role) ?? 0) >= limits.maxPerRole) continue;
    counts.set(role, (counts.get(role) ?? 0) + 1); factIds.push(id); selected.add(key);
  }
  return { factIds, skillIds, gaps: decisions.filter((decision) => decision.status === "not_evidenced").map((decision) => decision.requirement),
    concepts: { method: "concept-evidence/1", taxonomyVersion: context.taxonomyVersion, model: context.model, requirements: context.requirements, coverage: decisions } };
}
