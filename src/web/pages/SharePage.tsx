import { useEffect, useState } from "react";
import { ShareFrame, ShareSnapshotContent } from "../components/ShareSnapshotContent";
import { Loading, Message } from "../components/ui";
import "../components/share.css";
import type { SharedView } from "../../shared/sharing";

// Capture once before React effects/router/telemetry, then remove the bearer from browser history.
let initialToken: string | null = null;
/**
 * Which of the reader's copies this page shows, kept in the address as ?g= so a reload opens the
 * same one when two are open. It isn't a secret: the copy's own cookie is what opens it.
 */
let grantId: string | null = null;
function showAddress(): void {
  window.history.replaceState(
    window.history.state,
    "",
    grantId ? `/share?g=${encodeURIComponent(grantId)}` : "/share",
  );
}
if (typeof window !== "undefined" && window.location.pathname === "/share") {
  initialToken = window.location.hash.slice(1) || null;
  grantId = new URLSearchParams(window.location.search).get("g") || null;
  showAddress();
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
    // The reply names the copy. An empty reply is from a server that keeps one copy per browser:
    // the copy then opens without ?g=, as it always did.
    const opened = response.status === 204 ? null : ((await response.json().catch(() => null)) as { grantId?: unknown } | null);
    grantId = typeof opened?.grantId === "string" && opened.grantId ? opened.grantId : null;
    showAddress();
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
        const response = await fetch(grantId ? `/share/snapshot?g=${encodeURIComponent(grantId)}` : "/share/snapshot", {
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
  // A reader with several copies open tells the tabs apart by whose copy each is.
  const owner = view?.snapshot.owner?.name;
  useEffect(() => {
    if (view) document.title = `${owner ? `${owner}, shared copy` : "Shared copy"} – Resumatic`;
  }, [view, owner]);
  if (failed === "unavailable")
    return (
      <ShareFrame>
        <div className="app-share__card">
          <h1>Share unavailable</h1>
          <p>
            If you had this copy open before, open the link from your message again. A copy stays open for an hour
            at a time. If the link doesn’t work either, it has expired or been revoked, and the person who sent it
            can make a new one.
          </p>
        </div>
      </ShareFrame>
    );
  if (failed === "temporary")
    return (
      <ShareFrame>
        <div className="app-share__card">
          <h1>This copy couldn’t be opened</h1>
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
  return (
    <ShareSnapshotContent
      view={view}
      notice={view.reviewer && <CoachNotice view={view} onChanged={() => setAttempt((value) => value + 1)} />}
    />
  );
}

/**
 * What a copy that names a coach says to whoever is reading it. Only the account that signs in
 * with the named address can keep the copy in its client list. Everyone else just reads.
 */
function CoachNotice({ view, onChanged }: { view: SharedView; onChanged: () => void }) {
  const [state, setState] = useState<"idle" | "adding" | "failed" | "refused">("idle");
  const owner = view.snapshot.owner?.name ?? "The owner of this copy";
  async function add() {
    setState("adding");
    try {
      const response = await fetch("/api/coach/clients", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grantId: view.grantId }),
      });
      if (response.status === 204) return onChanged();
      // Refused for good, or for now: the reader can't fix the first by trying again.
      setState(response.status === 401 || response.status === 403 || response.status === 409 || response.status === 410 ? "refused" : "failed");
    } catch {
      setState("failed");
    }
  }
  switch (view.reviewer) {
    case "joined":
      return (
        <Message tone="success">
          This copy is in your client list.{" "}
          <a className="rs-link" href="/#/clients">
            Open your clients
          </a>
        </Message>
      );
    case "you":
      return (
        <Message tone="info" live={false}>
          <p>
            {owner} named you as their coach. Add this copy to your client list to open it later without the link.
            They’ll see that you added it, and the name on your account.
          </p>
          <p>
            <button type="button" className="rs-btn rs-btn--primary rs-btn--sm" disabled={state === "adding"} onClick={() => void add()}>
              {state === "adding" ? "Adding…" : "Add to my clients"}
            </button>
          </p>
          {state === "failed" && <p role="alert">That didn’t go through. Check your connection, then try again.</p>}
          {state === "refused" && <p role="alert">This copy couldn’t be added. Reload the page and try again.</p>}
        </Message>
      );
    case "other":
      return (
        <Message tone="info" live={false}>
          This copy names a different sign-in address as its coach. You can still read it.
        </Message>
      );
    case "sign-in-again":
      return (
        <Message tone="info" live={false}>
          This copy names a coach. If that’s you, sign out of Resumatic and in again, then reload this page.
        </Message>
      );
    case "sign-in":
      return (
        <Message tone="info" live={false}>
          This copy names a coach. If that’s you,{" "}
          <a className="rs-link" href="/" target="_blank" rel="noopener">
            sign in to Resumatic
          </a>{" "}
          with that address, then reload this page to keep the copy in your client list.
        </Message>
      );
    default:
      return null;
  }
}

