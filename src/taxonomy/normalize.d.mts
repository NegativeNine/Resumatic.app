/** One word of a text: where it sits in the original, and the form it is compared in. */
export interface Word {
  start: number;
  end: number;
  norm: string;
}
/** The words of a text, in order, each with its [start, end) offsets in the text as given. */
export function words(text: string): Word[];
/** A label as it is stored and matched: its words in comparison form, joined by single spaces. */
export function normalizeLabel(text: string): string;
/** A stretch of text as a person sees it: without the characters nobody sees, and otherwise as written. */
export function asSeen(text: string): string;
/** Every run of one to `maxWords` consecutive words, as [first word index, word count, norm]. */
export function wordRuns(list: readonly Word[], maxWords?: number, maxChars?: number): [number, number, string][];
