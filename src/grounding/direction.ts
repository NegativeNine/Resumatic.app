/** Narrow English direction reversals on an identical, explicitly named object.
 * This is a contradiction check, not a general entailment or sentiment model. */
const UP = new Set(["increase", "increases", "increased", "increasing", "raise", "raises", "raised", "raising", "grow", "grows", "grew", "growing", "boost", "boosts", "boosted", "boosting"]);
const DOWN = new Set(["decrease", "decreases", "decreased", "decreasing", "reduce", "reduces", "reduced", "reducing", "lower", "lowers", "lowered", "lowering", "cut", "cuts", "cutting", "depress", "depresses", "depressed", "depressing"]);
const BREAK = new Set(["and", "but", "by", "from", "to", "for", "with", "through", "across", "via", "using", "during", "over", "as", "after", "before", "compared", "between", "versus", "vs", "in", "on", "at", "which", "that", "resulting", "while", "without"]);
const ARTICLE = new Set(["a", "an", "the", "our", "their", "its", "my"]);
// These can introduce a qualifier that changes which object is meant. Do not
// compare only the prefix (for example, investments in different projects).
const QUALIFIER = new Set(["in", "on", "at", "for", "across", "with", "during", "using", "through", "via", "between"]);
const UNCERTAIN = new Set(["not", "no", "never", "neither", "without", "prevent", "prevented", "preventing", "avoid", "avoided", "avoiding", "cannot", "can't", "didn't", "doesn't", "don't", "isn't", "wasn't", "weren't", "couldn't", "wouldn't"]);

function directions(text: string): Map<string, Set<"up" | "down">> {
  const result = new Map<string, Set<"up" | "down">>();
  const words = text.toLowerCase().replaceAll("’", "'").match(/[a-z]+(?:['-][a-z]+)*|\d+|[^\s]/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const direction = UP.has(words[i]!) ? "up" : DOWN.has(words[i]!) ? "down" : null;
    if (!direction) continue;
    const previous = words.slice(Math.max(0, i - 5), i);
    const boundary = previous.findLastIndex((word) => /^[.!?;:,]$/.test(word) || word === "but");
    if (previous.slice(boundary + 1).some((word) => UNCERTAIN.has(word))) continue;
    let j = i + 1;
    if (ARTICLE.has(words[j] ?? "")) j++;
    const object: string[] = [];
    while (j < words.length && object.length <= 5 && /^[a-z]+(?:['-][a-z]+)*$/.test(words[j]!) && !BREAK.has(words[j]!)) {
      object.push(words[j++]!);
    }
    // Never collapse a long object into a misleading shared prefix.
    if (!object.length || object.length > 5 || QUALIFIER.has(words[j] ?? "")) continue;
    const key = object.join(" ");
    const found = result.get(key) ?? new Set<"up" | "down">();
    found.add(direction);
    result.set(key, found);
  }
  return result;
}

export function contradictedDirections(claim: string, evidence: readonly string[]): string[] {
  const support = new Map<string, Set<"up" | "down">>();
  for (const text of evidence) for (const [object, values] of directions(text)) {
    const known = support.get(object) ?? new Set<"up" | "down">();
    for (const value of values) known.add(value);
    support.set(object, known);
  }
  return [...directions(claim)].flatMap(([object, values]) => {
    const known = support.get(object);
    if (!known) return [];
    return [...values].some((value) => !known.has(value) && known.has(value === "up" ? "down" : "up")) ? [object] : [];
  });
}
