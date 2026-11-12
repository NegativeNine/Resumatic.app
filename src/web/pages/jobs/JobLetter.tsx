import { useId } from "react";
import type { ApplicationDetail } from "../../../shared/api";
import type { DocumentKind } from "../../../shared/documents";
import { DocumentList, runningElsewhere, StartNotes, useJobDocuments } from "../../components/Documents";

// A job's Cover letter tab. A letter is written from confirmed facts, every sentence checked, and
// each finished one counts as one document. The newest is open with where each sentence came from.

export function JobLetter({ job }: { job: ApplicationDetail }) {
  return <DocumentTab job={job} kind="letter" heading="Cover letters" start="Write a cover letter" />;
}

/**
 * A tab of one counted kind: its one start, which is off while anything of the job's runs and when
 * the allowance is used, then its documents, those running or failed first and the newest open.
 */
export function DocumentTab({ job, kind, heading, start }: { job: ApplicationDetail; kind: Extract<DocumentKind, "letter" | "prep">; heading: string; start: string }) {
  const jobDocs = useJobDocuments(job.id);
  const id = useId();
  const kinds: readonly DocumentKind[] = [kind];
  const elsewhere = runningElsewhere(jobDocs, kinds);
  return (
    <section className="section app-job-section" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{heading}</h2>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={jobDocs.action.pending || jobDocs.running || jobDocs.available === 0}
          aria-describedby={elsewhere ? `${id}-elsewhere` : undefined}
          onClick={() => void jobDocs.start({ kind })}
        >
          {start}
        </button>
      </div>
      <StartNotes id={`${id}-elsewhere`} jobDocs={jobDocs} kinds={kinds} counted />
      <DocumentList jobDocs={jobDocs} kinds={kinds} open="newest" />
    </section>
  );
}
