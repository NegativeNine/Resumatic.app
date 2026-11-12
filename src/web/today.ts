import { createContext, useContext } from "react";
import type { Today } from "../shared/today";

// Today as the shell last loaded it, for the header's counts and for any page that shows what
// waits. Pages read it here rather than asking the API again.

export interface TodayState {
  /** Undefined until it has loaded, and after any failure: then nothing is counted from it. */
  today: Today | undefined;
  /** Reads Today again. */
  reload: () => Promise<unknown>;
}

const NOTHING: TodayState = { today: undefined, reload: async () => undefined };

export const TodayContext = createContext<TodayState>(NOTHING);

export function useToday(): TodayState {
  return useContext(TodayContext);
}
