import { useState } from "react";
import type { CoachClient } from "../../shared/sharing";
import { api } from "../api";
import { ActionError, Badge, EmptyState, ErrorNote, Loading, Message, PageHeader } from "../components/ui";
import { formatDate } from "../format";
import { useAction, useResource } from "../hooks";
import { useSession } from "../session";

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

/** The copies other people have shared with this account as their coach. */
export function ClientsPage() {
  const list = useResource(() => api.coachClients());
  const { refreshMe } = useSession();
  // The menu shows Clients only to someone who has one, so the count is read again after a change.
  const changed = async () => {
    await list.reload();
    void refreshMe();
  };
  return (
    <>
      <PageHeader title="Clients">
        People who have shared a copy with you as their coach. Each of them chooses what you see and for how long.
      </PageHeader>
      {list.error ? (
        <ErrorNote message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading>Loading your clients</Loading>
      ) : (
        <>
          {list.data.needsSignIn && (
            <Message tone="info">Sign out and in again to open your clients’ copies. This session is from before coaches had accounts.</Message>
          )}
          {list.data.clients.length === 0 ? (
            <EmptyState title="No clients yet">
              When someone names your sign-in address on a copy they share, open their link while signed in and add it
              here. After that it opens from this page.
            </EmptyState>
          ) : (
            <ul className="plain-list app-clients">
              {list.data.clients.map((client) => (
                <ClientRow client={client} unknown={list.data!.needsSignIn} onChanged={changed} key={client.grantId} />
              ))}
            </ul>
          )}
          <p className="rs-meta app-clients__foot">
            A client can end your access at any moment. Their original files, private notes and the words a fact came
            from are never shared.
          </p>
        </>
      )}
    </>
  );
}

/**
 * One client's copy. `unknown` is a session that can't be shown as anyone's coach: nothing is known
 * about the copy until they sign in again, so the row doesn't say it has ended.
 */
function ClientRow({ client, unknown, onChanged }: { client: CoachClient; unknown: boolean; onChanged: () => void | Promise<void> }) {
  const open = useAction();
  const remove = useAction();
  const [confirming, setConfirming] = useState(false);
  const name = client.ownerName ?? "A client who didn’t give their name";
  return (
    <li className="card app-client">
      <div className="app-client__head">
        <div>
          <h2>{name}</h2>
          <p className="rs-meta">
            {unknown
              ? `Added ${formatDate(client.addedAt)}.`
              : client.active
                ? `${contents(client)}, until ${formatDate(client.expiresAt)}.`
                : "Their link has expired or been revoked. They can share again at any time."}
          </p>
        </div>
        {!unknown && <Badge tone={client.active ? "ready" : "rejected"}>{client.active ? "Fixed copy" : "Access ended"}</Badge>}
      </div>
      <div className="app-client__actions">
        {client.active && !unknown && (
          <button
            type="button"
            className="rs-btn rs-btn--primary rs-btn--sm"
            aria-label={`Open ${name}’s copy`}
            disabled={open.pending || remove.pending}
            onClick={() =>
              void open.run(async () => {
                const opened = await api.openCoachClient(client.grantId);
                // The copy is its own page, outside the app's pages, and reads with the session just set.
                window.location.assign(`/share?g=${encodeURIComponent(opened.grantId)}`);
              })
            }
          >
            {open.pending ? "Opening…" : "Open"}
          </button>
        )}
        {confirming ? (
          <>
            <button
              type="button"
              className="rs-btn rs-btn--danger rs-btn--sm"
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
          <button
            type="button"
            className="rs-btn rs-btn--quiet rs-btn--sm"
            aria-label={`Remove ${name} from my list`}
            disabled={open.pending}
            onClick={() => setConfirming(true)}
          >
            Remove
          </button>
        )}
      </div>
      <ActionError message={open.error ?? remove.error} />
    </li>
  );
}
