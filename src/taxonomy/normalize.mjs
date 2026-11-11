// How a label and a stretch of text are compared. The taxonomy builder (Node) and the Worker both
// import this file, so a label is stored in exactly the form a line of text is looked up in.
//
// A word keeps what makes a tool's name its own ("c++", "c#", ".net", "node.js", "r&d") and drops
// what is only typography: case, accents, and the punctuation around it. A hyphen or a slash
// separates words, on both sides alike, so "T-SQL", "t sql" and "CI/CD" meet their labels.
//
// A word does not end at a combining mark or at a character nobody sees. Some text writes an
// accented letter as the letter and then a mark (U+0065 U+0301 where other text has U+00E9), and
// some carries soft hyphens or zero-width characters inside a word. Ended there, a word written
// with its accents would stop at the first of them ("re", then "sume"), and a label would be found
// in the first half of a word that isn't it.

/**
 * One word of a text: where it sits in the original, and the form it is compared in. After its
 * first letter or digit a run also takes marks (M) and format characters (Cf: the soft hyphen, the
 * zero-width space and joiners, direction marks), which fold() then drops.
 */
const WORD = /\.?[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Cf}]*[+#]*(?:[.&'][\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Cf}]*[+#]*)*/gu;

/** Curly apostrophes read as straight ones. The replacement keeps the length, so offsets hold. */
const APOSTROPHES = /[\u2018\u2019\u02BC]/g;

/** The characters nobody sees: the format characters a word is read through. */
const UNSEEN = /\p{Cf}+/gu;

/** What a word can carry that its comparison form leaves out: marks, and the characters nobody sees. */
const DROPPED = /[\p{M}\p{Cf}]+/gu;

/**
 * The comparison form of one word. Marks and unseen characters are dropped after the word is
 * decomposed, because decomposing is what parts an accent from its letter, and before it as well.
 * Decomposing also puts every run of marks in canonical order, in time that grows with the square
 * of the run, and a word of someone else's text can carry any number of marks. Dropped first,
 * they are never put in order, and no word's form changes: a mark or an unseen character
 * decomposes into nothing but marks and unseen characters, and ordering moves only marks.
 */
function fold(word) {
  return word
    .replace(DROPPED, "")
    .normalize("NFKD")
    .replace(DROPPED, "")
    .toLowerCase();
}

/**
 * A stretch of text as a person sees it: without the characters nobody sees. Everything else stays
 * as it is written, capitals, accents and punctuation included, so this is not a comparison form.
 */
export function asSeen(text) {
  return text.replace(UNSEEN, "");
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
