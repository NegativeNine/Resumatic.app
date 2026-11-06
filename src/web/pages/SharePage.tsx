import { useEffect, useState } from "react";
import { ShareSnapshotContent } from "../components/ShareSnapshotContent";
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
let exchange: Promise<void> | null = null;
function exchangeLink(): Promise<void> {
  if (exchange) return exchange;
  if (!initialToken) return Promise.resolve();
  if (!exchange) {
    const token = initialToken;
    initialToken = null;
    exchange = fetch("/share/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).then((r) => {
      if (!r.ok) throw new Error("Share unavailable");
    });
  }
  return exchange;
}

export function SharePage() {
  const [view, setView] = useState<SharedView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await exchangeLink();
        const response = await fetch("/share/snapshot", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Share unavailable");
        const data = (await response.json()) as SharedView;
        if (active) setView(data);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  if (failed)
    return (
      <main className="page">
        <h1>Share unavailable</h1>
        <p>
          This link has expired or been revoked. Ask the owner for a new link.
        </p>
      </main>
    );
  if (!view)
    return (
      <main className="page">
        <p role="status">Opening shared snapshot…</p>
      </main>
    );
  return <ShareSnapshotContent view={view} />;
}
