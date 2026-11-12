import { useId, useRef, useState } from "react";
import {
  MAX_JD_CHARS,
  MAX_JOB_NAME_CHARS,
  MAX_URL_CHARS,
  MIN_JD_CHARS,
  isWebUrl,
  type ApplicationDetail,
} from "../../../shared/api";
import { api } from "../../api";
import { useAction } from "../../hooks";
import { href, navigate } from "../../router";
import { ActionError, CharCount, Field, Glyph } from "../ui";

/**
 * Correcting a job's details, and deleting a job that has nothing attached. The form starts from
 * the job as the page last read it, and its save names that revision. The job description is sent
 * only when it changed, so a name can be corrected while a resume is being tailored.
 * `onSaved` reads the job again; `onDescriptionSaved` says the description itself was replaced.
 */
export function JobDetails({
  job,
  onSaved,
  onDescriptionSaved,
}: {
  job: ApplicationDetail;
  onSaved: () => Promise<unknown>;
  onDescriptionSaved: () => void;
}) {
  const [mode, setMode] = useState<"closed" | "editing" | "deleting">("closed");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [link, setLink] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const id = useId();
  const edit = useRef<HTMLButtonElement>(null);
  const url = link.trim();
  const badLink = url !== "" && !isWebUrl(url);
  const length = text.trim().length;

  function open() {
    setSaved(false);
    if (mode === "editing") return setMode("closed");
    setTitle(job.title ?? "");
    setCompany(job.company ?? "");
    setLink(job.url ?? "");
    setText(job.jdText);
    setMode("editing");
  }

  function close() {
    setMode("closed");
    edit.current?.focus();
  }

  async function save() {
    setSaved(false);
    const description = text.trim();
    const replaced = description !== job.jdText;
    const ok = await action.run(async () => {
      await api.updateApplication(job.id, {
        title: title.trim(),
        company: company.trim(),
        url,
        // Unchanged text isn't sent, so details can be corrected while a resume is being tailored.
        ...(replaced ? { jdText: description } : {}),
        expectedRevision: job.revision,
      });
      if (replaced) onDescriptionSaved();
      await onSaved();
    });
    if (ok) {
      close();
      setSaved(true);
    }
  }

  async function remove() {
    const ok = await action.run(async () => {
      await api.deleteApplication(job.id);
    });
    if (ok) navigate(href.jobs);
  }

  return (
    <div className="app-job-details">
      <div className="actions">
        <button type="button" className="small" ref={edit} aria-expanded={mode === "editing"} disabled={action.pending} onClick={open}>
          Edit details
        </button>
        {job.canDelete && mode !== "deleting" && (
          <button type="button" className="small" disabled={action.pending} onClick={() => { setSaved(false); setMode("deleting"); }}>
            Delete job
          </button>
        )}
      </div>
      {!job.canDelete && <p className="rs-meta">A job with resumes or documents can’t be deleted. Mark it Closed instead.</p>}
      {saved && (
        <p className="rs-success" role="status">
          <Glyph name="check" />
          Saved.
        </p>
      )}

      {mode === "editing" && (
        <form
          className="app-job-details__form"
          aria-label="Job details"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !action.pending) {
              event.preventDefault();
              close();
            }
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
          <Field id={`${id}-link`} label="Link to the job" optional error={badLink ? "Enter a web address that starts with https://" : undefined}>
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
            hint="Resumes, letters and fit checks already made keep the job description they were made from."
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
            <button type="button" className="small" disabled={action.pending} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === "deleting" && (
        <div className="rs-well app-job-details__confirm" role="group" aria-label="Delete this job">
          <p>Delete this job? Its job description, tracking details and notes are removed, and this can’t be undone.</p>
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
    </div>
  );
}
