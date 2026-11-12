import { useCallback, useState } from "react";
import type { ApplicationDetail, ResumeView } from "../../../shared/api";
import { api, ApiError } from "../../api";
import { APPLICATION_LABELS } from "../../components/jobs/JobTracking";
import { Badge, ErrorNote, Loading } from "../../components/ui";
import { formatDate } from "../../format";
import { useResource, type Resource } from "../../hooks";
import { href, JOB_TABS, useCanonicalResumeAddress, type JobTab } from "../../router";
import { useSession } from "../../session";
import { JobApplication } from "./JobApplication";
import { JobFit } from "./JobFit";
import { JobInterview } from "./JobInterview";
import { JobLetter } from "./JobLetter";
import { JobResume } from "./JobResume";
import "../../styles/rooms/jobs.css";

// A job's own page: its name, its company and status, and five tabs, Fit, Resume, Cover letter,
// Interview and Application. The job is read once for the page and moving between its tabs neither
// reads it again nor moves focus: the tabs share the page's address key. A resume's own address is
// another page, so opening one moves focus to it.

const TAB_LABELS: Readonly<Record<JobTab, string>> = {
  fit: "Fit",
  resume: "Resume",
  letter: "Cover letter",
  interview: "Interview",
  application: "Application",
};

/** What a tab says first, under the tabs. */
const TAB_LEDES: Readonly<Record<JobTab, string>> = {
  fit: "How your confirmed facts cover what this job asks for. Checking is free and changes nothing.",
  resume: "Resumes tailored to this job from your confirmed facts, every line checked.",
  letter: "Letters written from your confirmed facts. Each finished one counts as one document.",
  interview: "Answers to likely questions, from your confirmed facts. Each finished one counts as one document.",
  application: "What you’ll send, and where this job stands. You send it yourself.",
};

/** A job, or null when the vault has no such job: it was deleted, or never was this person's. */
type JobRead = ApplicationDetail | null;

const isTailoring = (job: JobRead) => !!job?.resumes.some((resume) => resume.state === "running");

/**
 * A job's page, on one of its tabs. With `resumeId` (a resume's own address), the resume is read
 * first and the job is the one it says it belongs to, so an address naming the wrong job never
 * shows the wrong job's name, and the resume is read once.
 */
export function JobPage({ id, tab, resumeId }: { id?: string; tab: JobTab; resumeId?: string }) {
  // The way back stays put while the page fills in, so focus on it isn't lost.
  return (
    <>
      <p className="back-link">
        <a href={href.jobs}>
          <span aria-hidden="true">← </span>Back to Jobs
        </a>
      </p>
      {resumeId !== undefined ? <ResumeAddress resumeId={resumeId} /> : <JobFrame key={id} jobId={id!} tab={tab} />}
    </>
  );
}

function ResumeAddress({ resumeId }: { resumeId: string }) {
  const resume = useResource(
    () => api.resume(resumeId),
    (r) => r.state === "running",
  );
  // An old link names no job, and a link can name the wrong one: once the resume says, the address does too.
  useCanonicalResumeAddress(resume.data);
  const jobId = resume.data?.applicationId;
  if (!jobId) return resume.error ? <ErrorNote message={resume.error} onRetry={resume.reload} /> : <Loading>Loading this resume…</Loading>;
  return <JobFrame key={jobId} jobId={jobId} tab="resume" resume={resume} />;
}

function JobFrame({ jobId, tab, resume }: { jobId: string; tab: JobTab; resume?: Resource<ResumeView> }) {
  const { me } = useSession();
  const job = useResource<JobRead>(async () => {
    try {
      return await api.application(jobId);
    } catch (error) {
      // A job that isn't there is said in the page's own words, with the way back.
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, isTailoring);
  // The fit checks there were when the job description was last saved on this visit, so each of them
  // says it was made before. They are told apart by ID: the vault's clock and this device's can differ.
  const [fitsBeforeDescription, setFitsBeforeDescription] = useState<ReadonlySet<string> | null>(null);
  const described = useCallback((fitIds: ReadonlySet<string>) => setFitsBeforeDescription(fitIds), []);
  const data = job.data;

  if (data === null)
    return (
      <div className="page-head">
        <h1 className="rs-h1">Job not found</h1>
        <p className="rs-lede">This job can’t be found. It may have been deleted.</p>
      </div>
    );
  if (!data) return job.error ? <ErrorNote message={job.error} onRetry={job.reload} /> : <Loading>Loading this job…</Loading>;

  const unnamed = !data.title && !data.company;
  return (
    <>
      <div className="page-head app-job-page-head">
        <h1 className="rs-h1">{data.title ?? "Untitled job"}</h1>
        <p className="rs-meta app-meta-row app-job-meta">
          {data.company && <span>{data.company}</span>}
          <Badge tone="status">{APPLICATION_LABELS[data.status ?? "saved"]}</Badge>
          <span>Added {formatDate(data.createdAt)}</span>
          {data.url && (
            <a href={data.url} target="_blank" rel="noreferrer noopener">
              Open the job’s page
            </a>
          )}
          {unnamed && <span>It’s named from its job description when a resume is tailored, or name it under Edit details.</span>}
        </p>
      </div>
      <nav className="app-job-tabs" aria-label="This job">
        <ul className="app-tabs app-tabs--page">
          {JOB_TABS.map((name) => (
            <li key={name}>
              <a href={href.job(data.id, name)} aria-current={name === tab ? "page" : undefined}>
                {TAB_LABELS[name]}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <p className="rs-lede app-job-lede">{TAB_LEDES[tab]}</p>
      {/* Each tab is keyed by the person and the tab: one person's start guard is never another's. */}
      <div className="app-job-tab" key={`${me.userId}:${tab}`}>
        {tab === "fit" && <JobFit job={data} reload={job.reload} fitsBeforeDescription={fitsBeforeDescription} onDescriptionSaved={described} />}
        {tab === "resume" && <JobResume job={data} reloadJob={job.reload} resume={resume} />}
        {tab === "letter" && <JobLetter job={data} />}
        {tab === "interview" && <JobInterview job={data} />}
        {tab === "application" && <JobApplication job={data} reload={job.reload} />}
      </div>
    </>
  );
}
