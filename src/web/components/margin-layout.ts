import { useLayoutEffect, type RefObject } from "react";

/** The space kept between two notes in the margin, in px. */
export const NOTE_GAP = 6;

/**
 * Where each margin note goes: level with its line where it can be, and pushed down only as far
 * as it must be to clear the note above it.
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

/**
 * Keeps the notes in `page` level with their lines on the sheet. Lines carry data-line-id and
 * notes data-note-for, inside an .app-notes stack. One open note floats over the notes below it,
 * so they stay level; when more are open, they stack. Positions are set through the CSSOM, which
 * the CSP allows. When the margin is static (narrow screens), the notes flow as a list instead.
 */
export function useMarginLayout(page: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = page.current;
    const stack = root?.querySelector<HTMLElement>(".app-notes");
    if (!root || !stack) return;

    const layout = () => {
      const notes = [...stack.querySelectorAll<HTMLElement>("[data-note-for]")];
      if (getComputedStyle(stack).position === "static") {
        for (const note of notes) note.style.top = "";
        stack.style.minHeight = "";
        return;
      }
      const base = stack.getBoundingClientRect().top;
      const open = notes.filter((n) => n.classList.contains("is-open"));
      const floating = open.length === 1 ? open[0] : null;
      const tops = notes.map((note) => {
        const line = root.querySelector<HTMLElement>(`[data-line-id="${note.dataset.noteFor}"]`);
        return line ? line.getBoundingClientRect().top - base : 0;
      });
      const heights = notes.map((note) =>
        note === floating ? (note.querySelector<HTMLElement>(".rs-note__head")?.offsetHeight ?? note.offsetHeight) : note.offsetHeight,
      );
      const placed = placeNotes(tops, heights);
      notes.forEach((note, i) => {
        const top = `${Math.round(placed[i] ?? 0)}px`;
        if (note.style.top !== top) note.style.top = top;
      });
      const bottom = Math.max(0, ...notes.map((note, i) => (placed[i] ?? 0) + note.offsetHeight));
      const minHeight = `${Math.ceil(bottom)}px`;
      if (stack.style.minHeight !== minHeight) stack.style.minHeight = minHeight;
    };

    layout();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(layout) : null;
    observer?.observe(root);
    void document.fonts?.ready.then(layout);
    return () => observer?.disconnect();
  });
}
