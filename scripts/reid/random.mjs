// Seeded randomness for the re-identification harness. Every draw comes from one seed, so a run
// can be repeated exactly. Nothing here reads the clock or the machine.

/**
 * A generator seeded with a 32-bit integer (mulberry32).
 *
 * - `next()`: a number in [0, 1).
 * - `int(n)`: an integer in [0, n).
 * - `pick(list)`: one item of a non-empty list.
 * - `weighted(weights)`: the index of one weight, chosen in proportion to it.
 * - `normal(mean, sd)`: a draw from a normal distribution (Box-Muller).
 */
export function seeded(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  // A list of weights is summed once, the first time it is drawn from, and found by halving after that.
  const sums = new WeakMap();
  const weighted = (weights) => {
    let running = sums.get(weights);
    if (!running) {
      running = [];
      let total = 0;
      for (const weight of weights) running.push((total += weight));
      sums.set(weights, running);
    }
    const target = next() * running.at(-1);
    let low = 0;
    let high = running.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (running[middle] > target) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  const normal = (mean = 0, sd = 1) => {
    const u = 1 - next();
    const v = next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, int, pick, weighted, normal };
}

/** Zipf weights for ranks 1 to n with exponent s: the k-th is 1 / k^s. Not normalised. */
export function zipf(n, s) {
  return Array.from({ length: n }, (_, k) => 1 / (k + 1) ** s);
}
