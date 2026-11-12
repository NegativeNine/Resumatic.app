import type { ApplicationDetail } from "../../../shared/api";
import { DocumentTab } from "./JobLetter";

// A job's Interview tab: answers to likely questions, from confirmed facts, each point checked. Each
// finished preparation counts as one document.

export function JobInterview({ job }: { job: ApplicationDetail }) {
  return <DocumentTab job={job} kind="prep" heading="Interview preparation" start="Prepare for an interview" />;
}
