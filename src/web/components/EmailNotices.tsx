import { useId, type ReactNode } from "react";
import { NOTICE_KINDS, type EmailNotices as Settings, type NoticeKind } from "../../shared/email-notices";
import { api, ApiError } from "../api";
import { useAction, useResource } from "../hooks";
import { sessionEndNote } from "../session";
import { ActionError, ErrorNote, Loading, Message } from "./ui";

// The email notices on Account, under Notifications, shown only where the deployment sends them.
// Each kind is turned on or off by itself, and a notice goes to the address this session signed in
// with. What a notice says is fixed, and this card says so.

const LABEL: Record<NoticeKind, string> = {
  comment: "A coach comments on a copy you shared",
  suggestion: "A coach suggests wording for a line",
  reminder: "Facts have waited 3 days for you to check them",
};
const REMINDER_HINT = "Once a week at most, while they wait.";
const CONTENT =
  "A notice says only that there’s something new to see, with a link to Resumatic. It never holds a comment, suggested wording, a fact, a job or anyone’s name.";
const NO_ADDRESS = "Sign out, then sign in again to turn on email notices.";
const FAILING =
  "The last email notice couldn’t be sent. Your notices stay on, and anything new still shows in Resumatic when you sign in.";
const PAUSED =
  "Email notices are paused because the address you sign in with has changed. Anything new still shows in Resumatic when you sign in.";
/** The card's own words for a change that didn't take. The server's detail is never shown. */
const REFUSED = "This notice couldn’t be changed. Try again.";

/** `children` go last, under the notices: what isn't built yet, behind More choices. */
export function EmailNotices({ children }: { children?: ReactNode }) {
  const notices = useResource(api.emailNotices);
  const id = useId();
  return (
    <section className="card app-email-notices" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Notifications</h2>
      {notices.error ? (
        <ErrorNote message={notices.error} onRetry={notices.reload} />
      ) : !notices.data ? (
        <Loading>Loading your email notices…</Loading>
      ) : (
        <NoticeForm settings={notices.data} reload={notices.reload} titleId={`${id}-title`} />
      )}
      {children}
    </section>
  );
}

function NoticeForm({ settings, reload, titleId }: { settings: Settings; reload: () => Promise<unknown>; titleId: string }) {
  const action = useAction();
  const id = useId();
  const address = settings.address;

  async function change(kind: NoticeKind, on: boolean) {
    let ended = false;
    await action.run(
      async () => {
        try {
          await api.setEmailNotice(kind, on);
        } catch (error) {
          ended = sessionEndNote(error) !== null;
          if (ended) throw error;
          throw new ApiError(422, "refused", REFUSED);
        }
      },
      { refused: REFUSED },
    );
    // Whatever else happened, the card shows what is saved. Setting a kind again is harmless, so
    // the person can simply try again from there.
    if (!ended) await reload();
  }

  return (
    <>
      {address ? (
        <p className="card-text meta">
          Notices go to the address you sign in with, {address}. You get at most one of each kind a day.
        </p>
      ) : (
        <Message tone="info" live={false}>
          {NO_ADDRESS}
        </Message>
      )}
      <p className="card-text">{CONTENT}</p>
      {settings.status === "paused" ? (
        <Message tone="info" live={false}>
          {PAUSED}
        </Message>
      ) : settings.status === "failing" ? (
        <Message tone="info" live={false}>
          {FAILING}
        </Message>
      ) : null}
      <div role="group" aria-labelledby={titleId} aria-busy={action.pending}>
        <div className="app-email-notices__checks">
          {NOTICE_KINDS.map((kind) => (
            <div key={kind}>
              <label>
                <input
                  type="checkbox"
                  checked={settings[kind]}
                  disabled={!address || action.pending}
                  onChange={(event) => void change(kind, event.target.checked)}
                  aria-describedby={kind === "reminder" ? `${id}-reminder-hint` : undefined}
                />
                <span>{LABEL[kind]}</span>
              </label>
              {kind === "reminder" && (
                <p className="rs-hint" id={`${id}-reminder-hint`}>
                  {REMINDER_HINT}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
      <ActionError message={action.error} />
    </>
  );
}
