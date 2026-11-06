// The HTTP contract between the web app and the Worker. Both sides import these types.
//
// Auth (the only routes that reach the Directory):
//   GET    /auth/login                 302 to Google; sets the short-lived __Host-oidc cookie
//   GET    /auth/callback              302 to /, setting __Host-session; or 302 to /?error=<code>
//   POST   /auth/logout                204; clears the session cookie
//   DELETE /auth/account               202 { deleting: true }; clears the session cookie
//   POST   /auth/test-login            staging only: header x-test-signin-key, body { email }; 204 + cookie
//
// API (session cookie required, else 401; never reaches the Directory):
//   GET    /api/health                 { ok: true }            (no session needed)
//   GET    /api/me                     Me
//   GET    /api/profile                Profile
//   PUT    /api/profile                Partial<Profile> -> Profile
//   POST   /api/account/sign-out-everywhere   204
//   POST   /api/sources                multipart field "file" (PDF or DOCX, at most 10 MB) -> 201 { sourceId }
//   GET    /api/sources                { sources: SourceView[] }
//   GET    /api/sources/:id/file       the original upload, as an attachment
//   GET    /api/roles                  { roles: RoleView[] }
//   POST   /api/roles                  NewRole -> 201 { roleId }   (a role the uploads missed)
//   PATCH  /api/roles/:id              RolePatch -> 204
//   GET    /api/facts?state=           { facts: FactView[] }
//   POST   /api/facts                  NewFact -> 201 { factId }
//   PATCH  /api/facts/:id              FactPatch -> 204          (new wording, another role, or both)
//   POST   /api/review                 ReviewRequest -> 204   (role or fact IDs)
//   POST   /api/applications           { jdText } -> 201 { applicationId }
//   GET    /api/applications           { applications: ApplicationView[] }
//   POST   /api/applications/:id/resumes   202 { resumeId }
//   GET    /api/resumes/:id            ResumeView               (poll while state is "running")
//   PATCH  /api/resumes/:id/lines/:lineId  { text } -> 204
//   GET    /api/resumes/:id/pdf        application/pdf
//   GET    /api/resumes/:id/preview    text/html: exactly what the PDF prints
//   GET    /api/export                 application/json attachment: everything in the vault, with
//                                       links to the original uploads
//   GET    /api/export/archive         streamed ZIP: vault.json and source objects (bounded)
//
// Errors are JSON: { error: ErrorCode, message: string }. A 4xx message is written for the user.
// /auth/callback reports failures as /?error=<code>: "unauthenticated" (cancelled, expired or not
// verifiable; try again), "forbidden" (not invited, no verified email, or the account is being
// deleted) or "unavailable" (sign-in is not configured or Google could not be reached).
//
// Times (createdAt) are milliseconds since the epoch. Role dates are "YYYY-MM" or "YYYY" as the
// source gave them; a null endDate with a startDate means the role is current,
// while two null dates mean that the dates are unknown.

export type RoleKind = "job" | "education" | "project" | "volunteer";
export type FactKind = "accomplishment" | "skill" | "credential";
export type Level = "contributed" | "implemented" | "led" | "owned" | "founded";
export type ReviewState = "proposed" | "confirmed" | "rejected";
export type SourceState = "queued" | "ready" | "failed";
export type ResumeState = "running" | "ready" | "failed";
export type LineStatus = "kept" | "repaired" | "replaced" | "edited";
export type FactOrigin = "extracted" | "user";

export const ROLE_KINDS: readonly RoleKind[] = [
  "job",
  "education",
  "project",
  "volunteer",
];
export const FACT_KINDS: readonly FactKind[] = [
  "accomplishment",
  "skill",
  "credential",
];
export const LEVELS: readonly Level[] = [
  "contributed",
  "implemented",
  "led",
  "owned",
  "founded",
];

/** Role dates: a year, or a year and month. */
export const DATE_PATTERN = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_JD_CHARS = 20_000;
export const MAX_FACT_CHARS = 600;
export const MAX_LINE_CHARS = 300;

export interface Profile {
  revision?: number;
  name: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
}

export interface Quota {
  reserved?: number;
  periodEnd?: number;
  used: number;
  limit: number;
  /** Calendar month the count applies to, as "YYYY-MM" in UTC. */
  month: string;
}

export interface Me {
  capabilities?: { ocr: boolean; connectedApps: boolean; roleDateUnknownEnd?: boolean };
  userId: string;
  profile: Profile;
  quota: Quota;
}

export interface SourceView {
  /** The upload was saved, but starting its reading workflow is unconfirmed. */
  dispatchUncertain?: boolean;
  /** Cancellation was requested but has not yet been confirmed. */
  cancellationPending?: boolean;
  /** Number of page images submitted for OCR; null for ordinary PDFs and old sources.
   * This does not assert the number of pages in the original PDF. */
  conversionImageCount?: number | null;
  conversionWarnings?: ("little-text" | "short-lines" | "no-structure")[];
  origin?: "upload" | "ocr";
  extractor?: string | null;
  id: string;
  filename: string;
  state: SourceState;
  error: string | null;
  createdAt: number;
  /** Facts from this source still waiting for review. */
  proposed: number;
}

export interface RoleView {
  revision?: number;
  span?: [number, number] | null;
  id: string;
  kind: RoleKind;
  org: string;
  title: string | null;
  startDate: string | null;
  /** Null with a start date means ongoing; both dates null means dates are unknown. */
  endDate: string | null;
  /** A start whose end is unknown; startDate and endDate remain null for legacy clients. */
  unknownEndStartDate?: string | null;
  state: ReviewState;
  quote: string | null;
  sourceId: string | null;
}

export interface RolePatch {
  expectedRevision?: number;
  kind?: RoleKind;
  org?: string;
  title?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  unknownEndStartDate?: string | null;
}

export interface FactView {
  /** Original user-authored interview answer; it is historical after a fact edit. */
  interview?: import("./interview").InterviewProvenance | null;
  evidenceOrigin?: "upload" | "ocr";
  confidence?: number | null;
  reviewReasons?: string[];
  revision?: number;
  span?: [number, number] | null;
  id: string;
  roleId: string | null;
  kind: FactKind;
  text: string;
  level: Level | null;
  origin: FactOrigin;
  state: ReviewState;
  /** The verbatim source quote that supports the fact; null for facts the user typed. */
  quote: string | null;
  sourceId: string | null;
}

/** A role the user adds. It is their own claim, so it starts confirmed and has no quote. */
export interface NewRole {
  kind: RoleKind;
  org: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  unknownEndStartDate?: string | null;
}

/** At least one field. Either change makes the fact the user's own claim. */
export interface FactPatch {
  expectedRevision?: number;
  text?: string;
  roleId?: string | null;
}

export interface NewFact {
  roleId: string | null;
  kind: FactKind;
  text: string;
  level: Level | null;
}

export interface ReviewRequest {
  expectedRevisions?: Record<string, number>;
  confirm: string[];
  reject: string[];
}

export interface ApplicationView {
  revision?: number;
  status?: ApplicationStatus;
  appliedAt?: string | null;
  notes?: string;
  id: string;
  /** From Tailor's analyze step; null until the first resume for this job has been started. */
  company: string | null;
  title: string | null;
  /** The start of the job description, at most about 100 characters. */
  excerpt: string;
  createdAt: number;
  resumes: { id: string; state: ResumeState; createdAt: number; dispatchUncertain?: boolean; cancellationPending?: boolean }[];
}

export interface ResumeLine {
  id: string;
  text: string;
  factIds: string[];
  status: LineStatus;
}

export interface ResumeSection {
  roleId: string;
  kind: RoleKind;
  org: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  unknownEndStartDate?: string | null;
  lines: ResumeLine[];
}

export interface ResumeBody {
  summary: ResumeLine | null;
  sections: ResumeSection[];
  skills: string[];
}

export interface ResumeReport {
  kept: number;
  repaired: number;
  replaced: number;
  dropped: number;
  /** Job requirements no confirmed fact supports. */
  gaps: string[];
}

export interface ResumeView {
  /** The request was saved, but starting its workflow is unconfirmed. */
  dispatchUncertain?: boolean;
  /** Cancellation was requested but has not yet been confirmed. */
  cancellationPending?: boolean;
  provenance?: "snapshot" | "legacy";
  id: string;
  applicationId: string;
  state: ResumeState;
  /** Last finished Tailor step while running. */
  step: string | null;
  error: string | null;
  version: number;
  createdAt: number;
  /** Present only once state is "ready". */
  body: ResumeBody | null;
  report: ResumeReport | null;
  /** The facts cited by body lines, for showing evidence beside each line. */
  facts: Record<string, { text: string; quote: string | null }>;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

export const APPLICATION_STATUSES = [
  "saved",
  "applied",
  "interview",
  "offer",
  "closed",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
