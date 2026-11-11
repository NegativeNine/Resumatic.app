import { useId, useState } from "react";
import { MAX_LINE_CHARS } from "../../shared/api";
import { isVisibleLine, unchangedWording, type ShareComment, type ShareSnapshot, type ShareTarget } from "../../shared/sharing";
import { api, ApiError } from "../api";
import { describeError } from "../errors";
import { useAction } from "../hooks";
import { useSession } from "../session";
import { quotaMessage } from "../tailor";
import { ActionError, Badge, CharCount, Field } from "./ui";
import "./suggestion.css";

// Suggested wording on a shared copy. The coach a copy names proposes new words for one line;
// nothing changes unless its owner accepts, and accepting is the owner's own verified line edit
// with exactly those words. The wording is another person's text: it is shown as the text it is,
// with nothing done to it, so the owner reads exactly what would be checked.

/** The copy's line struck through, and the suggested wording beneath it. */
export function SuggestionLines({ quote, text }: { quote: string; text: string }) {
  return (
    <div className="app-suggestion__lines">
      <p className="app-suggestion__was">
        <del>
          <span className="rs-visually-hidden">Line in the copy: </span>
          {quote}
        </del>
      </p>
      <p className="app-suggestion__now">
        <ins>
          <span className="rs-visually-hidden">Suggested: </span>
          {text}
        </ins>
      </p>
    </div>
  );
}

/** A 409 that says the coach already has wording waiting on the line, not that the copy has ended. */
const isWaitingRefusal = (e: unknown) => e instanceof ApiError && e.status === 409 && e.message.startsWith("You already have a suggestion waiting");

/**
 * The coach's form for suggesting wording, in place of the comment form while it is open. It
 * starts with the line's own words, as the copy shows them, and “unchanged” is judged from
 * `snapshot` as the server judges it. `waiting` is true while a suggestion of this account's waits
 * on the line.
 * `onRefused` sorts a refusal the copy's page has to act on (the copy ended, or left the list),
 * and calls `otherwise` with the sentence to show here when there isn't one.
 */
export function SuggestWording({
  grantId,
  snapshot,
  target,
  line,
  ownerName,
  waiting,
  onSent,
  onCancel,
  onRefused,
}: {
  grantId: string;
  snapshot: ShareSnapshot;
  target: ShareTarget & { kind: "line" };
  line: string;
  ownerName: string | null;
  waiting: boolean;
  onSent: (made: ShareComment) => void;
  onCancel: () => void;
  onRefused: (e: unknown, otherwise: (sentence: string | null) => void) => void;
}) {
  const id = useId();
  const [text, setText] = useState(line);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  const sendable = !waiting && !sending && trimmed.length > 0 && trimmed.length <= MAX_LINE_CHARS && !unchangedWording(snapshot, target, trimmed) && isVisibleLine(trimmed);
  const owner = ownerName ?? "The owner";

  async function send() {
    if (!sendable) return;
    setSending(true);
    setError(null);
    try {
      onSent(await api.suggestOnShare(grantId, { target, text: trimmed }));
    } catch (e) {
      // The words stay in the box, so nothing typed is lost to a refusal or a dropped connection.
      if (isWaitingRefusal(e)) setError(describeError(e));
      else onRefused(e, (sentence) => setError(sentence ?? "That didn’t go through. Check your connection, then try again."));
      setSending(false);
    }
  }

  return (
    <form
      className="app-comment-form app-suggest-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Field
        id={`${id}-text`}
        label="Suggested wording for this line"
        hint={`${owner} decides whether to use it. If they accept, it’s checked against their confirmed facts first.`}
      >
        <textarea
          id={`${id}-text`}
          className="rs-textarea"
          rows={3}
          value={text}
          disabled={sending}
          autoFocus
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          aria-describedby={`${id}-text-hint ${id}-count${waiting ? ` ${id}-waiting` : ""}`}
        />
      </Field>
      <CharCount id={`${id}-count`} length={trimmed.length} max={MAX_LINE_CHARS} />
      {waiting && (
        <p className="rs-meta" id={`${id}-waiting`}>
          You already have a suggestion waiting on this line. Delete it to suggest another.
        </p>
      )}
      <div className="actions">
        <button type="submit" className="rs-btn rs-btn--primary" disabled={!sendable}>
          {sending ? "Sending…" : "Send suggestion"}
        </button>
        <button type="button" className="rs-btn rs-btn--quiet" disabled={sending} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ActionError message={error} />
    </form>
  );
}

/** The card for a suggestion, as the coach who wrote it reads it: one of three things, and nothing more. */
export function CoachSuggestion({ comment, quote, ownerName }: { comment: ShareComment; quote: string; ownerName: string | null }) {
  const state = comment.suggestion?.state;
  const owner = ownerName ?? "the owner";
  const Owner = ownerName ?? "The owner";
  const [tone, mark, sentence] =
    state === "used"
      ? ["ready", "Used", `${Owner} used this wording. This copy is fixed, so it still shows the earlier line.`]
      : state === "not_used"
        ? ["rejected", "Not used", `${Owner} didn’t use this suggestion.`]
        : ["proposed", `Waiting for ${owner}`, `If ${owner} accepts, the wording is checked against their confirmed facts before the resume changes.`];
  return (
    <div className="app-suggestion">
      <p className="app-suggestion__head">
        <span className="app-suggestion__title">Your suggested wording</span> <Badge tone={tone}>{mark}</Badge>
      </p>
      <SuggestionLines quote={quote} text={comment.body} />
      <p className="rs-meta app-suggestion__note">{sentence}</p>
    </div>
  );
}

/**
 * The card for a suggestion on the owner's Account, inside its thread: who suggested it, the two
 * lines, where it stands, and what can be done. `busy` turns Accept off while any check is being
 * started or is running, because Resumatic makes one thing at a time. `onStarting` says when this
 * card starts one. `onChanged` reloads the threads and settles once they show the change.
 */
export function OwnerSuggestion({
  comment,
  quote,
  coachName,
  busy,
  onStarting,
  onChanged,
}: {
  comment: ShareComment;
  quote: string;
  coachName: string | null;
  busy: boolean;
  onStarting: (starting: boolean) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { me, refreshMe } = useSession();
  const accept = useAction();
  const decline = useAction();
  const suggestion = comment.suggestion;
  const state = suggestion?.state ?? "waiting";

  async function start() {
    onStarting(true);
    try {
      await accept.run(
        async () => {
          await api.acceptSuggestion(comment.id);
          void refreshMe();
          await onChanged();
        },
        { quota: quotaMessage(me.quota) },
      );
    } finally {
      onStarting(false);
    }
  }

  const answer = () =>
    void decline.run(async () => {
      await api.declineSuggestion(comment.id);
      await onChanged();
    });

  const [tone, mark] =
    state === "checking"
      ? ["running", "Checking"]
      : state === "applied"
        ? ["ready", "Accepted"]
        : state === "not_applied"
          ? ["rejected", "Not applied"]
          : state === "declined"
            ? ["rejected", "Declined"]
            : state === "stale"
              ? ["rejected", "Out of date"]
              : ["proposed", "Waiting for you"];
  const pending = accept.pending || decline.pending;

  return (
    <div className="app-suggestion">
      <p className="app-suggestion__head">
        <span className="app-suggestion__title">Suggested wording</span> <Badge tone={tone}>{mark}</Badge>
      </p>
      <p className="rs-meta app-suggestion__from">From {coachName ?? "your coach"}</p>
      <SuggestionLines quote={quote} text={comment.body} />
      {state === "waiting" && suggestion?.lastCheck && (
        <p className="rs-meta app-suggestion__note">
          {suggestion.lastCheck === "changed"
            ? "The resume or its facts changed, so this wording wasn’t applied. You can accept again."
            : "The check couldn’t be finished, so nothing changed. You can accept again."}
        </p>
      )}
      <p className="rs-meta app-suggestion__note" role={state === "checking" ? "status" : undefined}>
        {state === "checking"
          ? suggestion?.startUnconfirmed
            ? "Your check was requested, but Resumatic can’t confirm yet that it started. Keep this page open."
            : "Checking this wording against the cited facts…"
          : state === "applied"
            ? suggestion?.appliedVersion !== undefined
              ? `This wording passed the check. It’s in version ${suggestion.appliedVersion} of your resume.`
              : "This wording passed the check and is in your resume."
            : state === "not_applied"
              ? "This wording didn’t pass the check against your confirmed facts, so your resume wasn’t changed."
              : state === "declined"
                ? "You declined this suggestion."
                : state === "stale"
                  ? "This line has changed or been removed since the copy was made, so this can’t be applied."
                  : "If you accept, this wording is checked against the facts this line cites before it replaces the line. A completed check uses one output."}
      </p>
      {(state === "waiting" || state === "stale") && (
        <div className="actions">
          {state === "waiting" && (
            <button type="button" className="rs-btn rs-btn--primary rs-btn--sm" disabled={busy || pending} onClick={() => void start()}>
              {accept.pending ? "Starting…" : "Accept and check"}
            </button>
          )}
          <button type="button" className="rs-btn rs-btn--quiet rs-btn--sm" disabled={pending} onClick={answer}>
            {decline.pending ? "Declining…" : "Decline"}
          </button>
        </div>
      )}
      <ActionError message={accept.error ?? decline.error} />
    </div>
  );
}
