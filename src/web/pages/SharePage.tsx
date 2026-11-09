import { useEffect, useState } from "react";
import { ShareFrame, ShareSnapshotContent } from "../components/ShareSnapshotContent";
import { Loading } from "../components/ui";
import "../components/share.css";
import type { SharedView } from "../../shared/sharing";

// Capture once before React effects/router/telemetry, then remove the bearer from browser history.
let initialToken: string | null = null;
if (typeof window !== "undefined" && window.location.pathname === "/share") {
  initialToken = window.location.hash.slice(1) || null;
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname,
  );
}
class ShareUnavailable extends Error {}

function checkResponse(response: Response): void {
  if (response.ok) return;
  // A temporary failure should be retryable without exposing the bearer in
  // the URL again. Invalid or expired links get the unavailable message.
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)
    throw new ShareUnavailable();
  throw new Error("Share temporarily unavailable");
}

let exchange: Promise<void> | null = null;
function exchangeLink(): Promise<void> {
  if (exchange) return exchange;
  if (!initialToken) return Promise.resolve();
  const token = initialToken;
  exchange = (async () => {
    const response = await fetch("/share/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    try {
      checkResponse(response);
    } catch (error) {
      if (error instanceof ShareUnavailable) initialToken = null;
      throw error;
    }
    initialToken = null;
  })().finally(() => { exchange = null; });
  return exchange;
}

export function SharePage() {
  const [view, setView] = useState<SharedView | null>(null);
  const [failed, setFailed] = useState<"unavailable" | "temporary" | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await exchangeLink();
        const response = await fetch("/share/snapshot", {
          credentials: "same-origin",
          cache: "no-store",
        });
        checkResponse(response);
        const data = (await response.json()) as SharedView;
        if (active) setView(data);
      } catch (error) {
        if (active) setFailed(error instanceof ShareUnavailable ? "unavailable" : "temporary");
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);
  if (failed === "unavailable")
    return (
      <ShareFrame>
        <div className="app-share__card">
          <h1>Share unavailable</h1>
          <p>This link has expired or been revoked. Ask the person who sent it for a new one.</p>
        </div>
      </ShareFrame>
    );
  if (failed === "temporary")
    return (
      <ShareFrame>
        <div className="app-share__card">
          <h1>This copy couldn't be opened</h1>
          <p>Check your connection, then try again.</p>
          <button type="button" className="rs-btn rs-btn--primary" onClick={() => { setFailed(null); setAttempt((value) => value + 1); }}>
            Try again
          </button>
        </div>
      </ShareFrame>
    );
  if (!view)
    return (
      <ShareFrame>
        <Loading>Opening the shared copy…</Loading>
      </ShareFrame>
    );
  return <ShareSnapshotContent view={view} />;
}
