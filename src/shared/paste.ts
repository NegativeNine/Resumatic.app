import { UNSEEN, withoutHiddenControls } from "./characters";

// Text a person pastes on the Facts page, read as a source of its own kind. The browser and the
// Worker clean it the same way here, so the count the person sees is the count that is stored,
// and the Vault and Distill read the stored bytes back through the same check.
//
// Pasted text is untrusted input like an upload: it is shown as text, reaches a model only inside
// the extract prompt's data tags, and is evidence only where a quote is found in it.

/**
 * The most characters a paste may hold once cleaned: the extractor's own limit
 * (`MAX_MARKDOWN_CHARS` in src/pipeline/extract/types.ts, pinned equal by a unit test). A literal,
 * so the web bundle doesn't import the pipeline. Characters are UTF-16 code units, as
 * `String.length` counts them.
 */
export const MAX_PASTE_CHARS = 60_000;
export const MAX_PASTE_TITLE_CHARS = 120;
/** A UTF-16 code unit is at most three bytes of UTF-8. */
export const MAX_PASTE_BYTES = MAX_PASTE_CHARS * 3;
/** The whole request body, before cleaning: JSON escapes and line endings make it larger than the text. */
export const MAX_PASTE_BODY_BYTES = 512 * 1024;
export const PASTE_CONTENT_TYPE = "text/plain; charset=utf-8";
/** The name of a paste given no title. */
export const PASTE_FILENAME = "Pasted text.txt";

export interface PasteSourceRequest {
  text: string;
  title?: string | null;
}

/**
 * Pasted text as it is stored: every line ending a newline; no control character other than tab
 * and newline, no mark of direction, and nothing Unicode counts as not shown; trimmed. Whitespace
 * inside it is kept as pasted, because quotes must be found in it and its lines are read as lines.
 */
export function normalizePastedText(text: string): string {
  return withoutHiddenControls(text.replace(/\r\n|[\r\u2028\u2029]/g, "\n"))
    .replace(UNSEEN, "")
    .trim();
}

/** Half of a surrogate pair standing alone, which no UTF-8 can carry. (The web build has no `isWellFormed`.) */
export function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** A title as one line: no hidden characters, every run of space one space, trimmed. */
export function cleanPasteTitle(title: string): string {
  return withoutHiddenControls(title).replace(UNSEEN, "").replace(/\s+/g, " ").trim();
}

/**
 * The source's filename for a title: the cleaned title with one ".txt", or "Pasted text.txt" when
 * nothing is left of it. Null when the cleaned title is longer than a title may be.
 */
export function pasteFilename(title: string | null | undefined): string | null {
  const cleaned = cleanPasteTitle(title ?? "");
  if (cleaned.length > MAX_PASTE_TITLE_CHARS) return null;
  const stem = cleaned.replace(/\.txt$/i, "").trim();
  return stem ? `${stem}.txt` : PASTE_FILENAME;
}

/**
 * Stored paste bytes as text, or null unless they are exactly what a paste is stored as: valid
 * UTF-8 with no byte-order mark, already clean, and neither empty nor over the limit.
 */
export function readPastedText(bytes: ArrayBuffer): string | null {
  let text: string;
  try {
    // ignoreBOM keeps a byte-order mark in the text, where the check below refuses it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (normalizePastedText(text) !== text || text.length < 1 || text.length > MAX_PASTE_CHARS) return null;
  if (new TextEncoder().encode(text).byteLength !== bytes.byteLength) return null;
  return text;
}
