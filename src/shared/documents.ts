import type { ResumeBody, ResumeReport } from "./api";

export type DocumentKind = "refine" | "letter" | "prep" | "questions";
export interface NewDocument {
  kind: DocumentKind;
  instruction?: string;
  resumeId?: string;
  expectedVersion?: number;
  lineIds?: string[];
}
export interface DocumentView {
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
      requirement: string;
      question: string;
      roleId?: string | null;
    }[];
    report: ResumeReport;
    body?: ResumeBody;
  } | null;
  facts: Record<string, { text: string; quote: string | null }>;
}
