import type { ApplicationStatus, ApplicationView } from "../shared/api";

export interface TrackingWrite {
  status: ApplicationStatus;
  appliedAt: string | null;
  notes: string;
}

/** A read proves the submitted values are present at precisely the next revision. */
export function trackingWriteObserved(
  current: ApplicationView | undefined,
  applicationId: string,
  previousRevision: number | undefined,
  submitted: TrackingWrite,
): boolean {
  return Number.isSafeInteger(previousRevision) && previousRevision! > 0 &&
    previousRevision! < Number.MAX_SAFE_INTEGER && current?.id === applicationId &&
    current.revision === previousRevision! + 1 &&
    current.status === submitted.status &&
    current.appliedAt === submitted.appliedAt &&
    current.notes === submitted.notes;
}
