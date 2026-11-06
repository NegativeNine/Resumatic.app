import { useId, useState } from "react";
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type ApplicationView,
} from "../../shared/api";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";
import { ApplicationDocuments } from "./Documents";
import { ActionError, Field } from "./ui";
import "./workspace.css";

export const APPLICATION_LABELS: Record<ApplicationStatus, string> = {
  saved: "Saved",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  closed: "Closed",
};

export function ApplicationWorkspace({
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
      await api.updateApplication(application.id, {
        status,
        appliedAt: appliedAt || null,
        notes,
        expectedRevision: revision,
      });
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
      if (!current) throw new Error("This application is no longer available.");
      setStatus(current.status ?? "saved");
      setAppliedAt(current.appliedAt ?? "");
      setNotes(current.notes ?? "");
      setRevision(current.revision);
      setSaved(false);
      await onSaved();
    });
  }
  return (
    <div className="application-workspace">
      <form
        className="workspace-section"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h3>Track this application</h3>
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
            className="small primary"
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
      <ApplicationDocuments applicationId={application.id} />
    </div>
  );
}
