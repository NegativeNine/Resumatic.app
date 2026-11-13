import { useEffect, type ReactNode } from "react";
import { api } from "../api";
import { feedbackHref } from "../config";
import { Lockup } from "../components/Lockup";
import { Message, Stopped } from "../components/ui";
import { href } from "../router";
import "../styles/rooms/outside.css";

/** The SignInCard frame: the lockup over a white card on the desk, with the about links below. */
export function SignInFrame({ children }: { children: ReactNode }) {
  return (
    <main className="app-signin-page" id="main" tabIndex={-1}>
      <div className="rs-signin">
        <span className="rs-signin__brand">
          <Lockup />
        </span>
        {children}
      </div>
      <nav className="app-signin-links" aria-label="About Resumatic">
        <a href={href.privacy}>Privacy</a>
        <a href={href.terms}>Terms</a>
        <a href={feedbackHref}>Send feedback</a>
      </nav>
    </main>
  );
}

/**
 * Sign-in: the result first, then how, and one button. At most one message sits above the button:
 * a `note` says why the visitor is here (they signed out, or their session ended), and an `error`
 * is a sign-in that was refused, in the fixed words for its code. A note comes first.
 */
export function SignedOut({ note, error }: { note: string | null; error: string | null }) {
  useEffect(() => {
    document.title = "Sign in – Resumatic";
  }, []);

  return (
    <SignInFrame>
      <h1>A tailored resume you can stand behind.</h1>
      <p className="rs-lede">
        Resumatic writes a resume for each job using only what you’ve really done, and shows where every line came from.
      </p>
      {note !== null ? <Message tone="info">{note}</Message> : error !== null ? <Stopped>{error}</Stopped> : null}
      <a className="rs-btn rs-btn--primary rs-btn--lg" href={api.loginUrl}>
        <span className="rs-google" aria-hidden="true" />
        Sign in with Google
      </a>
      <p className="rs-signin__fine">
        Private beta, by invitation. You can download or delete your data at any time. By signing in you agree to the{" "}
        <a href={href.terms}>beta terms</a>. The <a href={href.privacy}>privacy notice</a> explains how your data is used.
      </p>
    </SignInFrame>
  );
}
