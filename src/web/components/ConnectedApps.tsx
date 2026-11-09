import { useCallback, useEffect, useId, useState } from "react";
import type { McpGrant } from "../../shared/mcp";
import { formatDate } from "../format";
import { Badge, EmptyState, Glyph } from "./ui";
import "./workspace.css";

/** AI tools the person has let read their facts, each with what it may do and a way to end it. */
export function ConnectedApps() {
  const [grants, setGrants] = useState<McpGrant[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const id = useId();
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/mcp/grants", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { grants: McpGrant[] };
      setGrants(data.grants);
      setError("");
    } catch {
      setError("Connected apps couldn't be loaded. Check your connection, then reload the page.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const revoke = async (grantId: string) => {
    setBusy(grantId);
    try {
      const response = await fetch(
        `/api/mcp/grants/${encodeURIComponent(grantId)}`,
        { method: "DELETE", credentials: "same-origin" },
      );
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setError("This app's access couldn't be removed. Try again to finish removing its credentials.");
    } finally {
      setBusy(null);
    }
  };
  const address = typeof window === "undefined" ? "/mcp" : `${window.location.origin}/mcp`;
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Connected apps</h2>
      <p className="card-text">
        Connect an AI tool with the address below. Each app asks for its permissions, and its access ends after
        30 days.
      </p>
      <p className="app-address">
        <code>{address}</code>
      </p>
      {error && (
        <div className="rs-msg rs-msg--error app-msg-block" role="alert">
          <Glyph name="alert" />
          <p className="rs-msg__text">{error}</p>
        </div>
      )}
      {grants?.length === 0 && !error && <EmptyState>No connected apps.</EmptyState>}
      {grants && grants.length > 0 && (
        <ul className="plain-list app-share-links">
          {grants.map((grant) => {
            const inactive = grant.revokedAt !== null || grant.expiresAt <= Date.now();
            const pending = !inactive && grant.state === "pending";
            return (
              <li className="rs-setting" key={grant.id}>
                <p className="rs-setting__text">
                  <strong>
                    {grant.clientName}{" "}
                    {inactive ? (
                      <Badge tone="rejected">Access ended</Badge>
                    ) : pending ? (
                      <Badge tone="proposed">Waiting to connect</Badge>
                    ) : (
                      <Badge tone="ready">
                        <Glyph name="check" />
                        Connected
                      </Badge>
                    )}
                  </strong>
                  <span>
                    {grant.scopes.includes("vault:generate")
                      ? "Can read your facts and create documents."
                      : "Can read your facts."}
                    {!inactive && !pending ? ` Access ends ${formatDate(grant.expiresAt)}.` : ""}
                  </span>
                </p>
                <button type="button" className="small" disabled={busy === grant.id} onClick={() => void revoke(grant.id)}>
                  {busy === grant.id ? "Removing…" : inactive ? "Remove credentials" : "Revoke access"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
