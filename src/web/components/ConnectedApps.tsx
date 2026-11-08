import { useCallback, useEffect, useState } from "react";
import type { McpGrant } from "../../shared/mcp";
import { formatDate } from "../format";

export function ConnectedApps() {
  const [grants, setGrants] = useState<McpGrant[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
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
      setError("Connected apps could not be loaded.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const revoke = async (id: string) => {
    setBusy(id);
    try {
      const response = await fetch(
        `/api/mcp/grants/${encodeURIComponent(id)}`,
        { method: "DELETE", credentials: "same-origin" },
      );
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setError(
        "Could not finish revoking this app. Retry to finish removing its credentials.",
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <section>
      <h2>Connected apps</h2>
      <p>
        Connect an AI tool using{" "}
        <code>
          {typeof window === "undefined"
            ? "/mcp"
            : `${window.location.origin}/mcp`}
        </code>
        . Approve each app's permissions when it asks. Access expires after 30
        days.
      </p>
      {error && <p role="alert">{error}</p>}
      {!grants.length && !error && <p>No connected apps.</p>}
      <ul>
        {grants.map((grant) => {
          const inactive =
            grant.revokedAt !== null || grant.expiresAt <= Date.now();
          return (
            <li key={grant.id}>
              <strong>{grant.clientName}</strong>,{" "}
              {grant.scopes.includes("vault:generate")
                ? "read and generate"
                : "read only"}
              :{" "}
              {inactive
                ? "access ended"
                : grant.state === "pending"
                  ? "awaiting connection"
                  : `expires ${formatDate(grant.expiresAt)}`}{" "}
              <button
                type="button"
                disabled={busy === grant.id}
                onClick={() => void revoke(grant.id)}
              >
                {busy === grant.id
                  ? "Revoking…"
                  : inactive
                    ? "Remove credentials"
                    : "Revoke"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
