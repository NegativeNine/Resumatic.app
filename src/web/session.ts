import { createContext, useContext } from "react";
import type { Me } from "../shared/api";
import { ApiError } from "./api";

export interface Session {
  me: Me;
  updateMe: (change: (me: Me) => Me) => void;
  refreshMe: () => Promise<void>;
  /** Shows the signed-out screen, with an optional note saying why. */
  endSession: (note: string | null) => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside a signed-in SessionContext");
  return session;
}

export const ACCOUNT_DELETED_NOTE = "This account has been deleted.";

/** The note for the signed-out screen when an error means the session is over, otherwise null. */
export function sessionEndNote(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401) return "Your session has ended. Sign in again to carry on.";
  // The Worker answers 410 once a user's vault has been destroyed.
  if (e.status === 410) return ACCOUNT_DELETED_NOTE;
  return null;
}
