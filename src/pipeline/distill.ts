import type { Models } from "../ai/models";
import { ExtractOut, extractPrompt } from "../ai/prompts";
import { DEFAULT_RANK, checkClaim, levelOfRank, rankOf, scopeRank, unsupportedNames } from "../grounding/claims";
import { quoteIsVerbatim } from "../grounding/quote";
import { AppError } from "../shared/errors";
import type { Extraction, ExtractedFact, ExtractedRole } from "../shared/types";

/** Longer documents are refused rather than truncated, so no part of a resume is silently ignored. */
export const MAX_MARKDOWN_CHARS = 60_000;

export interface ExtractResult {
  extraction: Extraction;
  dropped: number;
}

/**
 * Asks the extract model for roles and facts, then keeps only what the document supports:
 * every quote must appear verbatim, and every fact must pass the numbers, names and scope checks
 * against its own quote. A model-assigned level above what the quote supports is lowered.
 */
export async function extractFacts(models: Models, markdown: string): Promise<ExtractResult> {
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    throw new AppError("invalid", "this document is too long to read; upload a resume of a few pages");
  }
  const out = await models.complete("extract", extractPrompt(markdown), ExtractOut);
  let dropped = 0;

  const roles: ExtractedRole[] = [];
  for (const r of out.roles) {
    if (roleSupported(markdown, r)) roles.push({ ...r, org: r.org.trim(), title: r.title?.trim() || null });
    else dropped += 1;
  }
  const roleKeys = new Set(roles.map((r) => r.key));

  const facts: ExtractedFact[] = [];
  for (const f of out.facts) {
    if (!quoteIsVerbatim(markdown, f.quote) || !checkClaim(f.text, [{ text: f.quote }]).ok) {
      dropped += 1;
      continue;
    }
    const quoteRank = scopeRank(f.quote);
    const supportedRank = quoteRank > 0 ? quoteRank : DEFAULT_RANK;
    const level = f.level && rankOf(f.level) > supportedRank ? levelOfRank(supportedRank) : f.level;
    facts.push({
      ...f,
      text: f.text.trim(),
      level: f.kind === "accomplishment" ? level : null,
      roleKey: f.roleKey && roleKeys.has(f.roleKey) ? f.roleKey : null,
    });
  }
  return { extraction: { roles, facts }, dropped };
}

/** A role's quote must be verbatim and must contain its organisation, title and years. */
function roleSupported(markdown: string, r: ExtractedRole): boolean {
  if (!quoteIsVerbatim(markdown, r.quote)) return false;
  const quote = r.quote.toLowerCase();
  if (!quote.includes(r.org.trim().toLowerCase())) return false;
  if (r.title && unsupportedNames(r.title, r.quote).length > 0) return false;
  for (const date of [r.startDate, r.endDate]) {
    const year = date?.match(/\b(19|20)\d{2}\b/)?.[0];
    if (year && !quote.includes(year)) return false;
  }
  return true;
}
