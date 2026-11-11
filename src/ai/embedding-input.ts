/** Query instructions belong only on requirement searches, never on stored career facts. */
export function embeddingInput(model: string, texts: string[], purpose?: "query" | "document") {
  if (model !== "@cf/qwen/qwen3-embedding-0.6b") return { text: texts };
  return purpose === "query"
    ? { queries: texts, instruction: "Given a job requirement, retrieve career facts that provide supporting experience." }
    : { documents: texts };
}
