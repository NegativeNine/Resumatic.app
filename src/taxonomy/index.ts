import { D1Store } from "./d1";
import { Taxonomy } from "./taxonomy";

export { Taxonomy, MAX_MENTION_TEXT_CHARS, MAX_CONCEPT_PAGE } from "./taxonomy";
export { MemoryStore, type TaxonomyRecords, type TaxonomyStore } from "./store";
export { D1Store } from "./d1";
export { escoId, escoUri, onetOccupationId, schemeOf, validConceptId, validOnetSoc } from "./ids.mjs";
export { normalizeLabel, words } from "./normalize.mjs";
export * from "./types";
export * from "./vectors";

/**
 * The taxonomy for this deployment, or null where none is bound. The binding is optional, so a
 * deployment without it behaves exactly as before. One stage reads it, and only where that stage
 * is switched on: tagging in shadow (src/pipeline/tag.ts).
 */
export function taxonomyFor(env: { TAXONOMY?: D1Database }): Taxonomy | null {
  return env.TAXONOMY ? new Taxonomy(new D1Store(env.TAXONOMY)) : null;
}
