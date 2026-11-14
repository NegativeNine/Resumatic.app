import type { Models } from "../ai/models";
import type { Analysis } from "../shared/types";
import type { FactConceptEvidence } from "../shared/concept-tailoring";
import { taxonomyFor, taxonomyVectorsFor } from "../taxonomy";
import { TAG_KINDS } from "./tag";
import { tagRequirements } from "./requirement-tags";
import type { ConceptSelectionContext } from "./concept-selection";

/** Optional reference reads stay inert unless this run explicitly captured concept evidence. */
export async function conceptContext(env: Env, models: Models, analysis: Analysis, evidence: FactConceptEvidence[] | undefined): Promise<ConceptSelectionContext | undefined> {
  if (env.TAILOR_CONCEPTS_ENABLED !== "true" || evidence === undefined) return;
  const taxonomy = taxonomyFor(env);
  if (!taxonomy) return;
  let version: string;
  try { version = (await taxonomy.info()).version; } catch { return; }
  const tagged = await tagRequirements(models, taxonomy, analysis.requirements.map((text, index) => ({ id: `R${index + 1}`, text })), { model: env.MODEL_JUDGE, taxonomyVersion: version }, {
    vectors: env.TAXONOMY_VECTORS ? () => taxonomyVectorsFor(env, taxonomy, version, TAG_KINDS, models) : undefined,
  });
  return { taxonomy, taxonomyVersion: version, model: env.MODEL_JUDGE, requirements: tagged.requirements, evidence };
}
