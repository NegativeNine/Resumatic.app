import { useEffect, type ReactNode } from "react";
import { api } from "../api";
import { feedbackHref } from "../config";
import { Lockup } from "../components/Lockup";
import { Glyph } from "../components/ui";
import { href } from "../router";

/** The SignInCard frame: the lockup over a white card on the desk, with the about links below. */
export function SignInFrame({ children }: { children: ReactNode }) {
  return (
    <main className="app-signin-page" id="main">
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

export function SignedOut({ note, error }: { note: string | null; error: string | null }) {
  useEffect(() => {
    document.title = "Resumatic";
  }, []);

  return (
    <SignInFrame>
      <h1>Tailored resumes, built only from what you've done.</h1>
      <p className="rs-lede">
        Resumatic turns your resumes and CVs into facts, each backed by the exact words it came from. Then it tailors a
        resume to every job you apply for, using only the facts you've confirmed.
      </p>
      {note && (
        <p className="rs-msg rs-msg--info" role="status">
          <Glyph name="info" />
          <span className="rs-msg__text">{note}</span>
        </p>
      )}
      {error && (
        <p className="rs-msg rs-msg--error" role="alert">
          <Glyph name="alert" />
          <span className="rs-msg__text">{error}</span>
        </p>
      )}
      <a className="rs-btn rs-btn--primary rs-btn--lg" href={api.loginUrl}>
        <span className="rs-google" aria-hidden="true" />
        Sign in with Google
      </a>
      <p className="rs-signin__fine">
        Private beta, by invitation. You can download or delete your data at any time. By signing in you agree to the{" "}
        <a href={href.terms}>beta terms</a>; the <a href={href.privacy}>privacy notice</a> explains how your data is
        used.
      </p>
    </SignInFrame>
  );
}
