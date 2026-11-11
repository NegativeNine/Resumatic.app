// How a label and a stretch of text are compared. The taxonomy builder (Node) and the Worker both
// import this file, so a label is stored in exactly the form a line of text is looked up in.
//
// A word keeps what makes a tool's name its own ("c++", "c#", ".net", "node.js", "r&d") and drops
// what is only typography: case, accents, and the punctuation around it. A hyphen or a slash
// separates words, on both sides alike, so "T-SQL", "t sql" and "CI/CD" meet their labels.

/** One word of a text: where it sits in the original, and the form it is compared in. */
const WORD = /\.?[\p{L}\p{N}]+[+#]*(?:[.&'][\p{L}\p{N}]+[+#]*)*/gu;

/** Curly apostrophes read as straight ones. The replacement keeps the length, so offsets hold. */
const APOSTROPHES = /[\u2018\u2019\u02BC]/g;

function fold(word) {
  return word
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * The words of a text, in order, each with its [start, end) offsets in the text as given.
 * A leading dot belongs to a word only at the start of one (".NET"), never after another word.
 */
export function words(text) {
  if (typeof text !== "string") return [];
  const source = text.replace(APOSTROPHES, "'");
  const found = [];
  for (const match of source.matchAll(WORD)) {
    let start = match.index;
    let raw = match[0];
    if (raw.startsWith(".") && start > 0 && /[\p{L}\p{N}+#]/u.test(source[start - 1])) {
      start += 1;
      raw = raw.slice(1);
    }
    const norm = fold(raw);
    if (norm) found.push({ start, end: start + raw.length, norm });
  }
  return found;
}

/** A label as it is stored and matched: its words in comparison form, joined by single spaces. */
export function normalizeLabel(text) {
  return words(text)
    .map((word) => word.norm)
    .join(" ");
}

/**
 * Every run of one to `maxWords` consecutive words, as [first word index, word count, norm].
 * Runs longer than `maxChars` are left out: no label is that long.
 */
export function wordRuns(list, maxWords = 6, maxChars = 120) {
  const runs = [];
  for (let first = 0; first < list.length; first++) {
    let norm = "";
    for (let count = 1; count <= maxWords && first + count <= list.length; count++) {
      norm = count === 1 ? list[first].norm : `${norm} ${list[first + count - 1].norm}`;
      if (norm.length > maxChars) break;
      runs.push([first, count, norm]);
    }
  }
  return runs;
}
