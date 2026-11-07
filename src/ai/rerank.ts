/** Decode a complete reranker response in the same order as the submitted texts. */
export function rerankScores(result: unknown, count: number): number[] {
  if (!Number.isSafeInteger(count) || count < 0 || !result || typeof result !== "object" ||
      !Array.isArray((result as { response?: unknown }).response))
    throw new Error("rerank_response_shape");
  const rows = (result as { response: unknown[] }).response;
  if (rows.length !== count) throw new Error("rerank_response_shape");
  const scores = new Array<number>(count);
  const seen = new Set<number>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("rerank_response_shape");
    const { id, score } = row as { id?: unknown; score?: unknown };
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id >= count ||
        seen.has(id) || typeof score !== "number" || !Number.isFinite(score))
      throw new Error("rerank_response_shape");
    seen.add(id);
    scores[id] = score;
  }
  return scores;
}
