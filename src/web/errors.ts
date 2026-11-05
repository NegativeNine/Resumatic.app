import { ApiError } from "./api";

/** Wording by error code, used only when the server sends no message of its own. */
export type ErrorWords = Partial<Record<string, string>>;

const FALLBACK_WORDS: ErrorWords = {
  quota: "You've reached a usage limit. Please try again later.",
  conflict: "Something else is still in progress. Wait for it to finish, then try again.",
  too_large: "That's larger than Resumatic accepts.",
  not_found: "We couldn't find that. It may have been removed.",
  forbidden: "You don't have access to that.",
  unavailable: "Resumatic is busy right now. Please try again in a minute.",
  not_implemented: "This part of Resumatic isn't ready yet.",
};

/**
 * A message for the user. A client error (4xx) with a JSON body shows the server's own message,
 * which says what to do next, such as waiting for other uploads to finish reading. Otherwise
 * `words`, then the fallbacks, give plain wording by code.
 */
export function describeError(e: unknown, words: ErrorWords = {}): string {
  if (e instanceof ApiError) {
    const fromServer = e.status < 500 && !e.code.startsWith("http_") && e.message.length > 0;
    if (fromServer) return e.message;
    const known = words[e.code] ?? FALLBACK_WORDS[e.code];
    if (known) return known;
    if (e.status >= 500) return "Something went wrong on our side. Please try again in a moment.";
    return `Something went wrong (HTTP ${e.status}). Please try again.`;
  }
  if (e instanceof TypeError) return "We couldn't reach Resumatic. Check your connection, then try again.";
  return "Something went wrong. Please try again.";
}

// The codes /auth/callback can send (see src/shared/api.ts).
const SIGN_IN_WORDS: ErrorWords = {
  unauthenticated: "Sign-in didn't finish. It may have been cancelled or taken too long. Please try again.",
  forbidden:
    "This Google account can't sign in yet. During the beta, Resumatic needs an invitation for your email address, and the address must be verified with Google.",
  unavailable: "Sign-in isn't available right now. Please try again in a few minutes.",
  access_denied: "Sign-in was cancelled. You can try again whenever you're ready.",
};

/** A readable message for the `?error=` code that the sign-in callback adds to the URL. */
export function signInErrorMessage(code: string): string {
  const known = SIGN_IN_WORDS[code];
  if (known) return known;
  // Only echo short, code-like values, so a crafted link can't put arbitrary text on the page.
  return /^[\w.-]{1,64}$/.test(code)
    ? `Sign-in didn't work (${code.replace(/[_.-]+/g, " ")}). Please try again.`
    : "Sign-in didn't work. Please try again.";
}
