import { isInstruction } from "../pipeline/extract/verify";
import { AppError } from "../shared/errors";
import type { McpFitRequirement } from "../shared/mcp";

// What a connected app is told of a finished fit preview. It reads the stored requirements and the
// ids matched to each, and nothing else in the version: not the facts' wording as it was captured,
// their quotes, the profile or the report. Wording comes from the facts an app may read now.

const MAX_REQUIREMENTS = 20;
const MAX_REQUIREMENT_CHARS = 300;
const MAX_FACTS_PER_REQUIREMENT = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Each requirement of a stored fit preview, in its stored order, with the id and live wording of
 * every matched fact found in `facts`, sorted by id so the order says nothing about how well each
 * matched. A matched fact an app may not read is left out, so its requirement reads like a gap.
 * A requirement shaped like an instruction is dropped. Anything malformed refuses the whole preview.
 */
export function fitForApp(data: unknown, facts: readonly { id: string; text: string }[]): McpFitRequirement[] {
  const refuse = () => new AppError("conflict", "This fit preview can't be read. Check your fit again.");
  const result = isRecord(data) ? data.result : undefined;
  const fit = isRecord(result) ? result.fit : undefined;
  if (!isRecord(result) || result.kind !== "fit" || !isRecord(fit) || !Array.isArray(fit.requirements) ||
      fit.requirements.length > MAX_REQUIREMENTS)
    throw refuse();
  const live = new Map(facts.map((fact) => [fact.id, fact.text]));
  const requirements: McpFitRequirement[] = [];
  for (const value of fit.requirements as unknown[]) {
    if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim() || value.text.length > MAX_REQUIREMENT_CHARS ||
        !Array.isArray(value.factIds) || value.factIds.length > MAX_FACTS_PER_REQUIREMENT ||
        value.factIds.some((id) => typeof id !== "string"))
      throw refuse();
    // Requirements were read from a posting by a model; one that reads as an instruction goes nowhere.
    if (isInstruction(value.text)) continue;
    const ids = [...new Set(value.factIds as string[])].filter((id) => live.has(id)).sort();
    requirements.push({ text: value.text, facts: ids.map((id) => ({ id, text: live.get(id)! })) });
  }
  return requirements;
}
