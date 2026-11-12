import { useSyncExternalStore } from "react";

/** Where a line's card stops sitting beside the page and becomes a sheet from the bottom. */
export const SHEET_QUERY = "(max-width: 860px)";

/** Whether a media query matches now, kept in step as the window changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = window.matchMedia(query);
      list.addEventListener?.("change", changed);
      return () => list.removeEventListener?.("change", changed);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
