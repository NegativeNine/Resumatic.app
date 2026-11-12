import { useId, useState } from "react";
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type ApplicationView,
} from "../../../shared/api";
import { api, ApiError } from "../../api";
import { useAction, type Reload } from "../../hooks";
import { trackingWriteObserved } from "../../tracker-save";
import { ActionError, Field } from "../ui";

/** A job's own tracking statuses, as the person sets them. */
export const APPLICATION_LABELS: Record<ApplicationStatus, string> = {
  saved: "Saved",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  closed: "Closed",
};

/**
 * Where a job stands: its status, the date it was applied for, and the person's notes. What is typed
 * here is kept when the job is read again; only Reload saved details replaces it. A save names the
 * revision it was typed against, and a reply that is lost is accepted only when a fresh read shows
 * the job at the next revision holding exactly what was sent.
 */
export function JobTracking({
  application,
  onSaved,
}: {
  application: ApplicationView;
  onSaved: Reload;
}) {
  const [status, setStatus] = useState<ApplicationStatus>(
    application.status ?? "saved",
  );
  const [appliedAt, setAppliedAt] = useState(application.appliedAt ?? "");
  const [notes, setNotes] = useState(application.notes ?? "");
  const [revision, setRevision] = useState(application.revision);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const id = useId();
  async function save() {
    setSaved(false);
    const ok = await action.run(async () => {
      const submitted = {
        status,
        appliedAt: appliedAt || null,
        notes,
      };
      try {
        await api.updateApplication(application.id, { ...submitted, expectedRevision: revision });
      } catch (error) {
        // The update can commit even when its reply is lost. A retry with the
        // old revision conflicts; reconcile only if the server now has exactly
        // this submission at the next revision. Otherwise preserve the draft.
        if (revision === undefined) throw error;
        let current: ApplicationView | undefined;
        try {
          current = (await api.applications()).applications.find((item) => item.id === application.id);
        } catch (readError) {
          if (readError instanceof ApiError && (readError.status === 401 || readError.status === 410)) throw readError;
          throw error;
        }
        if (!trackingWriteObserved(current, application.id, revision, submitted)) throw error;
      }
      if (revision !== undefined) setRevision(revision + 1);
      await onSaved();
    });
    if (ok) setSaved(true);
  }
  async function reloadTracker() {
    await action.run(async () => {
      const current = (await api.applications()).applications.find(
        (item) => item.id === application.id,
      );
      if (!current) throw new Error("This job can’t be found. It may have been deleted.");
      setStatus(current.status ?? "saved");
      setAppliedAt(current.appliedAt ?? "");
      setNotes(current.notes ?? "");
      setRevision(current.revision);
      setSaved(false);
      await onSaved();
    });
  }
  return (
    <form
      className="rs-panel app-job-tracking"
      aria-labelledby={`${id}-heading`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 id={`${id}-heading`} className="rs-h3">Track this job</h2>
      <div className="field-grid">
        <Field id={`${id}-status`} label="Status">
          <select
            id={`${id}-status`}
            value={status}
            disabled={action.pending}
            onChange={(event) => {
              setStatus(event.target.value as ApplicationStatus);
              setSaved(false);
            }}
          >
            {APPLICATION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {APPLICATION_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-applied`} label="Date applied">
          <input
            id={`${id}-applied`}
            type="date"
            value={appliedAt}
            disabled={action.pending}
            onChange={(event) => {
              setAppliedAt(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
      </div>
      <Field id={`${id}-notes`} label="Your notes">
        <textarea
          id={`${id}-notes`}
          rows={3}
          maxLength={10000}
          value={notes}
          disabled={action.pending}
          onChange={(event) => {
            setNotes(event.target.value);
            setSaved(false);
          }}
          placeholder="Contacts, next steps, or what you want to remember."
        />
      </Field>
      <div className="actions">
        <button
          type="submit"
          className="small"
          disabled={action.pending}
        >
          {action.pending ? "Saving…" : "Save tracking details"}
        </button>
        <button
          type="button"
          className="small"
          disabled={action.pending}
          onClick={() => void reloadTracker()}
        >
          Reload saved details
        </button>
        {saved && (
          <span className="success inline" role="status">
            Saved.
          </span>
        )}
      </div>
      <ActionError message={action.error} />
    </form>
  );
}
