// Where the items beside a resume's page go, worked out from numbers alone, so it can be tested
// without a page. margin-layout.ts measures the page and applies it.

/** The space kept between two items in the margin, in px. */
export const NOTE_GAP = 6;

/**
 * Where each item in the margin goes: level with its line where it can be, and pushed down only as
 * far as it must be to clear the item above it.
 */
export function placeNotes(tops: readonly number[], heights: readonly number[], gap = NOTE_GAP): number[] {
  const placed: number[] = [];
  let floor = -Infinity;
  tops.forEach((top, i) => {
    const at = Math.max(top, floor);
    placed.push(at);
    floor = at + (heights[i] ?? 0) + gap;
  });
  return placed;
}

/** What marginOrder reads of a mark or the card: the line each is for. */
export interface MarginItem {
  dataset: { noteFor?: string; cardFor?: string };
}

/**
 * The order the margin is laid out in: the marks as the page lists them, with the open card as one
 * more item right after its own line's mark, so the marks below it move down to clear it. Without a
 * card, or with one whose line has no mark, the marks alone.
 */
export function marginOrder<T extends MarginItem>(marks: readonly T[], card: T | null): T[] {
  const order = [...marks];
  if (!card) return order;
  const at = order.findIndex((mark) => mark.dataset.noteFor !== undefined && mark.dataset.noteFor === card.dataset.cardFor);
  if (at === -1) return order;
  order.splice(at + 1, 0, card);
  return order;
}
