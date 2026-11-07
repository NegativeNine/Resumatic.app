import type { ResumeBody, ResumeLine } from "../shared/api";
import type { FactRecord, RoleRecord } from "../shared/types";
import { evidenceForFacts, sameEvidence, type ResumeVersion } from "./snapshots";
import { AppError } from "../shared/errors";

type Receipt = NonNullable<ResumeVersion["legacyReceipts"]>[string];
type Line = { line: ResumeLine; roleId: string | null };

function linesOf(body: ResumeBody): Line[] | null {
  if (!body || !Array.isArray(body.sections) || !Array.isArray(body.skills)) return null;
  const lines: Line[] = [];
  if (body.summary) lines.push({ line: body.summary, roleId: null });
  for (const section of body.sections) {
    if (!section || typeof section.roleId !== "string" || !Array.isArray(section.lines)) return null;
    for (const line of section.lines) lines.push({ line, roleId: section.roleId });
  }
  const seen = new Set<string>();
  for (const { line } of lines) {
    if (!line || typeof line.id !== "string" || !line.id || seen.has(line.id) ||
        typeof line.text !== "string" || !line.text.trim() || !Array.isArray(line.factIds)) return null;
    seen.add(line.id);
  }
  return lines;
}

/** Record only an exact candidate already accepted by the independent judge. */
function sameRole(a: RoleRecord | undefined, b: RoleRecord | undefined): boolean {
  return !!a && !!b && Number.isSafeInteger(a.revision) && (a.revision ?? 0) > 0 &&
    Number.isSafeInteger(b.revision) && a.revision === b.revision && a.id === b.id &&
    a.kind === b.kind && a.org === b.org && a.title === b.title &&
    a.startDate === b.startDate && a.endDate === b.endDate &&
    (a.unknownEndStartDate ?? null) === (b.unknownEndStartDate ?? null);
}

export function legacyReceipt(body: ResumeBody, lineId: string, captured: FactRecord[], roles: RoleRecord[]): Receipt {
  const item = linesOf(body)?.find(({ line }) => line.id === lineId);
  if (!item || item.line.status !== "kept" || !item.line.factIds.length || item.line.factIds.length > 4 ||
      new Set(item.line.factIds).size !== item.line.factIds.length)
    throw new AppError("conflict", "the checked line is missing its evidence");
  const byId = new Map(captured.map((fact) => [fact.id, fact]));
  const facts = item.line.factIds.map((id) => byId.get(id));
  if (facts.some((fact) => !fact || (item.roleId !== null && fact.roleId !== item.roleId)))
    throw new AppError("conflict", "the checked line's facts are unavailable");
  const checked = evidenceForFacts(facts as FactRecord[]);
  const complete = item.line.factIds.map((id) => checked[id]!);
  const roleIds = [...new Set([item.roleId, ...complete.map((fact) => fact.roleId)].filter((id): id is string => id !== null))].sort();
  const roleMap = new Map(roles.map((role) => [role.id, role]));
  const savedRoles = roleIds.map((id) => roleMap.get(id));
  if (savedRoles.some((role) => !sameRole(role, role)))
    throw new AppError("conflict", "the checked line's roles are unavailable");
  return { text: item.line.text, roleId: item.roleId, factIds: [...item.line.factIds], facts: complete,
    roles: (savedRoles as RoleRecord[]).map((role) => ({ ...role })) };
}

/** Old statuses and citations do not count; only receipts matching live confirmed evidence do. */
export function legacyReview(saved: ResumeVersion, facts: FactRecord[], roles: RoleRecord[]) {
  const lines = linesOf(saved.render.body);
  const current = new Map(facts.map((fact) => [fact.id, fact]));
  const roleMap = new Map(roles.map((role) => [role.id, role]));
  const verifiedLineIds: string[] = [];
  for (const item of lines ?? []) {
    const receipt = saved.legacyReceipts?.[item.line.id];
    if (!receipt || item.line.status !== "kept" || receipt.text !== item.line.text || receipt.roleId !== item.roleId ||
        !Array.isArray(receipt.factIds) || !receipt.factIds.length || receipt.factIds.length > 4 ||
        !Array.isArray(receipt.facts) || receipt.facts.length !== receipt.factIds.length || !Array.isArray(receipt.roles) ||
        new Set(receipt.factIds).size !== receipt.factIds.length ||
        JSON.stringify(receipt.factIds) !== JSON.stringify(item.line.factIds)) continue;
    const roleIds = [...new Set([item.roleId, ...receipt.facts.map((fact) => fact?.roleId)].filter((id): id is string => typeof id === "string"))].sort();
    if (receipt.roles.length !== roleIds.length || !roleIds.every((id, i) => receipt.roles[i]?.id === id && sameRole(receipt.roles[i], roleMap.get(id)))) continue;
    if (receipt.factIds.every((id, i) => {
      const fact = receipt.facts[i];
      return !!fact && fact.id === id && (item.roleId === null || fact.roleId === item.roleId) &&
        (fact.roleId === null || roleMap.has(fact.roleId)) && sameEvidence(fact, current.get(id));
    })) verifiedLineIds.push(item.line.id);
  }
  const sections = saved.render.body?.sections;
  const headersReady = !!lines && Array.isArray(sections) && sections.every((section) => {
    const role = roleMap.get(section.roleId);
    return !!role && role.kind === section.kind && role.org === section.org && role.title === section.title &&
      role.startDate === section.startDate && role.endDate === section.endDate &&
      (role.unknownEndStartDate ?? null) === (section.unknownEndStartDate ?? null);
  });
  const skillsReady = !!lines && saved.render.body.skills.every((skill) =>
    typeof skill === "string" && !!skill.trim() && facts.some((fact) => fact.kind === "skill" && fact.text === skill && sameEvidence(fact, current.get(fact.id))));
  return { verifiedLineIds, totalLines: lines?.length ?? -1, headersReady, skillsReady };
}

/** Rebuild the output's evidence solely from fresh receipts and confirmed skills. */
export function finalLegacyEvidence(saved: ResumeVersion, facts: FactRecord[], roles: RoleRecord[]) {
  const review = legacyReview(saved, facts, roles);
  if (saved.provenance !== "legacy" || review.totalLines < 0 ||
      (review.totalLines === 0 && saved.render.body.skills.length === 0) ||
      review.verifiedLineIds.length !== review.totalLines || !review.headersReady || !review.skillsReady)
    throw new AppError("conflict", "verify every line and confirm its roles and skills before finishing");
  const ids = new Set<string>();
  for (const id of review.verifiedLineIds) for (const factId of saved.legacyReceipts![id]!.factIds) ids.add(factId);
  for (const skill of saved.render.body.skills) {
    const fact = facts.find((item) => item.kind === "skill" && item.text === skill);
    if (!fact) throw new AppError("conflict", "confirm the skills before finishing");
    ids.add(fact.id);
  }
  const evidence = evidenceForFacts(facts.filter((fact) => ids.has(fact.id)));
  if (Object.keys(evidence).length !== ids.size) throw new AppError("conflict", "supporting facts changed; review them again");
  const summary = Object.fromEntries(Object.entries(evidence).map(([id, fact]) => [id, { text: fact.text, quote: fact.quote }]));
  return { facts: summary, evidence, count: review.totalLines };
}
