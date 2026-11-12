import type { ApplicationDetail } from "../../../shared/api";
import { ApplicationKit } from "../../components/ApplicationKit";
import { JobTracking } from "../../components/jobs/JobTracking";
import { PlaceholderSection } from "../../components/Placeholder";
import { href } from "../../router";

// A job's Application tab: where it stands, what will be sent, and how. Resumatic doesn't send
// anything: the person approves the kit, downloads it and sends it themselves.

export function JobApplication({ job, reload }: { job: ApplicationDetail; reload: () => Promise<unknown> }) {
  return (
    <div className="stack app-job-application">
      {/* Keyed by the job alone, so what is typed in it stays when the job is read again. */}
      <JobTracking key={job.id} application={job} onSaved={reload} />
      <ApplicationKit key={`kit:${job.id}`} applicationId={job.id} />
      <p className="rs-meta">
        Answers you give on many jobs are kept under <a href={href.rules}>Rules and answers</a>.
      </p>
      <PlaceholderSection name="sending" />
    </div>
  );
}
