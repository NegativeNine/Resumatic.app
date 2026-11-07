import { asSentence } from "../shared/sentence";
import { ApiError } from "./api";

/** Wording by error code, for a caller that knows better than the server what went wrong here. */
export type ErrorWords = Partial<Record<string, string>>;

const FALLBACK_WORDS: ErrorWords = {
  quota: "You've reached a usage limit. Try again later.",
  conflict: "Something else is still in progress. Wait for it to finish, then try again.",
  too_large: "That's larger than Resumatic accepts.",
  not_found: "This couldn't be found. It may have been removed.",
  forbidden: "You don't have access to that.",
  unavailable: "Resumatic is busy right now. Try again in a minute.",
  not_implemented: "This part of Resumatic isn't ready yet.",
};

/**
 * A message for the person, as sentences. A caller's `words` for the error's code come first,
 * because the caller knows what was being done (the file's name, say). Then a client error (4xx)
 * with a JSON body shows the server's own message, which says what to do next, such as waiting for
 * other uploads to finish reading. Otherwise the fallbacks give plain wording by code.
 */
export function describeError(e: unknown, words: ErrorWords = {}): string {
  if (e instanceof ApiError) {
    const own = words[e.code];
    if (own) return own;
    const fromServer = e.status < 500 && !e.code.startsWith("http_") && e.message.length > 0;
    if (fromServer) return asSentence(e.message);
    const known = FALLBACK_WORDS[e.code];
    if (known) return known;
    if (e.status >= 500) return "Something went wrong in Resumatic. Try again in a moment.";
    return `Something went wrong (HTTP ${e.status}). Try again.`;
  }
  if (e instanceof TypeError) return "Resumatic couldn't be reached. Check your connection, then try again.";
  return "Something went wrong. Try again.";
}

// The codes /auth/callback can send (see src/shared/api.ts).
const SIGN_IN_WORDS: ErrorWords = {
  unauthenticated: "Sign-in didn't finish. It may have been cancelled or taken too long. Try again.",
  conflict: "Sign-in needs to start over. Try again.",
  forbidden:
    "This Google account can't sign in yet. During the beta, Resumatic needs an invitation for your email address, and the address must be verified with Google.",
  unavailable: "Sign-in isn't available right now. Try again in a few minutes.",
  access_denied: "Sign-in was cancelled. You can try again whenever you're ready.",
};

/** A readable message for the `?error=` code that the sign-in callback adds to the URL. */
export function signInErrorMessage(code: string): string {
  const known = SIGN_IN_WORDS[code];
  if (known) return known;
  // Only echo short, code-like values, so a crafted link can't put arbitrary text on the page.
  return /^[\w.-]{1,64}$/.test(code)
    ? `Sign-in didn't work (${code.replace(/[_.-]+/g, " ")}). Try again.`
    : "Sign-in didn't work. Try again.";
}
