import { SharePage } from "./pages/SharePage";
import { useCallback, useEffect, useState } from "react";
import type { Me } from "../shared/api";
import { api, ApiError } from "./api";
import { Shell } from "./components/Shell";
import { ErrorNote, Loading, PageHeader } from "./components/ui";
import { describeError, signInErrorMessage } from "./errors";
import { AccountPage } from "./pages/AccountPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { LEGAL_TITLES, LegalPage } from "./pages/LegalPage";
import { ResumePage } from "./pages/ResumePage";
import { SignedOut } from "./pages/SignedOut";
import { SourcesPage } from "./pages/SourcesPage";
import { href, useRoute, type Route } from "./router";
import {
  ACCOUNT_DELETED_NOTE,
  SessionContext,
  sessionEndNote,
} from "./session";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/components.css";
import "./styles.css";
import "./styles/app.css";

type Auth =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "signedOut"; note: string | null }
  | { status: "signedIn"; me: Me };

const signInError = takeSignInError();

export function App() {
  if (window.location.pathname === "/share") return <SharePage />;
  return <OwnerApp />;
}

function OwnerApp() {
  const [auth, setAuth] = useState<Auth>({ status: "loading" });

  const loadMe = useCallback(async () => {
    try {
      setAuth({ status: "signedIn", me: await api.me() });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401) setAuth({ status: "signedOut", note: null });
      else if (status === 410)
        setAuth({ status: "signedOut", note: ACCOUNT_DELETED_NOTE });
      else setAuth({ status: "unavailable", message: describeError(e) });
    }
  }, []);

  const endSession = useCallback(
    (note: string | null) => setAuth({ status: "signedOut", note }),
    [],
  );

  const updateMe = useCallback(
    (change: (me: Me) => Me) =>
      setAuth((current) =>
        current.status === "signedIn"
          ? { status: "signedIn", me: change(current.me) }
          : current,
      ),
    [],
  );

  const refreshMe = useCallback(async () => {
    try {
      const me = await api.me();
      updateMe(() => me);
    } catch (e) {
      const note = sessionEndNote(e);
      if (note) endSession(note);
    }
  }, [updateMe, endSession]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  switch (auth.status) {
    case "loading":
      return (
        <main className="splash">
          <Loading>Loading Resumatic…</Loading>
        </main>
      );
    case "unavailable":
      return (
        <main className="splash">
          <div className="welcome">
            <h1>Resumatic</h1>
            <ErrorNote
              message={`We couldn't load your account. ${auth.message}`}
              onRetry={loadMe}
            />
          </div>
        </main>
      );
    case "signedOut":
      return (
        <SignedOutApp
          note={auth.note}
          error={
            auth.note === null && signInError !== null
              ? signInErrorMessage(signInError)
              : null
          }
        />
      );
    case "signedIn":
      return (
        <SessionContext
          value={{ me: auth.me, updateMe, refreshMe, endSession }}
        >
          <SignedInApp />
        </SessionContext>
      );
  }
}

const TITLES: Record<Route["page"], string> = {
  facts: "Facts",
  jobs: "Jobs",
  resume: "Tailored resume",
  account: "Account",
  privacy: LEGAL_TITLES.privacy,
  terms: LEGAL_TITLES.terms,
  notFound: "Page not found",
};

/** Signed out, the privacy notice and terms are still readable; everything else is the sign-in page. */
function SignedOutApp({
  note,
  error,
}: {
  note: string | null;
  error: string | null;
}) {
  const route = useRoute();
  if (route.page === "privacy" || route.page === "terms") {
    return (
      <main className="page legal-page" id="main">
        <p>
          <a href="#/">← Back to sign in</a>
        </p>
        <LegalPage doc={route.page} />
      </main>
    );
  }
  return <SignedOut note={note} error={error} />;
}

function SignedInApp() {
  const route = useRoute();
  return (
    <Shell route={route} title={TITLES[route.page]}>
      <Page route={route} />
    </Shell>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "facts":
      return <SourcesPage />;
    case "jobs":
      return <ApplicationsPage />;
    case "resume":
      return <ResumePage key={route.id} id={route.id} />;
    case "account":
      return <AccountPage />;
    case "privacy":
    case "terms":
      return <LegalPage doc={route.page} />;
    case "notFound":
      return (
        <PageHeader title="Page not found">
          There's nothing at this address. Go to <a href={href.facts}>Facts</a> or{" "}
          <a href={href.jobs}>Jobs</a>.
        </PageHeader>
      );
  }
}

/** Reads the sign-in callback's `?error=` code once, and removes it from the address bar. */
function takeSignInError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("error");
  if (code === null) return null;
  url.searchParams.delete("error");
  window.history.replaceState(window.history.state, "", url);
  return code;
}
