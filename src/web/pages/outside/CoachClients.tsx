import { useId, useState } from "react";
import type { CoachClient } from "../../../shared/sharing";
import { api } from "../../api";
import { ActionError, Badge, EmptyState, ErrorNote, Loading, Message, PageHeader } from "../../components/ui";
import { formatDate } from "../../format";
import { useAction, useResource } from "../../hooks";
import { href } from "../../router";
import { useSession } from "../../session";
import "../../styles/rooms/outside.css";

// Coaching › Clients: the copies other people have shared with this account as their coach. A
// client adds the coach, never the other way round, and each copy is fixed and has an end. A live
// copy opens on a page of its own in the app (CoachCopy).

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "6 facts, 1 resume version and 1 document", leaving out whatever the copy doesn't hold. */
function contents(client: CoachClient): string {
  const parts = [
    client.factCount > 0 ? count(client.factCount, "fact") : "",
    client.resumeCount > 0 ? count(client.resumeCount, "resume version") : "",
    client.documentCount > 0 ? count(client.documentCount, "document") : "",
  ].filter(Boolean);
  if (parts.length === 0) return "A fixed copy";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
}

export function CoachClients() {
  const list = useResource(() => api.coachClients());
  const { me, refreshMe } = useSession();
  // The menu shows Coaching only to someone who has a client, so the count is read again after a change.
  const changed = async () => {
    await list.reload();
    void refreshMe();
  };
  const address = me.signInEmail ? `, ${me.signInEmail}` : "";
  return (
    <>
      <PageHeader title="Clients">People who shared a copy with you. Each copy is fixed, and each one has an end.</PageHeader>
      <div className="app-coach">
        <div className="app-coach__main">
          {list.error ? (
            <ErrorNote message={list.error} onRetry={list.reload} />
          ) : !list.data ? (
            <Loading>Loading your clients…</Loading>
          ) : (
            <>
              {list.data.needsSignIn && (
                <Message tone="info">Sign out and in again to open your clients’ copies. This session is from before coaches had accounts.</Message>
              )}
              <section className="rs-panel" aria-labelledby="coach-clients">
                <h2 id="coach-clients" className="rs-h2">
                  Your clients
                </h2>
                {list.data.clients.length === 0 ? (
                  <EmptyState title="No clients yet">
                    When someone names your sign-in address{me.signInEmail ? `, ${me.signInEmail},` : ""} on a copy they share, open their link while signed in and choose Add to
                    my clients.
                  </EmptyState>
                ) : (
                  <ul className="plain-list app-coach__clients">
                    {list.data.clients.map((client) => (
                      <ClientRow client={client} unknown={list.data!.needsSignIn} onChanged={changed} key={client.grantId} />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
        <aside className="app-coach__aside" aria-label="About clients">
          <section className="rs-panel" aria-labelledby="coach-added">
            <h2 id="coach-added" className="rs-h3">
              How a client is added
            </h2>
            <p className="rs-meta">A client adds you. Nobody can be added from this side.</p>
            <ol className="app-coach__steps">
              <li>They share a copy and name your sign-in address{address}. It appears here.</li>
              <li>Or they send you a link. Open it while signed in and choose Add to my clients.</li>
            </ol>
          </section>
          <section className="rs-panel" aria-labelledby="coach-can">
            <h2 id="coach-can" className="rs-h3">
              What you can do with a copy
            </h2>
            <ul className="app-coach__steps">
              <li>Read it: the resume, the documents and the facts they chose.</li>
              <li>Comment on a line or a fact.</li>
              <li>Suggest wording for a line. It’s checked against their confirmed facts when they accept, and changes nothing before.</li>
            </ul>
            <p className="rs-meta">You can’t change a client’s resume, see anything they didn’t choose, or keep a copy after it ends.</p>
          </section>
        </aside>
      </div>
    </>
  );
}

/**
 * One client's copy. `unknown` is a session from before coaches had an address: the server can't
 * say whose coach it is, so nothing is known about the copy until they sign in again, and the row
 * says only when it was added. It never says the copy has ended.
 */
function ClientRow({ client, unknown, onChanged }: { client: CoachClient; unknown: boolean; onChanged: () => void | Promise<void> }) {
  const remove = useAction();
  const [confirming, setConfirming] = useState(false);
  const id = useId();
  const name = client.ownerName ?? "A client who didn’t give their name";
  const state = unknown ? "unknown" : client.active ? "live" : "ended";
  return (
    <li className="app-coach__client">
      <div className="app-coach__client-head">
        <h3 className="rs-h3" id={`${id}-name`}>
          {name}
        </h3>
        {state === "ended" && <Badge tone="note">Ended</Badge>}
      </div>
      {state === "live" && <p className="app-coach__holds">{contents(client)}.</p>}
      <p className="rs-meta">
        {state === "unknown"
          ? `Added ${formatDate(client.addedAt)}.`
          : state === "live"
            ? `Added ${formatDate(client.addedAt)}. The copy ends ${formatDate(client.expiresAt)}.`
            : "Their link has expired or been turned off. They can share again at any time."}
      </p>
      <div className="app-coach__actions">
        {state === "live" && (
          // A client who left their name off is told apart from another by the heading the link points to.
          <a className="rs-btn rs-btn--primary rs-btn--sm" href={href.client(client.grantId)} aria-describedby={client.ownerName ? undefined : `${id}-name`}>
            {client.ownerName ? `Open ${client.ownerName}’s copy` : "Open their copy"}
          </a>
        )}
        {confirming ? (
          <>
            <button
              type="button"
              className="rs-btn rs-btn--danger rs-btn--sm"
              aria-describedby={`${id}-name`}
              disabled={remove.pending}
              onClick={() =>
                void remove.run(async () => {
                  await api.removeCoachClient(client.grantId);
                  await onChanged();
                })
              }
            >
              {remove.pending ? "Removing…" : "Remove from my list"}
            </button>
            <button type="button" className="rs-btn rs-btn--quiet rs-btn--sm" disabled={remove.pending} onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="rs-btn rs-btn--quiet rs-btn--sm" aria-label={`Remove ${name} from my list`} onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
      <ActionError message={remove.error} />
    </li>
  );
}
