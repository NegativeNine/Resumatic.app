import { useId, useState } from "react";
import {
  MAX_JD_CHARS,
  MAX_JOB_NAME_CHARS,
  MAX_URL_CHARS,
  MIN_JD_CHARS,
  isWebUrl,
  type ApplicationDetail,
  type ApplicationView,
} from "../../shared/api";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";
import { ActionError, CharCount, Field, Glyph, Loading } from "./ui";

/**
 * A saved job's posting: its link, the whole text on request, a form to correct the details, and
 * a way to delete a job that has nothing attached. The posting is the employer's text, so it is
 * plain body type, never a quote.
 */
export function JobPosting({
  application,
  revision,
  onRevision,
  onSaved,
}: {
  application: ApplicationView;
  /** The revision the workspace last saw. Tracking and details share it, so neither goes stale. */
  revision: number | undefined;
  onRevision: (next: number) => void;
  onSaved: Reload;
}) {
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [mode, setMode] = useState<"closed" | "reading" | "editing" | "deleting">("closed");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [link, setLink] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const id = useId();
  const url = link.trim();
  const badLink = url !== "" && !isWebUrl(url);
  const length = text.trim().length;
  const hasResumes = application.resumes.length > 0;

  /** The posting is fetched when it's first asked for, not with the list. */
  async function open(next: "reading" | "editing") {
    setSaved(false);
    if (mode === next) return setMode("closed");
    await action.run(async () => {
      const current = detail ?? (await api.application(application.id));
      setDetail(current);
      if (next === "editing") {
        setTitle(current.title ?? "");
        setCompany(current.company ?? "");
        setLink(current.url ?? "");
        setText(current.jdText);
      }
      setMode(next);
    });
  }

  async function save() {
    setSaved(false);
    let done = false;
    await action.run(async () => {
      const posting = text.trim();
      await api.updateApplication(application.id, {
        title: title.trim(),
        company: company.trim(),
        url,
        // Unchanged text isn't sent, so details can be corrected while a resume is being tailored.
        ...(detail && posting !== detail.jdText ? { jdText: posting } : {}),
        expectedRevision: revision,
      });
      if (revision !== undefined) onRevision(revision + 1);
      setDetail(null);
      done = true;
      await onSaved();
    });
    if (done) {
      setMode("closed");
      setSaved(true);
    }
  }

  async function remove() {
    await action.run(async () => {
      await api.deleteApplication(application.id);
      await onSaved();
    });
  }

  return (
    <section className="workspace-section app-posting" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>The posting</h3>
      <div className="actions">
        {application.url && (
          <a className="rs-btn rs-btn--sm" href={application.url} target="_blank" rel="noreferrer noopener">
            Open the original posting
          </a>
        )}
        <button type="button" className="small" aria-expanded={mode === "reading"} disabled={action.pending} onClick={() => void open("reading")}>
          {mode === "reading" ? "Hide the posting" : "Read the posting"}
        </button>
        <button type="button" className="small" aria-expanded={mode === "editing"} disabled={action.pending} onClick={() => void open("editing")}>
          {mode === "editing" ? "Close details" : "Edit details"}
        </button>
        {!hasResumes && mode !== "deleting" && (
          <button type="button" className="small" disabled={action.pending} onClick={() => { setSaved(false); setMode("deleting"); }}>
            Delete job
          </button>
        )}
      </div>
      {hasResumes && <p className="rs-meta app-posting__note">A job with resumes can’t be deleted. Mark it Closed instead.</p>}
      {action.pending && mode === "closed" && <Loading>Loading the posting…</Loading>}
      {saved && (
        <p className="rs-success" role="status">
          <Glyph name="check" />
          Saved.
        </p>
      )}

      {mode === "reading" && detail && (
        <div className="app-posting__text" tabIndex={0} role="group" aria-label="The posting’s text">
          {detail.jdText}
        </div>
      )}

      {mode === "editing" && detail && (
        <form
          className="app-posting__form"
          aria-label="Job details"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="field-grid">
            <Field id={`${id}-title`} label="Job title" optional>
              <input id={`${id}-title`} type="text" maxLength={MAX_JOB_NAME_CHARS} value={title} disabled={action.pending} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field id={`${id}-company`} label="Company" optional>
              <input id={`${id}-company`} type="text" maxLength={MAX_JOB_NAME_CHARS} value={company} disabled={action.pending} onChange={(event) => setCompany(event.target.value)} />
            </Field>
          </div>
          <Field id={`${id}-link`} label="Link to the posting" optional error={badLink ? "Enter a web address that starts with https://" : undefined}>
            <input
              id={`${id}-link`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_URL_CHARS}
              value={link}
              disabled={action.pending}
              placeholder="https://"
              onChange={(event) => setLink(event.target.value)}
              aria-invalid={badLink}
              aria-describedby={badLink ? `${id}-link-error` : undefined}
            />
          </Field>
          <Field
            id={`${id}-text`}
            label="Job description"
            hint="Resumes already tailored keep the posting they were written for."
          >
            <textarea
              id={`${id}-text`}
              rows={8}
              value={text}
              disabled={action.pending}
              onChange={(event) => setText(event.target.value)}
              aria-describedby={`${id}-text-hint ${id}-text-count`}
              aria-invalid={length > MAX_JD_CHARS}
            />
          </Field>
          <CharCount id={`${id}-text-count`} length={length} max={MAX_JD_CHARS} />
          <div className="actions">
            <button type="submit" className="small primary" disabled={action.pending || badLink || length < MIN_JD_CHARS || length > MAX_JD_CHARS}>
              {action.pending ? "Saving…" : "Save details"}
            </button>
            <button type="button" className="small" disabled={action.pending} onClick={() => setMode("closed")}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === "deleting" && (
        <div className="rs-well app-posting__confirm" role="group" aria-label="Delete this job">
          <p>Delete this job? Its posting, tracking details and notes are removed, and this can’t be undone.</p>
          <div className="actions">
            <button type="button" className="rs-btn rs-btn--danger rs-btn--sm" disabled={action.pending} onClick={() => void remove()}>
              {action.pending ? "Deleting…" : "Delete job"}
            </button>
            <button type="button" className="small" disabled={action.pending} onClick={() => setMode("closed")}>
              Keep it
            </button>
          </div>
        </div>
      )}
      <ActionError message={action.error} />
    </section>
  );
}
