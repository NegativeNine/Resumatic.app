// Where a file's words are marked. A mark is placed only on a saved span whose words are exactly
// the saved quote: searching the file for the quote's words could mark the wrong line, so a span
// that doesn't match marks nothing, and the quote is still shown on its own beside the fact.

/** The fact or role being checked, one still to check, or one confirmed. */
export type Tone = "current" | "waiting" | "backed";

export interface SourceMark {
  span: readonly [number, number] | null | undefined;
  quote: string | null | undefined;
  tone: Tone;
}

/** A piece of the file's text, marked with a tone or, between marks, not marked. */
export interface SourceRun {
  text: string;
  tone: Tone | null;
}

/** Whether `span` is whole numbers inside the text, and the words there are exactly `quote`. */
export function validSpan(
  markdown: string,
  span: readonly [number, number] | null | undefined,
  quote: string | null | undefined,
): span is readonly [number, number] {
  if (!span || typeof quote !== "string") return false;
  const [start, end] = span;
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    start < end &&
    end <= markdown.length &&
    markdown.slice(start, end) === quote
  );
}

/**
 * The file's text cut into runs. Marks that don't match their quote are dropped. The item being
 * checked is placed first, so it wins any overlap; the rest are placed in the order they start,
 * and a mark that overlaps one already placed is dropped. The text between marks is kept.
 */
export function sourceRuns(markdown: string, marks: readonly SourceMark[]): SourceRun[] {
  const valid = marks
    .filter((mark) => validSpan(markdown, mark.span, mark.quote))
    .map((mark) => ({ start: mark.span![0], end: mark.span![1], tone: mark.tone }));
  const byStart = (a: { start: number }, b: { start: number }) => a.start - b.start;
  const ordered = [...valid.filter((mark) => mark.tone === "current").sort(byStart), ...valid.filter((mark) => mark.tone !== "current").sort(byStart)];
  const placed: typeof valid = [];
  for (const mark of ordered) {
    if (!placed.some((other) => mark.start < other.end && other.start < mark.end)) placed.push(mark);
  }
  placed.sort(byStart);
  const runs: SourceRun[] = [];
  let at = 0;
  for (const mark of placed) {
    if (mark.start > at) runs.push({ text: markdown.slice(at, mark.start), tone: null });
    runs.push({ text: markdown.slice(mark.start, mark.end), tone: mark.tone });
    at = mark.end;
  }
  if (at < markdown.length) runs.push({ text: markdown.slice(at), tone: null });
  return runs;
}
