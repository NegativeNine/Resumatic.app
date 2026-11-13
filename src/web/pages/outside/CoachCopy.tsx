import { useRef, useState } from "react";
import type { SharedView } from "../../../shared/sharing";
import { api, ApiError } from "../../api";
import { useCoachCommenting } from "../../components/outside/coach-commenting";
import { copyHeading, copyMade, SharedCopy, type ShareCommenting } from "../../components/ShareSnapshotContent";
import { Badge, ErrorNote, Loading, StateCard } from "../../components/ui";
import { describeError } from "../../errors";
import { useResource } from "../../hooks";
import { href } from "../../router";
import "../../components/share.css";
import "../../styles/rooms/outside.css";

// A client's copy, read in the app: the same fixed copy the link gives, with the comments and the
// form beside it, as the coach has them at /share. Each read is checked again by the copy's owner's
// vault, from this session and this account's own client list, and sets no cookie.

/** What reading the copy came to. `useResource` keeps only a sentence, so the loader sorts the refusals itself. */
type CopyState = { kind: "copy"; view: SharedView } | { kind: "unlisted" } | { kind: "ended"; sentence: string };

/** The copy's route refusing a copy that isn't in this account's client list (routes.ts, coachCopy). */
const NOT_LISTED = "no such client";

export function CoachCopy({ grantId }: { grantId: string }) {
  /**
   * Not in the list is the route's own 404, by its sentence; any other 404, such as a server from
   * before this route answering "no such route", is a failure to try again, never a copy to add.
   * A copy that has ended is a 409, said in the server's sentence. A 401 or a 410 is this account's
   * own session or vault, and `useResource` ends the session on it; the rest is retried.
   */
  async function readCopy(): Promise<CopyState> {
    try {
      return { kind: "copy", view: await api.coachCopy(grantId) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && e.message === NOT_LISTED) return { kind: "unlisted" };
      if (e instanceof ApiError && e.status === 409) return { kind: "ended", sentence: describeError(e) };
      throw e;
    }
  }
  /**
   * The last read that was asked for, which every other reload answers with. `useResource` also
   * reloads when the coach's own vault reports a change, but the copy is kept in the client's vault
   * and is fixed, so those changes say nothing about it. Reading it then would tell its owner of a
   * read the coach never made, could put a passing failure in place of the copy, and, as a new view,
   * would start the comments over, losing a line chosen or wording being written. So the copy is
   * read when the page opens, on Try again and after a refused comment, as at /share.
   */
  const asked = useRef<Promise<CopyState> | null>(null);
  const copy = useResource(() => (asked.current ??= readCopy()));
  const readAgain = () => {
    asked.current = null;
    return copy.reload();
  };
  /** The comments found the copy taken off this list, as when another tab removed it. */
  const [unlisted, setUnlisted] = useState(false);
  /**
   * Why the comments were refused. Reading the copy again decides what comes next: the session
   * ends, the copy has ended, or it is still here and the sentence stays where the threads were.
   */
  const [refused, setRefused] = useState<string | null>(null);
  const view = copy.data?.kind === "copy" ? copy.data.view : null;
  const coaching = useCoachCommenting(view, {
    onUnlisted: () => setUnlisted(true),
    onEnded: (sentence) => {
      setRefused(sentence);
      void readAgain();
    },
  });

  if (unlisted || copy.data?.kind === "unlisted")
    return (
      <StateCard level={1} title="This copy isn’t in your clients" action={<BackToClients />}>
        Open the link from your client’s message, then choose Add to my clients.
      </StateCard>
    );
  if (copy.error) return <ErrorNote message={copy.error} onRetry={readAgain} />;
  if (!copy.data) return <Loading>Opening your client’s copy…</Loading>;
  if (copy.data.kind === "ended")
    return (
      <StateCard level={1} title="This copy can’t be opened" action={<BackToClients />}>
        {copy.data.sentence}
      </StateCard>
    );

  const shown = copy.data.view;
  const name = shown.snapshot.owner?.name || "A client who didn’t give their name";
  // Once the comments were refused, their sentence stays in place of the threads, though the copy read again.
  const comments: ShareCommenting | undefined =
    coaching.comments && refused !== null ? { selected: null, aside: <ErrorNote message={refused} /> } : coaching.comments;
  return (
    <>
      <nav aria-label="Breadcrumb" className="app-crumbs">
        <ol className="plain-list">
          <li>
            <a href={href.clients}>Clients</a>
          </li>
          <li aria-current="page">{name}</li>
        </ol>
      </nav>
      <div className="page-head app-coach__copy-head">
        <div>
          <h1 className="rs-h1">{copyHeading(shown.snapshot)}</h1>
          <p className="rs-meta">{copyMade(shown)}</p>
        </div>
        <Badge tone="note">Shared copy, read only</Badge>
      </div>
      <div className="app-share app-share--in-app">
        <SharedCopy view={shown} comments={comments} />
      </div>
    </>
  );
}

function BackToClients() {
  return (
    <p className="app-state-card__action">
      <a href={href.clients}>Back to your clients</a>
    </p>
  );
}
