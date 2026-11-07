import { MIN_QUOTE_CHARS } from "./quote";

/** End-exclusive UTF-16 offsets, matching String.slice and browser selection APIs. */
export type Span = [number, number];
export interface NormalizedText {
  text: string;
  starts: number[];
  ends: number[];
}

function replace(
  input: NormalizedText,
  pattern: RegExp,
  value: (match: string) => string,
): NormalizedText {
  const out: NormalizedText = { text: "", starts: [], ends: [] };
  let after = 0;
  const append = (from: number, to: number) => {
    out.text += input.text.slice(from, to);
    for (let i = from; i < to; i++) {
      out.starts.push(input.starts[i]!);
      out.ends.push(input.ends[i]!);
    }
  };
  for (const match of input.text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    append(after, start);
    const next = value(match[0]);
    out.text += next;
    for (let i = 0; i < next.length; i++) {
      out.starts.push(
        input.starts[
          next.length === 1 && match[0].startsWith("\\") ? end - 1 : start
        ]!,
      );
      out.ends.push(input.ends[end - 1]!);
    }
    after = end;
  }
  append(after, input.text.length);
  return out;
}

/** Same normalization as normalizeForQuote, retaining source intervals for each UTF-16 unit. */
export function normalizeWithMap(source: string): NormalizedText {
  let mapped: NormalizedText = {
    text: source.toLowerCase(),
    starts: [],
    ends: [],
  };
  let sourceOffset = 0;
  for (const point of source) {
    for (let i = 0; i < point.toLowerCase().length; i++) {
      mapped.starts.push(sourceOffset);
      mapped.ends.push(sourceOffset + point.length);
    }
    sourceOffset += point.length;
  }
  const substitutions: [RegExp, (s: string) => string][] = [
    [/[‘’‚′]/g, () => "'"],
    [/[“”„″]/g, () => '"'],
    [/[‐-―−]/g, () => "-"],
    [/\u00a0|\u2009|\u202f/g, () => " "],
    [/\\([\\`*_{}[\]()#+\-.!|>])/g, (s) => s.slice(1)],
    [/^\s*(?:[-*+•▪●–]|\d+[.)])\s+/gm, () => " "],
    [/^\s*#{1,6}\s+/gm, () => " "],
    [/[*_`]+/g, () => ""],
    [/\s+/g, () => " "],
    [/^\s+|\s+$/g, () => ""],
  ];
  for (const [pattern, replacement] of substitutions)
    mapped = replace(mapped, pattern, replacement);
  return mapped;
}

export function validSpan(source: string, span: Span): boolean {
  if (!Array.isArray(span) || span.length !== 2) return false;
  const [start, end] = span;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > source.length
  )
    return false;
  const splitsPair = (i: number) =>
    i > 0 &&
    i < source.length &&
    /[\uD800-\uDBFF]/.test(source[i - 1]!) &&
    /[\uDC00-\uDFFF]/.test(source[i]!);
  return !splitsPair(start) && !splitsPair(end);
}

/** Repeated quotes require an explicit span; guessing would misassign provenance. */
export function locateQuote(
  source: string,
  quote: string,
  opts: { allowShort?: boolean } = {},
): Span | null {
  const normalized = normalizeWithMap(source);
  const wanted = normalizeWithMap(quote).text;
  if (!wanted || (!opts.allowShort && wanted.length < MIN_QUOTE_CHARS))
    return null;
  const index = normalized.text.indexOf(wanted);
  if (index < 0 || normalized.text.indexOf(wanted, index + 1) >= 0) return null;
  const span: Span = [
    normalized.starts[index]!,
    normalized.ends[index + wanted.length - 1]!,
  ];
  return validSpan(source, span) ? span : null;
}

/** Short skills use their complete source line as evidence. */
export function lineContext(source: string, span: Span): Span {
  const newline = source.indexOf("\n", span[1]);
  return [
    span[0] === 0 ? 0 : source.lastIndexOf("\n", span[0] - 1) + 1,
    newline < 0 ? source.length : newline,
  ];
}
