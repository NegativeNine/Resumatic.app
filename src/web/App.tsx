import { SharePage } from "./pages/SharePage";
import { useCallback, useEffect, useState } from "react";
import type { Me } from "../shared/api";
import { api, ApiError } from "./api";
import { Shell } from "./components/Shell";
import { ErrorNote, Loading } from "./components/ui";
import { describeError, signInErrorMessage } from "./errors";
import { LegalPage } from "./pages/LegalPage";
import { SignedOut, SignInFrame } from "./pages/SignedOut";
import { useRoute } from "./router";
import { SCREENS, shownRoute } from "./screens";
import {
  ACCOUNT_DELETED_NOTE,
  SessionContext,
  sessionEndNote,
  useSession,
} from "./session";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/type.css";
import "./styles/components.css";
import "./styles/controls.css";
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
        <SignInFrame>
          <Loading>Loading Resumatic…</Loading>
        </SignInFrame>
      );
    case "unavailable":
      return (
        <SignInFrame>
          <h1>Resumatic couldn’t load your account.</h1>
          <ErrorNote message={auth.message} onRetry={loadMe} />
        </SignInFrame>
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

/** Signed out, the privacy notice and terms are still readable; everything else is the sign-in page. */
function SignedOutApp({
  note,
  error,
}: {
  note: string | null;
  error: string | null;
}) {
  const route = useRoute();
  if (route.name === "privacy" || route.name === "terms") {
    return (
      <main className="page legal-page" id="main">
        <p>
          <a href="#/">← Back to sign in</a>
        </p>
        <LegalPage doc={route.name} />
      </main>
    );
  }
  return <SignedOut note={note} error={error} />;
}

function SignedInApp() {
  const { me } = useSession();
  const route = shownRoute(useRoute(), me);
  const screen = SCREENS[route.name];
  return (
    <Shell route={route} title={screen.title}>
      {screen.render(route)}
    </Shell>
  );
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
