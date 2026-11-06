import { useId, useState } from "react";
import type { ResumeView } from "../../shared/api";
import { api } from "../api";
import { ResumeSheet } from "../components/ResumeSheet";
import { ApplicationDocuments } from "../components/Documents";
import { TailorProgress } from "../components/TailorProgress";
import { ActionError, ErrorNote, Loading, PageHeader } from "../components/ui";
import { formatDateTime } from "../format";
import { useResource, type Reload } from "../hooks";
import { href } from "../router";
import { useTailor } from "../tailor";

export function ResumePage({ id }: { id: string }) {
  const resume = useResource(
    () => api.resume(id),
    (r) => r.state === "running",
  );
  const r = resume.data;

  return (
    <>
      <p className="back-link">
        <a href={href.applications}>
          <span aria-hidden="true">← </span>Back to applications
        </a>
      </p>
      <PageHeader title="Tailored resume" />
      {resume.error && (
        <ErrorNote message={resume.error} onRetry={resume.reload} />
      )}
      {!r && !resume.error && <Loading>Loading this resume…</Loading>}
      {r?.state === "running" && <TailorProgress step={r.step} dispatchUncertain={r.dispatchUncertain} cancellationPending={r.cancellationPending} />}
      {r?.state === "failed" && <TailorFailed resume={r} />}
      {r?.state === "ready" &&
        (r.body ? (
          <ReadyResume key={r.id} resume={r} reload={resume.reload} />
        ) : (
          <ErrorNote message="This resume is marked ready, but it has no content. Try tailoring a new version." />
        ))}
    </>
  );
}

function ReadyResume({
  resume,
  reload,
}: {
  resume: ResumeView;
  reload: Reload;
}) {
  const versions = useResource(() => api.resumeVersions(resume.id));
  const [version, setVersion] = useState<number | undefined>();
  const id = useId();
  const refresh = async () => {
    await Promise.all([reload(), versions.reload()]);
  };
  return (
    <>
      <div className="version-picker">
        <label htmlFor={id}>Saved version</label>
        <select
          id={id}
          value={version ?? "latest"}
          onChange={(event) =>
            setVersion(
              event.target.value === "latest"
                ? undefined
                : Number(event.target.value),
            )
          }
        >
          <option value="latest">Latest · version {resume.version}</option>
          {(versions.data?.versions ?? [])
            .filter((saved) => saved.version !== resume.version)
            .sort((a, b) => b.version - a.version)
            .map((saved) => (
              <option key={saved.version} value={saved.version}>
                Version {saved.version} · {formatDateTime(saved.createdAt)}
              </option>
            ))}
        </select>
        {resume.provenance === "legacy" && (
          <span className="meta">
            Created before saved evidence snapshots were available.
          </span>
        )}
      </div>
      {versions.error && (
        <ErrorNote message={versions.error} onRetry={versions.reload} />
      )}
      {version === undefined ? (
        <>
          <ResumeSheet
            key={resume.version}
            resume={resume}
            body={resume.body!}
            reload={refresh}
          />
          <ApplicationDocuments
            applicationId={resume.applicationId}
            resume={resume}
            onUpdated={refresh}
          />
        </>
      ) : (
        <>
          <p className="notice">
            This is a saved version. Its downloads use the wording and evidence
            saved with it. Select Latest to edit or refine.
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
      <h2 id="failed-heading">This resume couldn't be finished</h2>
      <p className="failed-reason">
        {resume.error ?? "Something went wrong while tailoring it."}
      </p>
      <p className="meta">
        Resumatic never shows lines that haven't passed its checks, so there's
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
        <a className="button" href={href.applications}>
          Back to applications
        </a>
      </div>
      <ActionError message={error} />
    </section>
  );
}
