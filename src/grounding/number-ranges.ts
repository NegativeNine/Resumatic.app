/** An exact same-line range is evidence for that range, not its endpoints. */
export interface NumberRange {
  start: number;
  end: number;
  raw: string;
  key: string;
  valid: boolean;
}

const space = "[^\\S\\r\\n\\u2028\\u2029]";
// The permissive final alternative captures malformed separators so that a
// partial number cannot escape the range scanner as standalone evidence.
const literal = "(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+|\\d[\\d,.]*)(?:e[+\\-−]?\\d+)?(?:st|nd|rd|th)?";
const ordinalWord = `(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-‐‑‒–—]|${space}+)(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth)`;
const word = `(?:${ordinalWord}|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:(?:[-‐‑‒–—]|${space}+)(?:one|two|three|four|five|six|seven|eight|nine))?|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen))`;
const fraction = `(?:\\d+[⁄∕/]\\d+|\\d*[¼½¾⅐-⅞]|(?:one|two|three|four|five|six|seven|eight|nine)(?:[-‐‑‒–—]|${space}+)(?:half|halves|thirds?|quarters?)|half|quarter)`;
const unit = "(?:%|-?percentage[ ]points?\\b|-?percent\\b|-?per[ ]cent\\b|-?pct\\b|basis[ ]points?\\b|bps\\b|k\\b|thousand\\b|mm\\b|m\\b|million\\b|bn\\b|b\\b|billion\\b|x\\b|×|times\\b|-?fold\\b|[$€£]|dollars?\\b|euros?\\b|pounds?[ ]sterling\\b|USD\\b|EUR\\b|GBP\\b)";
const join = `(?:${space}+|[-‐‑‒–—])`;
const small = `(?:${fraction}|${literal}|${word})`;
const group = `(?:(?:${small}|a)${join}hundred(?:${join}(?:and${join})?${small})?|hundred(?:${join}(?:and${join})?${small})?|${small}|a)`;
const quantity = `${group}(?:${join}(?:thousand|million|billion)(?:${join}(?:and${join})?${group})?)*`;
const endpointCore = `(?:[+\\-−]${space}*)?(?:[$€£]|USD\\b|EUR\\b|GBP\\b)?${space}*(?:[+\\-−]${space}*)?${quantity}(?:${space}*${unit})?`;
const endpoint = `(?:\\(${space}*${endpointCore}${space}*\\)|${endpointCore})`;
// Hyphens between English words can instead form one compound number (for
// example twenty-five), so word endpoints require "to" or "between ... and".
const digitFraction = "(?:\\d+[⁄∕/]\\d+|\\d*[¼½¾⅐-⅞])";
const digitEndpointCore = `(?:[+\\-−]${space}*)?(?:[$€£]|USD\\b|EUR\\b|GBP\\b)?${space}*(?:[+\\-−]${space}*)?(?:${digitFraction}|${literal})(?:${space}*${unit})?`;
const digitEndpoint = `(?:\\(${space}*${digitEndpointCore}${space}*\\)|${digitEndpointCore})`;
const range = new RegExp(
  `(?<![\\p{L}\\p{N}_.,/⁄∕])(?:between${space}+(${endpoint})${space}+and${space}+(${endpoint})|(${endpoint})${space}+(?:to|through)${space}+(${endpoint})|(${digitEndpoint})${space}*[-–—]${space}*(${digitEndpoint})|(${endpoint})${space}*[–—]${space}*(${endpoint}))(?![\\p{L}\\p{N}_])`,
  "giu",
);
// A partially parsed scale, fraction, or non-ASCII numeral can change the
// endpoint. Consume it as part of an unmatchable range instead of silently
// presenting the shorter prefix as evidence.
const continuation = new RegExp(
  `^(?:[-‐‑‒–—][\\p{L}\\p{M}]+|${space}*(?:(?:hundred|thousand|million|billion|dozen)[\\p{L}]*|(?:[.,/⁄∕٫٬]\\p{N}+|[\\p{No}\\p{Nl}]+)(?:${space}*(?:hundred|thousand|million|billion|dozen)[\\p{L}]*)?)|${space}+(?:${fraction}|${literal}|${word})(?:(?:${space}+|[-‐‑‒–—])(?:${fraction}|${literal}|${word}|hundred|thousand|million|billion|dozen|and))*)`,
  "iu",
);

/** Existing date components are excluded so ISO dates are not split as ranges. */
export function numberRanges(text: string, dateSpans: [number, number][]): NumberRange[] {
  const result: NumberRange[] = [];
  for (const match of text.matchAll(range)) {
    const start = match.index;
    const extra = continuation.exec(text.slice(start + match[0].length));
    const end = start + match[0].length + (extra?.[0].length ?? 0);
    if (dateSpans.some(([a, b]) => start < b && end > a)) continue;
    const left = match[1] ?? match[3] ?? match[5] ?? match[7]!;
    const right = match[2] ?? match[4] ?? match[6] ?? match[8]!;
    // Preserve the existing year/date interpretation of 2019–2021.
    if (/^(?:19|20)\d{2}$/.test(left) && /^(?:19|20)\d{2}$/.test(right)) continue;
    const raw = text.slice(start, end);
    // A tens word joined directly to a unit word is the existing written
    // compound cardinal, including the Unicode dashes accepted by its parser.
    if (/^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[–—](?:one|two|three|four|five|six|seven|eight|nine)\b/i.test(raw)) continue;
    const currencies = new Set<string>();
    if (/\$|\bUSD\b|\bdollars?\b/i.test(raw)) currencies.add("dollar");
    if (/€|\bEUR\b|\beuros?\b/i.test(raw)) currencies.add("euro");
    if (/£|\bGBP\b|\bpounds? sterling\b/i.test(raw)) currencies.add("sterling");
    const percent = /%|\b(?:percent|percentage|pct|bps)\b|\bper cent\b|\bbasis points?\b/i.test(raw);
    const multiplier = /×|\b(?:x|times|fold)\b|-fold\b/i.test(raw);
    // Do not make inconsistent currencies or unrepresentable literals
    // usable simply because the same malformed text appears twice.
    const numbers = [...raw.matchAll(/(?:\d[\d,.]*|\.\d+)(?:e[+\-−]?\d+)?/gi)];
    const representable = numbers.every(({ 0: value }) => {
      const [mantissa] = value.toLowerCase().split("e");
      const significant = mantissa!.replace(/[.,]/g, "").replace(/^0+/, "").replace(/0+$/, "");
      const n = Number(value.replace(/,/g, "").replace("−", "-"));
      const wellFormed = /^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?$/i.test(value.replace("−", "-"));
      return wellFormed && significant.length <= 15 && Number.isFinite(n) && (n !== 0 || !/[1-9]/.test(mantissa!)) && (!Number.isInteger(n) || Number.isSafeInteger(n));
    });
    const hasFraction = /[⁄∕/¼½¾⅐-⅞]|\b(?:half|halves|thirds?|quarters?)\b/i.test(raw);
    const ordinal = /(?:\d(?:st|nd|rd|th)|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth))\b/i;
    result.push({ start, end, raw, key: raw.toLowerCase().replace(/\s+/g, " ").trim(), valid: !extra && !hasFraction && currencies.size <= 1 && !(percent && (currencies.size > 0 || multiplier)) && !(multiplier && currencies.size > 0) && ordinal.test(left) === ordinal.test(right) && representable });
  }
  return result;
}
