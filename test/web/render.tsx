import { render, type RenderResult } from "@testing-library/react";
import { useCallback, useState, type ReactNode } from "react";
import type { Me } from "../../src/shared/api";
import { SessionContext } from "../../src/web/session";

export interface SessionSpy {
  /** The notes passed to endSession, in order. */
  ended: (string | null)[];
}

/** Renders UI inside a signed-in session for `me`, as App does once /api/me answers. */
export function renderWithSession(ui: ReactNode, me: Me): RenderResult & SessionSpy {
  const ended: (string | null)[] = [];
  function Session({ children }: { children: ReactNode }) {
    const [current, setCurrent] = useState(me);
    const updateMe = useCallback((change: (m: Me) => Me) => setCurrent((m) => change(m)), []);
    const refreshMe = useCallback(async () => {}, []);
    const endSession = useCallback((note: string | null) => void ended.push(note), []);
    return <SessionContext value={{ me: current, updateMe, refreshMe, endSession }}>{children}</SessionContext>;
  }
  return { ...render(<Session>{ui}</Session>), ended };
}

/** Points the app's hash router at a route, as following a link would. */
export function goTo(hash: string): void {
  window.history.replaceState(null, "", hash.startsWith("#") ? `/${hash}` : hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
