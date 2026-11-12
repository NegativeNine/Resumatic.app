import { useLayoutEffect, type RefObject } from "react";
import { marginOrder, placeNotes } from "./margin-order";

export { marginOrder, NOTE_GAP, placeNotes, type MarginItem } from "./margin-order";

/**
 * Keeps the margin's marks level with their lines on the sheet. Lines carry data-line-id; the marks
 * carry data-note-for and sit in `stack`, in page order; the open card is `card` inside the stack,
 * and carries data-card-for. The card is placed as one more item after its line's mark, level with
 * its line, so nothing overlaps and no mark hides under it. A card shown as a sheet from the bottom
 * (position: fixed) is left where its stylesheet puts it. Positions are set through the CSSOM, which
 * the CSP allows. When the stack is static (narrow screens), everything flows as a list instead.
 */
export function useMarginLayout(page: RefObject<HTMLElement | null>, { stack: stackSelector, card: cardSelector }: { stack: string; card: string }): void {
  useLayoutEffect(() => {
    const root = page.current;
    const stack = root?.querySelector<HTMLElement>(stackSelector);
    if (!root || !stack) return;

    const layout = () => {
      const marks = [...stack.querySelectorAll<HTMLElement>("[data-note-for]")];
      const found = stack.querySelector<HTMLElement>(cardSelector);
      const card = found && getComputedStyle(found).position !== "fixed" ? found : null;
      const items = [...marks, ...(found ? [found] : [])];
      // A sheet from the bottom keeps no top from when it sat in the margin.
      if (found && !card && found.style.top) found.style.top = "";
      if (getComputedStyle(stack).position === "static") {
        for (const item of items) item.style.top = "";
        stack.style.minHeight = "";
        return;
      }
      const order = marginOrder(marks, card);
      const base = stack.getBoundingClientRect().top;
      const lineTop = (id: string | undefined) => {
        const line = id === undefined ? null : root.querySelector<HTMLElement>(`[data-line-id="${id}"]`);
        return line ? line.getBoundingClientRect().top - base : 0;
      };
      const tops = order.map((item) => lineTop(item === card ? item.dataset.cardFor : item.dataset.noteFor));
      const heights = order.map((item) => item.offsetHeight);
      const placed = placeNotes(tops, heights);
      order.forEach((item, i) => {
        const top = `${Math.round(placed[i] ?? 0)}px`;
        if (item.style.top !== top) item.style.top = top;
      });
      const bottom = Math.max(0, ...order.map((item, i) => (placed[i] ?? 0) + item.offsetHeight));
      const minHeight = `${Math.ceil(bottom)}px`;
      if (stack.style.minHeight !== minHeight) stack.style.minHeight = minHeight;
    };

    layout();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(layout) : null;
    observer?.observe(root);
    // The card grows and shrinks as its editor opens, and the marks below it must follow.
    const card = stack.querySelector<HTMLElement>(cardSelector);
    if (card) observer?.observe(card);
    void document.fonts?.ready.then(layout);
    return () => observer?.disconnect();
  });
}
