import type { ResumeView } from "../../shared/api";
import { api } from "../api";
import { ResumeSheet } from "../components/ResumeSheet";
import { TailorProgress } from "../components/TailorProgress";
import { ActionError, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useResource } from "../hooks";
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
      {resume.error && <ErrorNote message={resume.error} onRetry={resume.reload} />}
      {!r && !resume.error && <Loading>Loading this resume…</Loading>}
      {r?.state === "running" && <TailorProgress step={r.step} />}
      {r?.state === "failed" && <TailorFailed resume={r} />}
      {r?.state === "ready" &&
        (r.body ? (
          <ResumeSheet resume={r} body={r.body} reload={resume.reload} />
        ) : (
          <ErrorNote message="This resume is marked ready, but it has no content. Try tailoring a new version." />
        ))}
    </>
  );
}

function TailorFailed({ resume }: { resume: ResumeView }) {
  const { tailor, pending, error } = useTailor();

  return (
    <section className="card" aria-labelledby="failed-heading">
      <h2 id="failed-heading">This resume couldn't be finished</h2>
      <p className="failed-reason">{resume.error ?? "Something went wrong while tailoring it."}</p>
      <p className="meta">Resumatic never shows lines that haven't passed its checks, so there's nothing to review from this attempt.</p>
      <div className="actions">
        <button type="button" className="primary" onClick={() => void tailor(resume.applicationId)} disabled={pending}>
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
