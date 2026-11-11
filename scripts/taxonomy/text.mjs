// Small text helpers shared by the readers. A value is stored on one line: the SQL the builder
// writes is run a line at a time, so a line break inside a value would cut a statement in two.

/** A value with its white space collapsed to single spaces and its ends trimmed. */
export function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** The entries of a cell that lists one per line, cleaned, without blanks or repeats. */
export function lines(value) {
  if (typeof value !== "string") return [];
  const seen = new Set();
  for (const part of value.split(/\r?\n/)) {
    const text = clean(part);
    if (text) seen.add(text);
  }
  return [...seen];
}
