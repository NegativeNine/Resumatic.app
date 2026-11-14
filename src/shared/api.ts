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
//   GET    /api/v2/today               Today   (types in ./today)
//   GET    /api/profile                Profile
//   PUT    /api/profile                Partial<Profile> -> Profile
//   GET    /api/preferences            Preferences
//   PUT    /api/preferences            PreferencesUpdate -> Preferences
//   GET    /api/saved-answers          { savedAnswers: SavedAnswer[] }   (types in ./kit)
//   POST   /api/saved-answers          SavedAnswerInput -> 201 SavedAnswer   (the same label and answer again returns it)
//   PUT    /api/saved-answers/:id      SavedAnswerInput & { expectedRevision } -> SavedAnswer
//   DELETE /api/saved-answers/:id      204
//   POST   /api/account/sign-out-everywhere   204
//   POST   /api/sources                multipart field "file" (PDF or DOCX, at most 10 MB) -> 201 { sourceId }
//   POST   /api/sources/paste   PasteSourceRequest + Idempotency-Key -> 201 { sourceId }
//   GET    /api/sources                { sources: SourceView[] }
//   GET    /api/sources/:id/file       source object as an attachment (OCR sources contain JSON input)
//   POST   /api/sources/:id/cancel     request cancellation of the current reading run
//   GET    /api/roles                  { roles: RoleView[] }
//   POST   /api/roles                  NewRole -> 201 { roleId }   (a role the uploads missed)
//   POST   /api/v3/roles               NewRole + Idempotency-Key -> 201 { roleId }
//   PATCH  /api/roles/:id              RolePatch -> 204
//   GET    /api/facts?state=           { facts: FactView[] }
//   POST   /api/facts                  NewFact -> 201 { factId }
//   PATCH  /api/facts/:id              FactPatch -> 204          (new wording, another role, or both)
//   POST   /api/v2/record/offers/:id  SemanticOfferDecision -> 204 (gated)
//   GET    /api/v2/record/proposals  RecordProposals; existing non-shadow splits/tags only (gated)
//   POST   /api/v2/record/proposals/:kind/:id  ProposalDecision -> 204 (gated)
//   POST   /api/v2/record/identical   {} -> 204; owner asks to group deterministic copies (gated)
//   POST   /api/v2/record/links/:id  { decision, fromRevision, toRevision } -> 204; separate/rejoin copies (gated)
//   POST   /api/review                 ReviewRequest -> 204   (role or fact IDs)
//   POST   /api/facts/sensitive        SensitiveRequest -> 204   (mark or unmark facts, and every fact with the same words)
//   POST   /api/applications           { jdText } -> 201 { applicationId }
//   POST   /api/v2/applications        { jdText, url? } with an idempotency key
//   POST   /api/applications/duplicates   { jdText } -> { duplicate: ApplicationRef | null }
//   GET    /api/applications/:id       ApplicationDetail          (the whole posting)
//   PATCH  /api/applications/:id       tracking and details -> 204
//   DELETE /api/applications/:id       204                  (only a job with no resumes or documents)
//   GET    /api/applications           { applications: ApplicationView[] }
//   POST   /api/applications/:id/resumes   202 { resumeId }
//   GET    /api/applications/:id/kit   KitView   (revision 0 before the first write)
//   PUT    /api/applications/:id/kit/questions   KitQuestionsUpdate (at most 256 KiB) -> KitView
//   PUT    /api/applications/:id/kit/parts       KitPartsUpdate -> KitView
//   POST   /api/applications/:id/kit/questions/:qid   { change: KitAnswerChange, expectedRevision } -> KitView
//   POST   /api/applications/:id/kit/approve     { expectedRevision } -> KitView
//   GET    /api/applications/:id/kit/archive     application/zip: an approved kit that passes every check
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
/** How a source arrived: a file, page images read from a PDF, or text pasted on the Facts page. */
export type SourceOrigin = "upload" | "ocr" | "paste";
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
/** The shortest text that can be a job description. */
export const MIN_JD_CHARS = 40;
/** A job's title or company, typed by the person. */
export const MAX_JOB_NAME_CHARS = 160;
export const MAX_URL_CHARS = 2000;
export const MAX_FACT_CHARS = 600;
export const MAX_LINE_CHARS = 300;
/** The most facts one request can mark or unmark as sensitive. */
export const MAX_SENSITIVE_IDS = 200;

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
  capabilities?: {
    ocr: boolean;
    connectedApps: boolean;
    roleDateUnknownEnd?: boolean;
    /** A posting can be read from its link. */
    postingReader?: boolean;
    /** The owner's own card can be previewed. */
    cardPreview?: boolean;
    /** The deployment sends email notices, so Account offers them. */
    emailNotices?: boolean;
  };
  userId: string;
  profile: Profile;
  quota: Quota;
  /** The address this session signed in with. Absent from a session issued before it was carried. */
  signInEmail?: string;
  /** How many copies other people have shared with this account as their coach. */
  clients?: number;
  /** How many comments a coach has written on this account's shared copies that its owner hasn't seen. */
  newFromCoach?: number;
}

export interface SourceView {
  /** Stopped reading run that can be retried without uploading the file again. */
  retryRunId?: string;
  /** The upload was saved, but starting its reading workflow is unconfirmed. */
  dispatchUncertain?: boolean;
  /** Cancellation was requested but has not yet been confirmed. */
  cancellationPending?: boolean;
  /** Number of page images submitted for OCR; null for ordinary PDFs and old sources.
   * This does not assert the number of pages in the original PDF. */
  conversionImageCount?: number | null;
  conversionWarnings?: ("little-text" | "short-lines" | "no-structure")[];
  origin?: SourceOrigin;
  /** Original upload used to create an image-transcription source, if known. */
  parentSourceId?: string | null;
  extractor?: string | null;
  id: string;
  filename: string;
  state: SourceState;
  error: string | null;
  createdAt: number;
  /** Facts from this source still waiting for review. */
  proposed: number;
}

/** Owner-only controls for deterministic identical copies; absent while disabled. */
export interface CopyLinkView {
  id: string;
  from: string;
  to: string;
  fromRevision: number;
  toRevision: number;
  /** Monotonic decision generation; protects newer owner choices even when wording is unchanged. */
  decisionVersion: number;
}
export interface CopyReviewView {
  rootId: string;
  links: CopyLinkView[];
  separations: CopyLinkView[];
}

export interface RoleView {
  copyReview?: CopyReviewView;
  /** Owner-only hint; present only where non-shadow proposal review is enabled. */
  proposalReviewEnabled?: boolean;
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
  copyReview?: CopyReviewView;
  /** Owner-only hint; present only where non-shadow proposal review is enabled. */
  proposalReviewEnabled?: boolean;
  /** An older level was retained for history but needs the owner's confirmation. */
  levelNeedsReview?: boolean;
  previousLevel?: Level;
  /** Original user-authored interview answer; it is historical after a fact edit. */
  interview?: import("./interview").InterviewProvenance | null;
  evidenceOrigin?: SourceOrigin;
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
  /**
   * True while its owner has it marked sensitive: left out of everything generated, never put in a
   * shared copy and never shown to a connected app. Only its owner is ever told.
   */
  sensitive?: boolean;
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

/** At least one field. Any change makes the fact the user's own claim. */
export interface FactPatch {
  expectedRevision?: number;
  text?: string;
  roleId?: string | null;
  level?: Level | null;
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

/**
 * Marks facts sensitive, or unmarks them. Every fact with the same words as one named is marked or
 * unmarked with it. The request names the wanted state, so repeating it changes nothing.
 */
export interface SensitiveRequest {
  ids: string[];
  sensitive: boolean;
  expectedRevisions?: Record<string, number>;
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
  /** Where the posting lives, when the person saved a link with it. */
  url?: string | null;
  resumes: { id: string; state: ResumeState; createdAt: number; dispatchUncertain?: boolean; cancellationPending?: boolean }[];
}

/** One job with its whole posting, for the person who saved it. */
export interface ApplicationDetail extends ApplicationView {
  jdText: string;
  /** False once the job has a resume or a document: those are kept, so the job is closed instead. */
  canDelete: boolean;
}

/** Enough of a saved job to name it, as in "You've already saved this posting". */
export interface ApplicationRef {
  id: string;
  company: string | null;
  title: string | null;
  excerpt: string;
  createdAt: number;
}

/** A link a person saved with a job: http or https, and nothing a browser would run. */
export function isWebUrl(value: string): boolean {
  if (value.length > MAX_URL_CHARS || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Two postings are the same when their text matches once runs of white space are collapsed. */
export function normalizePosting(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Why a line was repaired or replaced, as Resumatic's own checks found it. It never holds model
 * text: `values` are the numbers or names the draft used that its facts don't contain, at most
 * three, each short. The client words it ("The draft said 40%. Your facts don't include that
 * number."). Resumes tailored before findings existed have none.
 */
export type LineFinding =
  | { kind: "numbers"; values: string[] }
  | { kind: "names"; values: string[] }
  | { kind: "scope"; claimed: Level; allowed: Level }
  | { kind: "citation" }
  | { kind: "unsupported" };

export interface ResumeLine {
  id: string;
  text: string;
  factIds: string[];
  status: LineStatus;
  /** Only on a repaired or replaced line, until the person edits it. */
  finding?: LineFinding;
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
  conceptCoverage?: import("./concept-tailoring").ConceptSelection;
  /** The stored version is retained for the owner but cannot currently be exported or shared. */
  needsGroundingReview?: boolean;
  /**
   * Present while this version uses a fact its owner has marked sensitive: the lines that cite one
   * or were checked against the line one was read from, and the printed skills only marked facts
   * stand behind. Until they or the mark are removed, the version can't be downloaded, shared,
   * refined or read by a connected app.
   */
  sensitiveUse?: { lineIds: string[]; skills: string[] };
  /** Fresh verification progress for an old version; earlier flags are not trusted. */
  legacyReview?: { verifiedLineIds: string[]; totalLines: number; headersReady: boolean; skillsReady: boolean };
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
  /** The contact details this version prints, captured with it; absent while running. */
  profile?: Profile;
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
