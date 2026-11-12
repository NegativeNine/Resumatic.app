import { useSyncExternalStore } from "react";

// What a signed-out visitor sees at each address. The signed-in app's routes are not used here:
// they rewrite an empty address to where signing in lands, and every one of them is a page that
// needs an account. The address is read as it is and never rewritten, so a deep link still names
// its page once the visitor has signed in.

/** The sign-in page's own address. Signed in, it is an alias of where signing in lands. */
export const SIGN_IN_HASH = "#/sign-in";

export type SignedOutPage = "landing" | "sign-in" | "privacy" | "terms";

/**
 * The page for a raw address, before anything rewrites it. The privacy notice and the terms are
 * readable signed out. The site's root is the landing page, unless there is something to tell the
 * visitor (a note after signing out, or why sign-in was refused), which the sign-in page says.
 * Everything else, `#/sign-in` and every deep link, is the sign-in page.
 */
export function signedOutPage(rawHash: string, hasMessage: boolean): SignedOutPage {
  const parts = rawHash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts.length === 0) return hasMessage ? "sign-in" : "landing";
  if (parts.length === 1 && (parts[0] === "privacy" || parts[0] === "terms")) return parts[0];
  return "sign-in";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const rawHash = () => window.location.hash;

/** The signed-out page for the address as it is now, following it as it changes. */
export function useSignedOutPage(hasMessage: boolean): SignedOutPage {
  return signedOutPage(useSyncExternalStore(subscribe, rawHash), hasMessage);
}
