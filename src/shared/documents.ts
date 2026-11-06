import type { ResumeBody, ResumeReport } from "./api";

export type DocumentKind = "refine" | "letter" | "prep" | "questions";
export interface NewDocument {
  kind: DocumentKind;
  instruction?: string;
  resumeId?: string;
  expectedVersion?: number;
  lineIds?: string[];
  /** Exact user-proposed text; used only for an independently verified refinement. */
  manualText?: string;
  manualFactIds?: string[];
}
export interface DocumentView {
  /** The stopped generation run can be retried with its original options. */
  retryRunId?: string;
  /** The request was saved, but starting its workflow is unconfirmed. */
  dispatchUncertain?: boolean;
  /** Cancellation was requested but has not yet been confirmed. */
  cancellationPending?: boolean;
  id: string;
  applicationId: string;
  kind: DocumentKind;
  state: "running" | "ready" | "failed";
  version: number;
  createdAt: number;
  error: string | null;
  result: {
    kind: DocumentKind;
    units: {
      id: string;
      roleId: string | null;
      text: string;
      factIds: string[];
      group: number;
      status?: string;
    }[];
    questions: {
      id: string;
      requirement: string;
      question: string;
      roleId?: string | null;
    }[];
    report: ResumeReport;
    body?: ResumeBody;
  } | null;
  facts: Record<string, { text: string; quote: string | null }>;
  /** Questions for which the owner has previously saved an answer. */
  answeredQuestionIds?: string[];
}
