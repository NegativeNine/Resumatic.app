import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ResumeView } from "../../shared/api";
import { api } from "../api";
import { ResumeSheet } from "../components/ResumeSheet";
import { ApplicationDocuments } from "../components/Documents";
import { TailorProgress } from "../components/TailorProgress";
import { ActionError, ErrorNote, Loading, PageHeader } from "../components/ui";
import { formatDateTime } from "../format";
import { useAction, useResource, type Reload } from "../hooks";
import { href, useCanonicalResumeAddress } from "../router";
import { resumeErrorMessage } from "../source-error";
import { useTailor } from "../tailor";
import { useSession } from "../session";

export function ResumePage({ id }: { id: string }) {
  const resume = useResource(
    () => api.resume(id),
    (r) => r.state === "running",
  );
  const r = resume.data;
  // An old link names no job: once the resume says which it is for, the address does too.
  useCanonicalResumeAddress(r);
  const { refreshMe } = useSession();
  const wasRunning = useRef(false);
  // Set once this page watches the resume finish, so the margin's marks tick in once; never on a later visit.
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (r && wasRunning.current && r.state !== "running") {
      void refreshMe();
      if (r.state === "ready") setFresh(true);
    }
    wasRunning.current = r?.state === "running";
  }, [r, refreshMe]);

  return (
    <>
      <p className="back-link">
        <a href={href.jobs}>
          <span aria-hidden="true">← </span>Back to Jobs
        </a>
      </p>
      <PageHeader title="Tailored resume" />
      {resume.error && (
        <ErrorNote message={resume.error} onRetry={resume.reload} />
      )}
      {!r && !resume.error && <Loading>Loading this resume…</Loading>}
      {r?.state === "running" && <RunningResume resume={r} reload={resume.reload} />}
      {r?.state === "failed" && <TailorFailed resume={r} />}
      {r?.state === "ready" &&
        (r.body ? (
          <ReadyResume key={r.id} resume={r} reload={resume.reload} fresh={fresh} />
        ) : (
          <ErrorNote message="This resume is marked ready, but it has no content. Try tailoring a new version." />
        ))}
    </>
  );
}

function RunningResume({ resume, reload }: { resume: ResumeView; reload: Reload }) {
  const cancel = useAction();
  return (
    <>
      <TailorProgress step={resume.step} dispatchUncertain={resume.dispatchUncertain} cancellationPending={resume.cancellationPending} />
      {!resume.cancellationPending && (
        <button type="button" className="small app-cancel-run" disabled={cancel.pending} onClick={() => void cancel.run(async () => {
          await api.cancelResume(resume.id);
          await reload();
        })}>
          {cancel.pending ? "Stopping…" : "Cancel tailoring"}
        </button>
      )}
      <ActionError message={cancel.error} />
    </>
  );
}

function ReadyResume({
  resume,
  reload,
  fresh,
}: {
  resume: ResumeView;
  reload: Reload;
  fresh: boolean;
}) {
  const versions = useResource(() => api.resumeVersions(resume.id));
  const [version, setVersion] = useState<number | undefined>();
  // A newer version can arrive while a line editor is open. Retain the
  // rendered version until every editor closes so the user's draft survives.
  const [editing, setEditing] = useState<{ snapshot: ResumeView; ids: Set<string> } | null>(null);
  const latestResume = useRef(resume);
  latestResume.current = resume;
  const editingChanged = useCallback((id: string, active: boolean) => {
    const openedVersion = latestResume.current;
    setEditing((previous) => {
      if (active) {
        const ids = new Set(previous?.ids ?? []);
        ids.add(id);
        return { snapshot: previous?.snapshot ?? openedVersion, ids };
      }
      if (!previous) return null;
      const ids = new Set(previous.ids);
      ids.delete(id);
      return ids.size ? { ...previous, ids } : null;
    });
  }, []);
  const id = useId();
  const refresh = useCallback(async () => {
    await Promise.all([reload(), versions.reload()]);
  }, [reload, versions.reload]);
  const displayed = editing?.snapshot ?? resume;
  const editingOutdated = !!editing && editing.snapshot.version !== resume.version;
  return (
    <>
      <div className="version-picker">
        <label htmlFor={id}>Saved version</label>
        <select
          id={id}
          value={version ?? "latest"}
          disabled={!!editing}
          onChange={(event) =>
            setVersion(
              event.target.value === "latest"
                ? undefined
                : Number(event.target.value),
            )
          }
        >
          <option value="latest">Latest (version {resume.version})</option>
          {(versions.data?.versions ?? [])
            .filter((saved) => saved.version !== resume.version)
            .sort((a, b) => b.version - a.version)
            .map((saved) => (
              <option key={saved.version} value={saved.version}>
                Version {saved.version}, saved {formatDateTime(saved.createdAt)}
              </option>
            ))}
        </select>
        {resume.provenance === "legacy" && (
          <span className="meta">
            Created before Resumatic saved where each line came from.
          </span>
        )}
      </div>
      {versions.error && (
        <ErrorNote message={versions.error} onRetry={versions.reload} />
      )}
      {editing && <p className="hint">Finish or cancel your line edits to change saved versions.</p>}
      {editingOutdated && <p className="notice" role="status">A newer resume version is available. Your draft is still here; copy it, then cancel the edit to view the latest version.</p>}
      {version === undefined ? (
        <>
          <ResumeSheet
            key={displayed.version}
            resume={displayed}
            body={displayed.body!}
            reload={refresh}
            onLineEditingChange={editingChanged}
            editingOutdated={editingOutdated}
            fresh={fresh}
          />
          <ApplicationDocuments
            applicationId={resume.applicationId}
            resume={resume}
            onUpdated={refresh}
            panel
          />
        </>
      ) : (
        <>
          <p className="notice">
            This is a saved version. Its downloads use its wording and the facts it
            was checked against, as saved. Select Latest to edit or refine.
          </p>
          <ArchivedResume
            key={`${resume.id}:${version}`}
            id={resume.id}
            version={version}
          />
        </>
      )}
    </>
  );
}

function ArchivedResume({ id, version }: { id: string; version: number }) {
  const saved = useResource(() => api.resume(id, version));
  if (saved.error)
    return <ErrorNote message={saved.error} onRetry={saved.reload} />;
  if (!saved.data) return <Loading>Loading saved version…</Loading>;
  return saved.data.body ? (
    <ResumeSheet
      resume={saved.data}
      body={saved.data.body}
      reload={saved.reload}
      readOnly
    />
  ) : (
    <ErrorNote message="This version has no saved content." />
  );
}

function TailorFailed({ resume }: { resume: ResumeView }) {
  const { tailor, pending, error } = useTailor();

  return (
    <section className="card" aria-labelledby="failed-heading">
      <h2 id="failed-heading">This resume couldn’t be finished</h2>
      <p className="failed-reason">
        {resumeErrorMessage(resume.error)}
      </p>
      <p className="meta">
        Resumatic never shows lines that haven’t passed its checks, so there’s
        nothing to review from this attempt.
      </p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => void tailor(resume.applicationId)}
          disabled={pending}
        >
          {pending ? "Starting…" : "Tailor again"}
        </button>
        <a className="button" href={href.jobs}>
          Back to Jobs
        </a>
      </div>
      <ActionError message={error} />
    </section>
  );
}
