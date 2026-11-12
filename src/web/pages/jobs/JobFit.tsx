import { useId } from "react";
import type { ApplicationDetail } from "../../../shared/api";
import type { DocumentKind } from "../../../shared/documents";
import { DocumentList, runningElsewhere, StartNotes, useJobDocuments } from "../../components/Documents";
import { JobDetails } from "../../components/jobs/JobDetails";
import { Message } from "../../components/ui";

// A job's Fit tab: how the person's record covers what the job asks for, checked only when they ask;
// the experience questions that find what may be missing; and the job description itself, which is
// the employer's text, shown as plain text and never as a quote or as evidence.

const FIT: readonly DocumentKind[] = ["fit", "questions"];

export function JobFit({
  job,
  reload,
  fitsBeforeDescription,
  onDescriptionSaved,
}: {
  job: ApplicationDetail;
  reload: () => Promise<unknown>;
  /** The fit checks, running or done, there were when the job description was saved on this visit, if it was. */
  fitsBeforeDescription: ReadonlySet<string> | null;
  onDescriptionSaved: (fitIds: ReadonlySet<string>) => void;
}) {
  const jobDocs = useJobDocuments(job.id);
  const id = useId();
  const elsewhere = runningElsewhere(jobDocs, FIT);
  const off = jobDocs.action.pending || jobDocs.running;
  const describedBy = elsewhere ? `${id}-elsewhere` : undefined;
  const fits = jobDocs.docs.filter((doc) => doc.kind === "fit" && doc.state === "ready").sort((a, b) => b.createdAt - a.createdAt);
  const newest = fits[0];
  const changedSince = newest !== undefined && !!fitsBeforeDescription?.has(newest.id);

  return (
    <>
      <section className="section app-job-section" aria-labelledby={`${id}-fit`}>
        <h2 id={`${id}-fit`}>How your record covers this job</h2>
        <div className="actions">
          {/* Checking fit isn't counted, so it stays on when the documents are used up. */}
          <button type="button" className="primary" disabled={off} aria-describedby={describedBy} onClick={() => void jobDocs.start({ kind: "fit" })}>
            {newest ? "Check again" : "Check your fit"}
          </button>
        </div>
        <StartNotes id={`${id}-elsewhere`} jobDocs={jobDocs} kinds={FIT} counted={false} />
        {changedSince && (
          <Message tone="info">You changed the job description after this check. Check again to see how your record covers it.</Message>
        )}
        <DocumentList jobDocs={jobDocs} kinds={["fit"]} open="newest" />
      </section>

      <section className="section app-job-section" aria-labelledby={`${id}-questions`}>
        <h2 id={`${id}-questions`}>Find missing experience</h2>
        <p className="rs-meta">
          Questions about what this job asks for that your record may not show yet. Answer only from your own experience.
          Finding them is free.
        </p>
        <div className="actions">
          <button type="button" disabled={off} aria-describedby={describedBy} onClick={() => void jobDocs.start({ kind: "questions" })}>
            Find missing experience
          </button>
        </div>
        <DocumentList jobDocs={jobDocs} kinds={["questions"]} open="newest" />
      </section>

      {/* Not a region of its own: the description in it is the one region of that name. */}
      <section className="section app-job-section">
        <h2>Job description</h2>
        <div className="rs-well app-job-description" role="region" aria-label="Job description" tabIndex={0}>
          {job.jdText}
        </div>
        <JobDetails
          job={job}
          onSaved={reload}
          onDescriptionSaved={() => onDescriptionSaved(new Set(jobDocs.docs.filter((doc) => doc.kind === "fit").map((doc) => doc.id)))}
        />
      </section>
    </>
  );
}
