import { useEffect, useState } from "react";
import type { SharedLine, SharedView } from "../../shared/sharing";

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
  const line = (value: SharedLine) => (
    <li key={value.id}>
      {value.text}
      {value.verification !== "verified" && (
        <small>
          {" "}
          ·{" "}
          {value.verification === "user-authored"
            ? "User-authored"
            : "Unverified"}
        </small>
      )}
    </li>
  );
  return (
    <main className="page">
      <h1>Shared career snapshot</h1>
      <p>
        Selected by the owner on{" "}
        {new Date(view.snapshot.createdAt).toLocaleDateString()}. Available
        until {new Date(view.expiresAt).toLocaleDateString()}.
      </p>
      {view.snapshot.facts.length > 0 && (
        <section>
          <h2>Confirmed facts</h2>
          <ul>
            {view.snapshot.facts.map((fact) => (
              <li key={fact.id}>
                {fact.text}
                {fact.role && (
                  <small>
                    {" "}
                    · {fact.role.org}
                    {fact.role.title ? ` — ${fact.role.title}` : ""}
                  </small>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.snapshot.resumes.map((resume) => (
        <article key={`${resume.id}:${resume.version}`}>
          <h2>
            {resume.profile.name || "Resume"} · Version {resume.version}
          </h2>
          <p>
            {[
              resume.profile.email,
              resume.profile.phone,
              resume.profile.location,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p>
            {resume.verification === "verified"
              ? "Verified from confirmed facts"
              : resume.verification === "user-authored"
                ? "User-authored content"
                : "Includes content without a verified status"}
          </p>
          {resume.summary && <ul>{line(resume.summary)}</ul>}
          {resume.sections.map((section, index) => (
            <section key={`${section.id}:${index}`}>
              <h3>
                {section.title ? `${section.title} · ` : ""}
                {section.org}
              </h3>
              <p>
                {section.startDate} – {section.endDate ?? "Present"}
              </p>
              <ul>{section.lines.map(line)}</ul>
            </section>
          ))}
          {resume.skills.length > 0 && (
            <p>Skills: {resume.skills.join(", ")}</p>
          )}
        </article>
      ))}
    </main>
  );
}
