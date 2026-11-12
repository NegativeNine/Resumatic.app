import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  MAX_COMMENT_CHARS,
  targetText,
  type CommentThread,
  type OwnerCommentThread,
  type ShareComment,
  type ShareTarget,
  type SharedView,
} from "../../shared/sharing";
import { api, ApiError } from "../api";
import { describeError } from "../errors";
import { formatDate } from "../format";
import { useAction, useResource } from "../hooks";
import { href } from "../router";
import { ACCOUNT_DELETED_NOTE, useSession } from "../session";
import { sameTarget } from "./ShareSnapshotContent";
import { CoachSuggestion, OwnerSuggestion, SuggestWording } from "./SuggestedWording";
import { ActionError, Badge, CharCount, ErrorNote, Field, Loading, Success } from "./ui";

// Comments on a shared copy: the coach's side, beside the copy they are reading, and the owner's
// side, on Account. A comment is another person's words. It is shown as text and nothing else:
// no markup, no links, and nothing a comment says changes what the page does.

/**
 * One thread: what it is about, then each comment under who wrote it and when, oldest first.
 * `byline` names a comment's writer as this reader should see them. A comment the reader may
 * delete has Delete, which asks before it does anything. `children` sit under the comments: where
 * the thread came from, and the form to add to it. A coach's suggested wording is shown as the
 * card `suggestion` gives for it, in place of the comment's words.
 */
export function ThreadCard({
  quote,
  comments,
  byline,
  canDelete,
  onDelete,
  suggestion,
  children,
}: {
  quote: string;
  comments: ShareComment[];
  byline: (comment: ShareComment) => string;
  canDelete: (comment: ShareComment) => boolean;
  /** Deletes the comment and settles once the thread shows it gone. A failure is the caller's to show. */
  onDelete: (comment: ShareComment) => Promise<unknown>;
  /** The card for a row that is a suggestion. */
  suggestion?: (comment: ShareComment) => ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function remove(comment: ShareComment) {
    setDeleting(true);
    try {
      await onDelete(comment);
    } finally {
      setDeleting(false);
      setConfirming(null);
    }
  }

  return (
    <article className="app-thread" aria-labelledby={`${id}-on`}>
      <h3 className="app-thread__on" id={`${id}-on`}>
        On “{quote}”
      </h3>
      <ul className="plain-list app-thread__comments">
        {comments.map((comment) => {
          const asking = confirming === comment.id;
          return (
            <li className="app-thread__comment" key={comment.id}>
              <p className="rs-meta app-thread__byline" id={`${id}-${comment.id}`}>
                {byline(comment)}, {formatDate(comment.createdAt)}
                {comment.seen === false && (
                  <>
                    {" "}
                    <Badge tone="needs-you">New</Badge>
                  </>
                )}
              </p>
              {comment.suggestion && suggestion ? suggestion(comment) : <p className="app-thread__body">{comment.body}</p>}
              {canDelete(comment) && (
                <p className="app-thread__actions">
                  {asking && (
                    <button type="button" className="rs-btn rs-btn--danger rs-btn--sm" disabled={deleting} onClick={() => void remove(comment)}>
                      {deleting ? "Deleting…" : comment.suggestion ? "Delete suggestion" : "Delete comment"}
                    </button>
                  )}
                  {/* One button for Delete and for Keep, so the keyboard stays where it was and a second press keeps.
                      It is described by whose comment it is and when, which tells several of them apart. */}
                  <button
                    type="button"
                    className="rs-btn rs-btn--quiet rs-btn--sm"
                    aria-describedby={`${id}-${comment.id}`}
                    disabled={deleting}
                    onClick={() => setConfirming(asking ? null : comment.id)}
                  >
                    {asking ? "Keep" : "Delete"}
                  </button>
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {children}
    </article>
  );
}

const targetKey = (target: ShareTarget) =>
  target.kind === "line" ? `line:${target.resumeId}:${target.version}:${target.lineId}` : `fact:${target.factId}`;

const SEND_FAILED = "That didn’t go through. Check your connection, then try again.";

/**
 * A name another person chose, fit to stand where a comment says whose it is, or null. Words that
 * would read as the reader's own (“You”) or as the product's are no name at all, so the caller
 * falls back to what it says without one.
 */
export function chosenName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  return trimmed && !["you", "resumatic"].includes(trimmed.toLowerCase()) ? trimmed : null;
}

/** The copy's route refusing a copy that isn't in this account's client list, as against a server with no such route. */
const NOT_LISTED = "no such client";

/**
 * The threads a coach has written on a client's copy, and the form to write another. It stands
 * beside the copy at /share, which has no signed-in session of the app around it, so it asks the
 * API itself. `selected` is the line or fact chosen on the copy. `onUnlisted` is called when the
 * copy turns out not to be in this account's client list. `onEnded` is called with the one
 * sentence left when commenting is over for this reader, because the copy ended or they must sign
 * in again: the page then shows that sentence in place of the threads, and nothing to choose.
 */
export function CoachComments({
  view,
  selected,
  onUnlisted,
  onEnded,
}: {
  view: SharedView;
  selected: ShareTarget | null;
  onUnlisted: () => void;
  onEnded: (sentence: string) => void;
}) {
  const id = useId();
  const grantId = view.grantId;
  const owner = chosenName(view.snapshot.owner?.name);
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Suggest mode replaces the comment form for the chosen line, until it is sent or cancelled.
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The page's handlers are read when they are needed, so new ones on each render don't load the threads again.
  const unlisted = useRef(onUnlisted);
  const ended = useRef(onEnded);
  useEffect(() => {
    unlisted.current = onUnlisted;
    ended.current = onEnded;
  });

  /**
   * Sorts a refusal. The copy isn't in the list: the page offers to add it. That is the route's own
   * refusal, by its sentence; any other 404, such as a server from before comments answering "no
   * such route", is a failure like any other, so it never sends the reader round adding a copy their
   * list already holds. The copy has ended, or the session has: only that sentence is left.
   * Anything else is the caller's to word, with the server's own sentence when it sent one the
   * reader can act on.
   */
  const refused = useCallback((e: unknown, otherwise: (sentence: string | null) => void) => {
    if (!mounted.current) return;
    const status = e instanceof ApiError ? e.status : 0;
    if (status === 404 && e instanceof ApiError && e.message === NOT_LISTED) unlisted.current();
    else if (status === 401 || status === 409 || status === 410)
      ended.current(describeError(e, { unauthenticated: "Sign in to Resumatic again, then reload this page.", gone: ACCOUNT_DELETED_NOTE }));
    else otherwise(status === 422 || status === 429 ? describeError(e) : null);
  }, []);

  // Choosing something else on the copy closes a suggestion that was being written.
  const chosen = selected ? targetKey(selected) : null;
  useEffect(() => {
    setSuggesting(false);
  }, [chosen]);

  // Whether this deployment sends email notices, so the form says what the owner may be told.
  // The owner's own choice can't be known here. Not knowing reads as no email.
  const [emailing, setEmailing] = useState(false);
  const load = useCallback(async () => {
    try {
      const [found, me] = await Promise.all([api.coachComments(grantId), api.me().catch(() => null)]);
      if (!mounted.current) return;
      // A reply that isn't a list of threads is a failed load, not an empty one.
      if (!Array.isArray(found?.threads)) throw new ApiError(502, "unavailable", "The response was incomplete.");
      setEmailing(me?.capabilities?.emailNotices === true);
      setThreads(found.threads);
      setLoadFailed(false);
    } catch (e) {
      refused(e, () => setLoadFailed(true));
    }
  }, [grantId, refused]);
  useEffect(() => {
    void load();
  }, [load]);

  const trimmed = text.trim();
  async function send() {
    if (!selected || sending) return;
    setSending(true);
    setSent(false);
    setError(null);
    try {
      const made = await api.addCoachComment(grantId, { target: selected, body: trimmed });
      if (!mounted.current) return;
      // The comment joins its thread, or starts one under the words the copy shows for its target.
      setThreads((current) => {
        const known = current ?? [];
        if (known.some((thread) => thread.comments.some((comment) => comment.id === made.id))) return known;
        return known.some((thread) => sameTarget(thread.target, selected))
          ? known.map((thread) => (sameTarget(thread.target, selected) ? { ...thread, comments: [...thread.comments, made] } : thread))
          : [...known, { target: selected, quote: targetText(view.snapshot, selected) ?? "", comments: [made] }];
      });
      setText("");
      setSent(true);
    } catch (e) {
      // The words stay in the box, so nothing typed is lost to a refusal or a dropped connection.
      refused(e, (sentence) => setError(sentence ?? SEND_FAILED));
    } finally {
      if (mounted.current) setSending(false);
    }
  }

  async function remove(comment: ShareComment) {
    setError(null);
    setSent(false);
    try {
      await api.removeCoachComment(grantId, comment.id);
      if (!mounted.current) return;
      setThreads((current) =>
        (current ?? [])
          .map((thread) => ({ ...thread, comments: thread.comments.filter((kept) => kept.id !== comment.id) }))
          .filter((thread) => thread.comments.length > 0),
      );
    } catch (e) {
      refused(e, (sentence) => setError(sentence ?? SEND_FAILED));
    }
  }

  if (loadFailed) return <ErrorNote message="Comments couldn’t be loaded. Check your connection, then try again." onRetry={load} />;
  if (!threads) return <Loading>Loading comments…</Loading>;

  const kind = selected?.kind ?? null;
  const reader = owner ?? "The owner of this copy";
  const line = selected?.kind === "line" ? selected : null;
  const lineText = line ? targetText(view.snapshot, line) : null;
  // One suggestion of this account's waits on a line at a time, as the owner's vault holds it.
  const waiting = !!line && threads.some((thread) => sameTarget(thread.target, line) && thread.comments.some((comment) => comment.suggestion?.state === "waiting"));
  return (
    <>
      {threads.length === 0 ? (
        <p className="rs-meta app-comments__none">No comments yet.</p>
      ) : (
        <ul className="plain-list app-threads">
          {threads.map((thread) => (
            <li key={targetKey(thread.target)}>
              <ThreadCard
                quote={thread.quote}
                comments={thread.comments}
                byline={(comment) => (comment.author === "coach" ? "You" : (owner ?? "The owner"))}
                canDelete={(comment) => comment.author === "coach"}
                onDelete={remove}
                suggestion={(comment) => <CoachSuggestion comment={comment} quote={thread.quote} ownerName={owner} />}
              />
            </li>
          ))}
        </ul>
      )}
      {suggesting && line && lineText !== null ? (
        <SuggestWording
          // A new line starts a new suggestion, from that line's own words.
          key={targetKey(line)}
          grantId={grantId}
          snapshot={view.snapshot}
          target={line}
          line={lineText}
          ownerName={owner}
          waiting={waiting}
          onSent={(made) => {
            if (!mounted.current) return;
            setThreads((current) => {
              const known = current ?? [];
              if (known.some((thread) => thread.comments.some((comment) => comment.id === made.id))) return known;
              return known.some((thread) => sameTarget(thread.target, line))
                ? known.map((thread) => (sameTarget(thread.target, line) ? { ...thread, comments: [...thread.comments, made] } : thread))
                : [...known, { target: line, quote: lineText, comments: [made] }];
            });
            setSuggesting(false);
            setSuggested(true);
          }}
          onCancel={() => setSuggesting(false)}
          onRefused={refused}
        />
      ) : (
      <form
        className="app-comment-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Field
          id={`${id}-text`}
          label={kind ? `Comment on the selected ${kind}` : "Comment on a line or a fact"}
          hint={
            kind
              ? `${reader} will see this the next time they open Resumatic. ${emailing ? "They may also get an email saying there’s something new. It never holds your words." : "Resumatic doesn’t send email."} They keep your comments, with your name and sign-in address, until they delete them.`
              : "Choose a line or a fact on the copy to comment on it."
          }
        >
          <textarea
            id={`${id}-text`}
            className="rs-textarea"
            rows={4}
            value={text}
            disabled={!kind || sending}
            placeholder={kind ? `Say what would make this ${kind} stronger.` : undefined}
            onChange={(event) => {
              setText(event.target.value);
              setSent(false);
              setSuggested(false);
            }}
            aria-describedby={`${id}-text-hint ${id}-count`}
          />
        </Field>
        <CharCount id={`${id}-count`} length={trimmed.length} max={MAX_COMMENT_CHARS} />
        <div className="actions">
          <button type="submit" className="rs-btn rs-btn--primary" disabled={!kind || sending || !trimmed || trimmed.length > MAX_COMMENT_CHARS}>
            {sending ? "Sending…" : "Comment"}
          </button>
          {/* Wording can be suggested for a line, not for a fact. */}
          <button
            type="button"
            className="rs-btn"
            disabled={!line || lineText === null || sending}
            onClick={() => {
              setSent(false);
              setSuggested(false);
              setError(null);
              setSuggesting(true);
            }}
          >
            Suggest wording
          </button>
          {sent && <Success>Comment added.</Success>}
          {suggested && <Success>Suggestion sent.</Success>}
        </div>
        <ActionError message={error} />
      </form>
      )}
    </>
  );
}

/**
 * What a coach wrote on the copies this person shared, on Account. Nothing is shown until there is
 * a thread. The comments are marked seen once they are on the page, which clears the count beside
 * Account in the menu.
 */
export function OwnerComments() {
  const { refreshMe } = useSession();
  const list = useResource(
    async () => {
      try {
        return (await api.shareComments()).threads;
      } catch (error) {
        // A server from before comments has no such list, and so none to show.
        if (error instanceof ApiError && error.status === 404) return [];
        throw error;
      }
    },
    // A suggestion being checked is read again until its check is over.
    (threads) => checkingIds(threads).size > 0,
  );
  const id = useId();
  const [starting, setStarting] = useState(false);

  // A check that has ended, or whose card has gone, has settled the outputs it reserved.
  const checking = useRef(new Set<string>());
  useEffect(() => {
    if (!list.data) return;
    const now = checkingIds(list.data);
    const ended = [...checking.current].some((comment) => !now.has(comment));
    checking.current = now;
    if (ended) void refreshMe();
  }, [list.data, refreshMe]);

  // Told once for each comment. The marks stay on this showing of the page, which is what "new" means.
  const told = useRef(new Set<string>());
  useEffect(() => {
    const unseen = (list.data ?? [])
      .flatMap((thread) => thread.comments)
      .filter((comment) => comment.seen === false && !told.current.has(comment.id))
      .map((comment) => comment.id);
    if (unseen.length === 0) return;
    for (const comment of unseen) told.current.add(comment);
    // The page names what it showed. A comment written since the list was read stays new.
    api.markShareCommentsSeen(unseen).then(
      () => refreshMe(),
      () => {
        // Not noted this time. They are still new, and the next showing tries again.
        for (const comment of unseen) told.current.delete(comment);
      },
    );
  }, [list.data, refreshMe]);

  const threads = list.data ?? [];
  // Resumatic makes one thing at a time, so no suggestion can be accepted while a check is starting or running.
  const busy = starting || checkingIds(threads).size > 0;
  if (threads.length === 0 && !list.error) return null;
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Comments from your coach</h2>
      <p className="card-text">
        What your coach wrote on copies you shared. These are their words, not your facts: Resumatic never uses a
        comment to write or check a resume. They stay here after a copy ends, until you delete them.
      </p>
      {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
      {threads.length > 0 && (
        <ul className="plain-list app-threads">
          {threads.map((thread) => (
            // A thread has no ID of its own. Its oldest comment's is the nearest thing that stays put.
            <li key={thread.comments[0]?.id ?? `${thread.grantId}:${targetKey(thread.target)}`}>
              <OwnerThread thread={thread} onChanged={list.reload} busy={busy} onStarting={setStarting} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The suggestions whose check is running, by ID. */
function checkingIds(threads: readonly OwnerCommentThread[]): Set<string> {
  return new Set(threads.flatMap((thread) => thread.comments).filter((comment) => comment.suggestion?.state === "checking").map((comment) => comment.id));
}

/**
 * One thread as its owner reads it: who wrote it, about what, where to open that, and a reply while
 * the copy is open. A suggestion in it has its own card. `busy` is true while any check is being
 * started or is running; `onStarting` says when one of this thread's is being started.
 */
function OwnerThread({
  thread,
  onChanged,
  busy,
  onStarting,
}: {
  thread: OwnerCommentThread;
  onChanged: () => Promise<unknown>;
  busy: boolean;
  onStarting: (starting: boolean) => void;
}) {
  const id = useId();
  const reply = useAction();
  const remove = useAction();
  const [text, setText] = useState("");
  const trimmed = text.trim();
  // A reply answers the coach's latest comment, and goes to the account that wrote it.
  const latest = thread.comments.filter((comment) => comment.author === "coach").at(-1) ?? null;
  const coach = chosenName(latest?.name) ?? thread.coachEmail;
  const closed = `This copy isn’t open to ${coach} any more, so they can’t read a reply. Share a new copy to carry on.`;
  const job = thread.target.kind === "line" ? [thread.job?.title, thread.job?.company].filter(Boolean).join(" at ") : "";

  return (
    <ThreadCard
      quote={thread.quote}
      comments={thread.comments}
      // "You" is the owner's alone. A coach's comment always carries the address they sign in with,
      // so no name they choose for their account can pass for the owner's words, or the product's.
      byline={(comment) => {
        if (comment.author === "owner") return "You";
        const name = chosenName(comment.name);
        return name ? `${name} (${thread.coachEmail})` : thread.coachEmail;
      }}
      // A suggestion being checked stays until its check is over.
      canDelete={(comment) => comment.suggestion?.state !== "checking"}
      onDelete={(comment) =>
        remove.run(async () => {
          await api.removeShareComment(comment.id);
          await onChanged();
        })
      }
      suggestion={(comment) => (
        <OwnerSuggestion comment={comment} quote={thread.quote} coachName={chosenName(comment.name)} busy={busy} onStarting={onStarting} onChanged={onChanged} />
      )}
    >
      <ActionError message={remove.error} />
      <p className="rs-meta app-thread__from">
        {thread.target.kind === "line" ? (
          <>
            From {thread.coachEmail}, on version {thread.target.version} of {job ? `your resume for ${job}` : "a resume"}.{" "}
            <a className="rs-link" href={href.resume(thread.target.resumeId)}>
              Open this resume
            </a>
          </>
        ) : (
          <>
            From {thread.coachEmail}, on a fact you shared.{" "}
            <a className="rs-link" href={href.facts}>
              Open Facts
            </a>
          </>
        )}
      </p>
      {!thread.open ? (
        <p className="rs-meta app-thread__closed">{closed}</p>
      ) : (
        latest && (
          <form
            className="app-comment-form"
            onSubmit={(event) => {
              event.preventDefault();
              void reply.run(
                async () => {
                  await api.replyToShareComment(latest.id, trimmed);
                  setText("");
                  await onChanged();
                },
                // The copy closed, or passed to another account, since the page was loaded.
                { conflict: closed },
              );
            }}
          >
            <Field
              id={`${id}-reply`}
              label={`Reply to ${coach}`}
              hint={`${coach} sees your reply when they next open this copy. Resumatic doesn’t email coaches.`}
            >
              <textarea
                id={`${id}-reply`}
                className="rs-textarea"
                rows={3}
                value={text}
                disabled={reply.pending}
                onChange={(event) => setText(event.target.value)}
                aria-describedby={`${id}-reply-hint ${id}-count`}
              />
            </Field>
            <CharCount id={`${id}-count`} length={trimmed.length} max={MAX_COMMENT_CHARS} />
            <div className="actions">
              <button type="submit" className="rs-btn rs-btn--primary rs-btn--sm" disabled={reply.pending || !trimmed || trimmed.length > MAX_COMMENT_CHARS}>
                {reply.pending ? "Sending…" : "Reply"}
              </button>
            </div>
            <ActionError message={reply.error} />
          </form>
        )
      )}
    </ThreadCard>
  );
}
