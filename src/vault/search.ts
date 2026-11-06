import type { Candidate } from "../shared/types";

export function toUnit(values: ArrayLike<number>): Float32Array {
  const v = Float32Array.from(values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("embedding dimension mismatch");
  let sum = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/**
 * For each query, the k items with the highest cosine similarity. `items` must hold unit vectors.
 * A few thousand 1,024-value vectors per user make a linear scan cheap, so no index service is needed.
 */
export function topMatches(
  queries: number[][],
  items: ReadonlyMap<string, Float32Array>,
  k: number,
): Candidate[] {
  const out: Candidate[] = [];
  queries.forEach((query, index) => {
    const q = toUnit(query);
    const scored: Candidate[] = [];
    for (const [factId, vector] of items)
      scored.push({ factId, query: index, score: dot(q, vector) });
    scored.sort((a, b) => b.score - a.score);
    out.push(...scored.slice(0, k));
  });
  return out;
}

export function packVector(values: number[]): ArrayBuffer {
  return Float32Array.from(values).buffer as ArrayBuffer;
}

export function unpackVector(blob: ArrayBuffer): Float32Array {
  return new Float32Array(blob);
}
