import { createContext, useContext } from "react";
import type { Today } from "../shared/today";

// Today as the shell last loaded it, for the header's counts and for any page that shows what
// waits. Pages read it here rather than asking the API again.

export interface TodayState {
  /**
   * The last Today that loaded, kept through a later failure as the Today page keeps it, so every
   * count agrees with it. Undefined until one has loaded: then nothing is counted from it.
   */
  today: Today | undefined;
  /** The last Today that loaded, kept through a failure, for a page that keeps showing it. */
  last: Today | undefined;
  /** Why the latest read failed, as a sentence to show; null once one succeeds. */
  error: string | null;
  /** Reads Today again. */
  reload: () => Promise<unknown>;
}

const NOTHING: TodayState = { today: undefined, last: undefined, error: null, reload: async () => undefined };

export const TodayContext = createContext<TodayState>(NOTHING);

export function useToday(): TodayState {
  return useContext(TodayContext);
}
