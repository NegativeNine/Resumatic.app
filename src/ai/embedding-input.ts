/**
 * What a text is embedded as. A requirement search is a "query" and a stored career fact a
 * "document". A "concept-query" is a resume line or a job title looked up in the taxonomy's
 * vector index (src/taxonomy/vectors.ts), whose concepts were embedded as documents.
 */
export type EmbeddingPurpose = "query" | "document" | "concept-query";

/** The instruction a line or a title is looked up in the taxonomy's vector index with. Changing it changes `vector-judge/1`. */
export const CONCEPT_LOOKUP_INSTRUCTION =
  "Given a line from a resume or a job title, retrieve the skills, knowledge, work activities, software and occupations it shows.";

/** Query instructions belong only on searches, never on stored career facts or the taxonomy's concepts. */
export function embeddingInput(model: string, texts: string[], purpose?: EmbeddingPurpose) {
  if (model !== "@cf/qwen/qwen3-embedding-0.6b") return { text: texts };
  if (purpose === "concept-query") return { queries: texts, instruction: CONCEPT_LOOKUP_INSTRUCTION };
  return purpose === "query"
    ? { queries: texts, instruction: "Given a job requirement, retrieve career facts that provide supporting experience." }
    : { documents: texts };
}
