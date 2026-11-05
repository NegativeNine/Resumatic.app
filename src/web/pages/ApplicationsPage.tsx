import { useId, useState } from "react";
import { MAX_JD_CHARS, type ApplicationView } from "../../shared/api";
import { api } from "../api";
import { ActionError, Badge, CharCount, ErrorNote, Loading, PageHeader } from "../components/ui";
import { formatDate, formatDateTime, RESUME_STATE_LABEL } from "../format";
import { useAction, useResource, type Reload } from "../hooks";
import { href } from "../router";
import { useSession } from "../session";
import { quotaMessage, useTailor } from "../tailor";

const isTailoring = (data: { applications: ApplicationView[] }) =>
  data.applications.some((a) => a.resumes.some((r) => r.state === "running"));

export function ApplicationsPage() {
  const list = useResource(api.applications, isTailoring);
  const { quota } = useSession().me;
  const applications = [...(list.data?.applications ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <PageHeader title="Applications">
        Paste a job description, then tailor a resume to it. Every line comes from facts you've confirmed under{" "}
        <a href={href.sources}>Sources & facts</a>.
      </PageHeader>
      {quota.used >= quota.limit && <p className="notice">{quotaMessage(quota)}</p>}

      <section className="section" aria-labelledby="job-heading">
        <h2 id="job-heading">Add a job</h2>
        <JobForm onSaved={list.reload} />
      </section>

      <section className="section" aria-labelledby="applications-heading">
        <h2 id="applications-heading">Your applications</h2>
        {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
        {!list.data && !list.error && <Loading>Loading your applications…</Loading>}
        {list.data &&
          (applications.length === 0 ? (
            <p className="empty">No applications yet. Paste a job description above to start your first one.</p>
          ) : (
            <ul className="plain-list">
              {applications.map((application) => (
                <ApplicationCard key={application.id} application={application} />
              ))}
            </ul>
          ))}
      </section>
    </>
  );
}

function JobForm({ onSaved }: { onSaved: Reload }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const { run, pending, error } = useAction();
  const id = useId();
  const length = text.trim().length;
  const tooLong = length > MAX_JD_CHARS;

  async function save() {
    setSaved(false);
    const ok = await run(async () => {
      await api.addApplication(text.trim());
      await onSaved();
    });
    if (ok) {
      setText("");
      setSaved(true);
    }
  }

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id}>Job description</label>
      <p className="hint" id={`${id}-hint`}>
        Paste the whole posting, including the requirements.
      </p>
      <textarea
        id={id}
        rows={10}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        aria-describedby={`${id}-hint ${id}-count`}
        aria-invalid={tooLong}
      />
      <div className="row-between form-foot">
        <CharCount id={`${id}-count`} length={length} max={MAX_JD_CHARS} />
        <button type="submit" className="primary" disabled={pending || length === 0 || tooLong}>
          {pending ? "Saving…" : "Save job"}
        </button>
      </div>
      {saved && (
        <p className="success" role="status">
          Saved. Tailor a resume to it from the list below.
        </p>
      )}
      <ActionError message={error} />
    </form>
  );
}

function jobName({ title, company, excerpt }: ApplicationView): string {
  if (title && company) return `${title} at ${company}`;
  return title ?? company ?? (excerpt || "Untitled job");
}

function ApplicationCard({ application }: { application: ApplicationView }) {
  const { tailor, pending, error } = useTailor();
  const headingId = useId();
  const resumes = [...application.resumes].sort((a, b) => b.createdAt - a.createdAt);
  const unnamed = !application.title && !application.company;

  return (
    <li className="card application">
      <div className="row-between">
        <div>
          <h3 id={headingId}>{jobName(application)}</h3>
          <p className="meta">
            Added {formatDate(application.createdAt)}
            {unnamed && " · The title and company appear once a resume has been tailored"}
          </p>
        </div>
        <button
          type="button"
          className="primary"
          onClick={() => void tailor(application.id)}
          disabled={pending}
          aria-describedby={headingId}
        >
          {pending ? "Starting…" : "Tailor a resume"}
        </button>
      </div>
      <ActionError message={error} />
      {resumes.length === 0 ? (
        <p className="meta resume-list-empty">No resumes yet.</p>
      ) : (
        <ul className="plain-list resume-list">
          {resumes.map((resume) => (
            <li key={resume.id}>
              <a href={href.resume(resume.id)}>Resume tailored {formatDateTime(resume.createdAt)}</a>
              <Badge tone={resume.state}>{RESUME_STATE_LABEL[resume.state]}</Badge>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
