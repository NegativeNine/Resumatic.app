/** Preserve source precision: no month is invented for a year-only or seasonal date. */
export function sourceDate(text: string | null): string | null {
  if (!text || /\b(present|current|now|heute|actualidad)\b/i.test(text))
    return null;
  const year = text.match(/\b(?:19|20)\d{2}\b/)?.[0];
  if (!year) return null;
  const numeric = text.match(
    /\b((?:19|20)\d{2})[-/.](0?[1-9]|1[0-2])(?:\b|[-/.])/,
  );
  if (numeric) return `${numeric[1]}-${numeric[2]!.padStart(2, "0")}`;
  const names = [
    "jan(?:uary|uar|vier)?|enero",
    "feb(?:ruary|ruar)?|febrero",
    "mar(?:ch|zo)?|märz",
    "apr(?:il)?|abril",
    "may|mai|mayo",
    "jun(?:e|i|io)?",
    "jul(?:y|i|io)?",
    "aug(?:ust)?|agosto",
    "sep(?:tember|tiembre)?",
    "oct(?:ober|ubre)?|okt(?:ober)?",
    "nov(?:ember|iembre)?",
    "dec(?:ember)?|dez(?:ember)?|diciembre",
  ];
  const month = names.findIndex((name) =>
    new RegExp(`\\b(?:${name})\\.?\\b`, "i").test(text),
  );
  return month < 0 ? year : `${year}-${String(month + 1).padStart(2, "0")}`;
}
