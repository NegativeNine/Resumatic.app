import { ROUTE_TEMPERATURE } from "../ai/models";
import { MAX_LINE_CHARS, type ResumeLine } from "../shared/api";
import type { FactRecord } from "../shared/types";
import { authoritativeFact } from "../grounding/verdict";
import { base64url, sha256 } from "../worker/crypto";
import { isInstruction } from "./extract/verify";
import {
  writeDocument,
  type CitedUnit,
  type DocumentDraft,
  type DocumentInput,
  type DocumentResult,
} from "./documents";

/** Candidate text is always reverified before publication; this is not a verification bypass. */
export interface CachedRefinement {
  edits: { position: number; text: string }[];
}
type SourceLine = ResumeLine & { roleId: string | null; group: number };
function linesFor(input: DocumentInput): SourceLine[] {
  if (input.kind !== "refine" || !input.base) return [];
  const all = [
    ...(input.base.summary
      ? [{ ...input.base.summary, roleId: null, group: 0 }]
      : []),
    ...input.base.sections.flatMap((section, index) =>
      section.lines.map((line) => ({
        ...line,
        roleId: section.roleId,
        group: index + 1,
      })),
    ),
  ];
  const requested = new Set(input.lineIds ?? all.map((line) => line.id));
  const available = new Set(input.facts.map((fact) => fact.id));
  return all.filter(
    (line) =>
      requested.has(line.id) &&
      line.status !== "edited" &&
      line.factIds.length > 0 &&
      line.factIds.every((id) => available.has(id)),
  );
}

/** Hash all inputs that influence a writer request; no career text is used as a SQL key. */
export async function refinementCacheKey(
  input: DocumentInput,
  model: string,
): Promise<string | null> {
  const lines = linesFor(input);
  if (!input.instruction?.trim() || !lines.length) return null;
  const ids = new Set(lines.flatMap((line) => line.factIds));
  const facts = input.facts
    .filter((fact) => ids.has(fact.id))
    .map((fact: FactRecord) => authoritativeFact(fact))
    .sort((a, b) => a.id.localeCompare(b.id));
  const body = {
    format: 1,
    model,
    temperature: ROUTE_TEMPERATURE.write,
    // A deploy that changes this writer's prompt or validation produces a new key.
    writer: writeDocument.toString(),
    instruction: input.instruction,
    lines: lines.map(({ roleId, group, text, factIds }) => ({
      roleId,
      group,
      text,
      factIds,
    })),
    facts,
    roles: input.roles
      .map(({ id, revision, kind, org, title, startDate, endDate }) => ({
        id,
        revision,
        kind,
        org,
        title,
        startDate,
        endDate,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return base64url(await sha256(JSON.stringify(body)));
}

/** Save changed, verified lines only. Edited user-authored lines never enter the cache. */
export function cacheRefinement(
  input: DocumentInput,
  result: DocumentResult,
): CachedRefinement {
  const lines = linesFor(input);
  const byId = new Map(result.units.map((unit) => [unit.id, unit]));
  return {
    edits: lines.flatMap((line, position) => {
      const unit = byId.get(line.id);
      return unit &&
        (unit.status === "kept" || unit.status === "repaired") &&
        unit.text !== line.text
        ? [{ position, text: unit.text }]
        : [];
    }),
  };
}

/** Restore current line IDs and citations from the current snapshot, never from cache. */
export function cachedRefinementDraft(
  input: DocumentInput,
  cached: CachedRefinement,
): DocumentDraft | null {
  const lines = linesFor(input);
  if (
    !cached ||
    !Array.isArray(cached.edits) ||
    cached.edits.length > lines.length
  )
    return null;
  const seen = new Set<number>();
  const units: CitedUnit[] = [];
  for (const edit of cached.edits) {
    if (
      !Number.isInteger(edit.position) ||
      edit.position < 0 ||
      edit.position >= lines.length ||
      seen.has(edit.position) ||
      typeof edit.text !== "string" ||
      !edit.text.trim() ||
      edit.text.length > MAX_LINE_CHARS ||
      isInstruction(edit.text)
    )
      return null;
    seen.add(edit.position);
    units.push({ ...lines[edit.position]!, text: edit.text });
  }
  return { units };
}
