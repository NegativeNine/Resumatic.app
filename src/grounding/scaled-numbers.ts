import type { NumberToken } from "./claims";
import { numberQualifier } from "./number-qualifier";

// Scaled phrases are scanned before the other number recognizers. Their
// components must never become independent evidence. Unknown forms get an
// unmatchable token, so neither a generated claim nor evidence can use them
// as a different quantity.
const cardinal: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ordinals: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
  seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
  thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60,
  seventieth: 70, eightieth: 80, ninetieth: 90,
};
const scales: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, dozen: 12 };
const space = "[^\\S\\r\\n\\u2028\\u2029]";
const join = `(?:${space}|[-‐-―−/⁄∕＋±]|[\\p{Cf}\\p{M}])+`;
const numeric = "(?:\\p{Nd}+(?:[.,/⁄∕٫٬]\\p{Nd}+)*|\\.\\p{Nd}+)(?:e[+\\-−]?\\p{Nd}+)?(?:[¼½¾⅐-⅞])?(?:st|nd|rd|th)?|\\p{N}[\\p{N}]*(?:hundred|thousand|million|billion|dozen)[\\p{L}]*|\\p{N}+";
const words = [...Object.keys(cardinal), ...Object.keys(ordinals), "hundred", "thousand", "million", "billion", "dozen", "a", "and", "in", "to", "half", "quarter", "quarters", "thirds", "few", "several", "many"]
  .sort((a, b) => b.length - a.length).join("|");
// Keep unknown suffixes attached to scale words, e.g. hundredfolded, rather
// than accidentally treating the leading word as a valid smaller number.
const atom = `(?:${numeric}|(?:hundred|thousand|million|billion|dozen)[\\p{L}]*|${words})`;
const firstWords = [...Object.keys(cardinal), ...Object.keys(ordinals), "hundred", "thousand", "million", "billion", "dozen", "a", "half", "quarter", "quarters", "thirds", "few", "several", "many"]
  .sort((a, b) => b.length - a.length).join("|");
const first = `(?:${numeric}|(?:hundred|thousand|million|billion|dozen)[\\p{L}]*|${firstWords})`;
const sequence = new RegExp(`(?<![\\p{L}\\p{N}_.,/⁄∕])(${first}(?:${join}${atom})*)(?![\\p{L}\\p{N}_])`, "giu");
const tokenPattern = new RegExp(atom, "giu");
const suffix = new RegExp(`^${space}*(%|-?percent\\b|-?per${space}+cent\\b|x\\b|×|times\\b|-?fold\\b)?(?:${space}*(dollars?|euros?|pounds?${space}+sterling|USD|EUR|GBP)\\b)?`, "i");
const prefix = new RegExp(`(?:(?:\\b(minus|negative)${space}+|([-−])${space}*)?([$€£]|\\bUSD|\\bEUR|\\bGBP)?${space}*([-−])?${space}*)$`, "i");

export interface ScaledNumber { start: number; end: number; token: NumberToken }

function currency(value?: string): NumberToken["currency"] {
  if (!value) return null;
  if (/^(?:\$|usd|dollars?)$/i.test(value)) return "dollar";
  if (/^(?:€|eur|euros?)$/i.test(value)) return "euro";
  if (/^(?:£|gbp|pounds?\s+sterling)$/i.test(value)) return "sterling";
  return null;
}

function group(parts: number[]): number {
  if (!parts.length) return 0;
  if (parts.length === 1) return parts[0]!;
  if (parts[0]! >= 100 && parts[0]! % 100 === 0) {
    const rest = group(parts.slice(1));
    return rest < 100 ? parts[0]! + rest : Infinity;
  }
  if (parts.length === 2 && parts[0]! >= 20 && parts[0]! <= 90 && parts[0]! % 10 === 0 && parts[1]! > 0 && parts[1]! < 10)
    return parts[0]! + parts[1]!;
  return Infinity;
}

/** Shift a single checked decimal literal by a power of ten without
 * introducing a multiply-and-round difference in the binary float. */
function shiftDecimal(value: string, power: number): number {
  const match = /^((?:\d+(?:\.\d+)?|\.\d+))(?:e([+\-]?\d+))?$/i.exec(value);
  if (!match) return Infinity;
  const exponent = Number(match[2] ?? "0") + power;
  return Number.isSafeInteger(exponent) ? Number(`${match[1]}e${exponent}`) : Infinity;
}

/** Full same-line scale spans to mask in every other scanner. */
export function scaledNumbers(text: string): ScaledNumber[] {
  const result: ScaledNumber[] = [];
  for (const match of text.matchAll(sequence)) {
    const raw = match[1]!;
    const tokens = [...raw.matchAll(tokenPattern)].map((item) => item[0].toLowerCase());
    if (!tokens.some((token) => /(?:hundred|thousand|million|billion|dozen)/.test(token))) continue;
    let end = match.index + raw.length;
    const unitMatch = suffix.exec(text.slice(end, end + 128));
    if (unitMatch) end += unitMatch[0].length;
    const unit = (unitMatch?.[1] ?? "").toLowerCase().replace(/\s+/g, " ").replace(/^-((?:per cent|percent))$/, "$1");
    const before = text.slice(Math.max(0, match.index - 128), match.index);
    const p = prefix.exec(before);
    const leftCurrency = currency(p?.[3]);
    const rightCurrency = currency(unitMatch?.[2]);
    const monetary = leftCurrency && rightCurrency && leftCurrency !== rightCurrency ? "conflicting" : leftCurrency ?? rightCurrency;
    let total = 0, previousScale = Infinity, amount: number[] = [], ordinal = false, fold = false;
    let components = 0, fractionalComponent = false, fractionalLiteral = "", fractionalScalePower = 0;
    let invalid = tokens.length > 64 || /\s[-‐-―−]\s|[/⁄∕＋±\p{Cf}\p{M}]/u.test(raw);
    for (let i = 0; i < (tokens.length > 64 ? 0 : tokens.length); i++) {
      let item = tokens[i]!;
      if (item === "and") {
        if (i === 0 || i === tokens.length - 1 || !Object.hasOwn(scales, tokens[i - 1]!)) invalid = true;
        continue;
      }
      if (["in", "to", "half", "quarter", "quarters", "thirds", "few", "several", "many"].includes(item) || /[\/⁄∕¼½¾⅐-⅞]/u.test(item)) { invalid = true; continue; }
      if (item === "a") { components++; amount.push(1); continue; }
      if (/^(?:hundred|thousand|million|billion|dozen)fold$/.test(item)) {
        fold = true; item = item.slice(0, -4); if (i !== tokens.length - 1) invalid = true;
      } else if (/^(?:hundred|thousand|million|billion|dozen)th$/.test(item)) {
        ordinal = true; item = item.slice(0, -2); if (i !== tokens.length - 1) invalid = true;
      }
      if (Object.hasOwn(ordinals, item)) {
        ordinal = true; if (i !== tokens.length - 1) invalid = true; components++; amount.push(ordinals[item]!); continue;
      }
      const literal = /^((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?|\.[0-9]+)(?:e([+\-−]?[0-9]+))?(st|nd|rd|th)?$/i.exec(item);
      if (literal) {
        const value = Number(literal[1]!.replace(/,/g, "") + (literal[2] ? `e${literal[2].replace("−", "-")}` : ""));
        const significant = literal[1]!.replace(/[.,]/g, "").replace(/^0+/, "").replace(/0+$/, "");
        if (!Number.isFinite(value) || significant.length > 15 || (value === 0 && /[1-9]/.test(literal[1]!))) invalid = true;
        if (literal[3]) { ordinal = true; if (i !== tokens.length - 1) invalid = true; }
        components++;
        if (!Number.isInteger(value)) {
          fractionalComponent = true;
          fractionalLiteral = literal[1]!.replace(/,/g, "") + (literal[2] ? `e${literal[2].replace("−", "-")}` : "");
        }
        amount.push(value); continue;
      }
      if (Object.hasOwn(cardinal, item)) { components++; amount.push(cardinal[item]!); continue; }
      const multiplier = scales[item];
      if (!multiplier) { invalid = true; continue; }
      const base = amount.length ? group(amount) : 1;
      if (!Number.isFinite(base) || base <= 0 || multiplier >= previousScale) invalid = true;
      // Multiplying by a dozen can introduce more significant digits than
      // the input even when the result fits in a safe integer. Never round
      // such a product to a fixed precision.
      if (fractionalComponent && multiplier === 12) invalid = true;
      if (fractionalComponent && components === 1 && multiplier !== 12)
        fractionalScalePower += Math.log10(multiplier);
      const product = fractionalComponent && components === 1 && multiplier !== 12
        ? shiftDecimal(fractionalLiteral, fractionalScalePower)
        : base * multiplier;
      if (multiplier === 100) {
        if (base > 99) invalid = true;
        amount = [product];
      } else {
        total += product; amount = []; previousScale = multiplier;
      }
    }
    let value = total + group(amount);
    // A fractional literal combined with another component can be rounded
    // away when added to a much larger group. Until exact decimal arithmetic
    // is available, keep that entire quantity unmatchable instead of letting
    // a rounded total support a different claim.
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || invalid || (fractionalComponent && components > 1) || (fold && (!!unit || ordinal))) value = Infinity;
    if (p?.[1] || p?.[2] || p?.[4]) value = -value;
    const year = Number.isInteger(value) && value >= 1900 && value <= 2099 && !unit && !monetary &&
      /\b(?:in|during|since|from|to|until|through|by|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+$/i.test(before);
    result.push({ start: match.index, end, token: {
      value, percent: unit === "%" || unit === "percent" || unit === "per cent",
      multiplier: fold || /^(?:x|×|times|-?fold)$/.test(unit), ordinal, currency: monetary,
      raw: text.slice(match.index, end).trim(), qualifier: year ? null : numberQualifier(text, match.index, end), date: year, datePart: year ? "year" : null, dateKey: null,
    } });
  }
  return result;
}
