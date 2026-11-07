/** Validate the representation actually used by Vault storage and search. */
export function floatEmbedding(values: ArrayLike<number>): Float32Array {
  if (!Number.isSafeInteger(values.length) || values.length < 1 || values.length > 16_384)
    throw new Error("invalid_embedding_vector");
  const vector = new Float32Array(values.length);
  let nonzero = false;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("invalid_embedding_vector");
    vector[i] = value;
    if (!Number.isFinite(vector[i])) throw new Error("invalid_embedding_vector");
    if (vector[i] !== 0) nonzero = true;
  }
  if (!nonzero) throw new Error("invalid_embedding_vector");
  return vector;
}

export function usableEmbedding(values: unknown): values is number[] {
  if (!Array.isArray(values)) return false;
  try { floatEmbedding(values); return true; } catch { return false; }
}
