import { GenerationKeys } from "./generation-keys";
import type {
  ApiErrorBody,
  ApplicationDetail,
  ApplicationRef,
  ApplicationView,
  ApplicationStatus,
  FactPatch,
  FactView,
  Me,
  NewFact,
  NewRole,
  Profile,
  ResumeView,
  ReviewRequest,
  ReviewState,
  RolePatch,
  RoleView,
  SensitiveRequest,
  SourceView,
} from "../shared/api";
import type { DocumentView, NewDocument } from "../shared/documents";
import type { PasteSourceRequest } from "../shared/paste";
import type { KitAnswerChange, KitPart, KitView, SavedAnswer, SavedAnswerInput } from "../shared/kit";
import type { PreferenceValues, Preferences } from "../shared/preferences";
import type { CardPreview } from "../shared/card";
import type { EmailNotices, NoticeKind } from "../shared/email-notices";
import type { PostingRead } from "../shared/postings";
import type { CoachClient, ShareableDocument, ShareGrant } from "../shared/sharing";
import type { CommentThread, NewShareComment, NewSuggestion, OwnerCommentThread, ShareComment } from "../shared/sharing";
import type { Today } from "../shared/today";
import type { McpGrant } from "../shared/mcp";

export interface BillingView {
  enabled: boolean;
  plans: { id: string; generationLimit: number }[];
  current: {
    planId: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    validUntil: number;
  } | null;
}

/** A failed API call. `code` is the server's error code, such as "unauthenticated" or "quota". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A fetch-level failure; TypeError inheritance preserves the existing connection message. */
export class ApiNetworkError extends TypeError {}

function fetchError(error: unknown): unknown {
  return error instanceof TypeError ||
    (typeof DOMException !== "undefined" && error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
    ? new ApiNetworkError(error.message)
    : error;
}

/**
 * The event sent shortly after this tab changes something, so the header's counts are read again.
 * Pages listen for it through live.ts, beside VAULT_CHANGED; it is written here because this module
 * also runs where there is no window.
 */
export const COUNTS_CHANGED = "resumatic:counts-change";

/** True while a change this tab made waits to be told: several changes together are told once. */
let countsPending = false;

/**
 * Tells the header that something this tab changed may have changed its counts. Only a change to
 * the API counts: signing out is not one, and its note on the signed-out page stays.
 */
function countsChanged(method: string, path: string): void {
  const target = globalThis as unknown as { dispatchEvent?: (event: Event) => boolean };
  if (method === "GET" || !path.startsWith("/api/") || countsPending || typeof target.dispatchEvent !== "function") return;
  countsPending = true;
  setTimeout(() => {
    countsPending = false;
    target.dispatchEvent?.(new Event(COUNTS_CHANGED));
  }, 150);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const init: RequestInit & { credentials: "same-origin" } = {
    method,
    credentials: "same-origin",
    headers: {},
  };
  if (idempotencyKey)
    (init.headers as Record<string, string>)["idempotency-key"] =
      idempotencyKey;
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] =
      "application/json";
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    throw fetchError(error);
  }
  if (!res.ok) {
    let payload: Partial<ApiErrorBody> = {};
    try {
      payload = (await res.json()) as ApiErrorBody;
    } catch {
      // not JSON
    }
    throw new ApiError(
      res.status,
      payload.error ?? "http_" + res.status,
      payload.message ?? res.statusText,
    );
  }
  countsChanged(method, path);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return undefined as T;
  try {
    return await res.json() as T;
  } catch (error) {
    // A response body can fail after fetch has already returned its headers.
    // Invalid JSON is a SyntaxError and is not treated as a network failure.
    throw fetchError(error);
  }
}

// An uncertain network response reuses the same key if the person retries the same action.
// When session storage is available, keys also survive a reload of this tab.
const generationKeys = new GenerationKeys();
function requireResponseFields<T>(result: T, fields: readonly (keyof T)[]): T {
  if (
    !result || typeof result !== "object" ||
    fields.some((field) => typeof result[field] !== "string" || !(result[field] as string).trim())
  ) {
    // A successful status alone doesn't prove that the browser received the
    // result. The server may already have committed the operation.
    throw new ApiError(502, "unavailable", "The response was incomplete.");
  }
  return result;
}

async function generate<T>(path: string, body: unknown, fields: readonly (keyof T)[]): Promise<T> {
  // Hash and send the same snapshot even if the caller changes its object while
  // the asynchronous digest is being computed.
  const captured = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
  const { fingerprint, key } = await generationKeys.acquire(path, captured);
  // A later rejection does not establish whether an earlier request reached
  // the server. Keep the original key across every failure until a response
  // confirms the result, including a 4xx received while another attempt runs.
  const result = requireResponseFields(await request<T>("POST", path, captured, key), fields);
  generationKeys.acknowledge(fingerprint, key);
  return result;
}

// The caller keeps a key for retries of one upload action; a new action gets a new key.
async function uploadSource(
  file: File,
  requestKey: string = crypto.randomUUID(),
): Promise<{ sourceId: string }> {
  const form = new FormData();
  form.append("file", file);
  return requireResponseFields(await request<{ sourceId: string }>(
    "POST",
    "/api/sources",
    form,
    requestKey,
  ), ["sourceId"]);
}

// As with uploads, the caller keeps one key for the retries of one Add text action; each new
// action gets a new key, so an expired paste is never resent under its old key.
async function pasteSource(body: PasteSourceRequest, requestKey: string = crypto.randomUUID()): Promise<{ sourceId: string }> {
  return requireResponseFields(await request<{ sourceId: string }>("POST", "/api/sources/paste", body, requestKey), ["sourceId"]);
}

const versionQuery = (version?: number) =>
  version === undefined ? "" : `?version=${version}`;

export const api = {
  // Auth. Sign-in itself is a full-page navigation to /auth/login.
  loginUrl: "/auth/login",
  logout: () => request<void>("POST", "/auth/logout"),
  deleteAccount: () => request<{ deleting: true }>("DELETE", "/auth/account"),

  me: () => request<Me>("GET", "/api/me"),
  profile: () => request<Profile>("GET", "/api/profile"),
  updateProfile: (patch: Partial<Profile>, expectedRevision: number) =>
    request<Profile>("PUT", "/api/v2/profile", { ...patch, expectedRevision }),
  /** The person's job preferences. Loaded by their own card on Sharing › Recruiters, never with the session. */
  preferences: () => request<Preferences>("GET", "/api/preferences"),
  /** Replaces all four values, if `expectedRevision` is still the saved revision. */
  updatePreferences: (values: PreferenceValues, expectedRevision: number) =>
    request<Preferences>("PUT", "/api/preferences", { ...values, expectedRevision }),
  /** The owner's own card, as a recruiter would see it. Shown to its owner alone, and stored nowhere. */
  cardPreview: () => request<CardPreview>("GET", "/api/v2/card-preview"),
  /** Which email notices are on, and the address they go to. Loaded by their own card on Account. */
  emailNotices: () => request<EmailNotices>("GET", "/api/email-notices"),
  /** Turns one kind on or off. Setting it as it already is changes nothing, so a retry is safe. */
  setEmailNotice: (kind: NoticeKind, on: boolean) =>
    request<EmailNotices>("PUT", `/api/email-notices/${kind}`, { on }),
  signOutEverywhere: () =>
    request<void>("POST", "/api/account/sign-out-everywhere"),
  /** The person's saved answers. Loaded by their own card on Jobs › Rules and answers, and by a job's kit. */
  savedAnswers: () => request<{ savedAnswers: SavedAnswer[] }>("GET", "/api/saved-answers"),
  /** Adds a saved answer. The same label and answer sent again returns the one already kept. */
  addSavedAnswer: (input: SavedAnswerInput) => request<SavedAnswer>("POST", "/api/saved-answers", input),
  editSavedAnswer: (id: string, input: SavedAnswerInput, expectedRevision: number) =>
    request<SavedAnswer>("PUT", `/api/saved-answers/${encodeURIComponent(id)}`, { ...input, expectedRevision }),
  deleteSavedAnswer: (id: string) => request<void>("DELETE", `/api/saved-answers/${encodeURIComponent(id)}`),

  uploadSource,
  pasteSource,
  reviewView: () => request<{ sources: SourceView[]; roles: RoleView[]; facts: FactView[] }>("GET", "/api/v2/vault"),
  sources: () => request<{ sources: SourceView[] }>("GET", "/api/sources"),
  retryRun: (runId: string) =>
    generate<{ runId: string; targetId: string }>(`/api/runs/${encodeURIComponent(runId)}/retry`, undefined, ["runId", "targetId"]),
  sourceText: (sourceId: string) =>
    request<{ markdown: string; revisionId: string }>(
      "GET",
      `/api/sources/${encodeURIComponent(sourceId)}/text`,
    ),
  readSourceImages: (
    sourceId: string,
    body: {
      images: { mimeType: "image/png" | "image/jpeg"; base64: string }[];
    },
  ) =>
    generate<{ sourceId: string }>(
      `/api/sources/${encodeURIComponent(sourceId)}/ocr`,
      body,
      ["sourceId"],
    ),
  sourceFileUrl: (sourceId: string) =>
    `/api/sources/${encodeURIComponent(sourceId)}/file`,

  roles: () => request<{ roles: RoleView[] }>("GET", "/api/roles"),
  addRole: (role: NewRole) =>
    generate<{ roleId: string }>("/api/v3/roles", role, ["roleId"]),
  addRoleV2: (role: NewRole) =>
    generate<{ roleId: string }>("/api/v3/roles", role, ["roleId"]),
  updateRole: (id: string, patch: RolePatch) =>
    request<void>("PATCH", `/api/roles/${encodeURIComponent(id)}`, patch),
  updateRoleV2: (id: string, patch: RolePatch) =>
    request<void>("PATCH", `/api/v2/roles/${encodeURIComponent(id)}`, patch),
  facts: (state?: ReviewState) =>
    request<{ facts: FactView[] }>(
      "GET",
      state ? `/api/facts?state=${state}` : "/api/facts",
    ),
  answerInterview: (
    documentId: string,
    questionId: string,
    body: import("../shared/interview").InterviewAnswer,
  ) =>
    generate<{ factId: string }>(
      `/api/documents/${encodeURIComponent(documentId)}/questions/${encodeURIComponent(questionId)}/answer`,
      body,
      ["factId"],
    ),
  addFact: (fact: NewFact) =>
    generate<{ factId: string }>("/api/v2/facts", fact, ["factId"]),
  editFact: (id: string, patch: FactPatch) =>
    request<void>("PATCH", `/api/facts/${encodeURIComponent(id)}`, patch),
  groupIdenticalCopies: () => request<void>("POST", "/api/v2/record/identical", {}),
  decideIdenticalCopy: (link: import("../shared/api").CopyLinkView, decision: "confirmed" | "rejected") =>
    request<void>("POST", `/api/v2/record/links/${encodeURIComponent(link.id)}`, { decision, fromRevision: link.fromRevision, toRevision: link.toRevision, expectedDecisionVersion: link.decisionVersion }),
  review: (r: ReviewRequest) => request<void>("POST", "/api/review", r),
  /** Marks facts sensitive, or unmarks them. Facts with the same words go with them. */
  markSensitive: (r: SensitiveRequest) => request<void>("POST", "/api/facts/sensitive", r),

  /** `name` is what the posting's own page calls the job, when the text was read from its link. */
  addApplication: (jdText: string, url?: string, name?: { title: string | null; company: string | null }) =>
    generate<{ applicationId: string }>(
      "/api/v2/applications",
      {
        jdText,
        ...(url ? { url } : {}),
        ...(name?.title ? { title: name.title } : {}),
        ...(name?.company ? { company: name.company } : {}),
      },
      ["applicationId"],
    ),
  /** Reads a posting from its page. Saves nothing: the person checks the text first. */
  readPosting: (url: string) => request<PostingRead>("POST", "/api/postings/read", { url }),
  /** The saved job with the same posting, if there is one. Saves nothing. */
  duplicateApplication: (jdText: string) =>
    request<{ duplicate: ApplicationRef | null }>("POST", "/api/applications/duplicates", { jdText }),
  applications: () =>
    request<{ applications: ApplicationView[] }>("GET", "/api/applications"),
  application: (id: string) =>
    request<ApplicationDetail>("GET", `/api/applications/${encodeURIComponent(id)}`),
  deleteApplication: (id: string) =>
    request<void>("DELETE", `/api/applications/${encodeURIComponent(id)}`),
  updateApplication: (
    id: string,
    patch: {
      status?: ApplicationStatus;
      appliedAt?: string | null;
      notes?: string;
      /** An empty string clears a name or the link. */
      title?: string;
      company?: string;
      url?: string;
      jdText?: string;
      expectedRevision?: number;
    },
  ) =>
    request<void>(
      "PATCH",
      `/api/applications/${encodeURIComponent(id)}`,
      patch,
    ),
  tailor: (applicationId: string) =>
    generate<{ resumeId: string }>(
      `/api/applications/${encodeURIComponent(applicationId)}/resumes`,
      undefined,
      ["resumeId"],
    ),
  /** A job's application kit, with every check worked out now. */
  kit: (applicationId: string) => request<KitView>("GET", `/api/applications/${encodeURIComponent(applicationId)}/kit`),
  /** Replaces the kit's questions, in order: one with an ID is one already in the kit. */
  saveKitQuestions: (applicationId: string, questions: { id?: string; text: string }[], expectedRevision: number) =>
    request<KitView>("PUT", `/api/applications/${encodeURIComponent(applicationId)}/kit/questions`, { questions, expectedRevision }),
  chooseKitParts: (applicationId: string, parts: { resume: KitPart | null; letter: KitPart | null; prep: KitPart | null }, expectedRevision: number) =>
    request<KitView>("PUT", `/api/applications/${encodeURIComponent(applicationId)}/kit/parts`, { ...parts, expectedRevision }),
  answerKitQuestion: (applicationId: string, questionId: string, change: KitAnswerChange, expectedRevision: number) =>
    request<KitView>("POST", `/api/applications/${encodeURIComponent(applicationId)}/kit/questions/${encodeURIComponent(questionId)}`, { change, expectedRevision }),
  approveKit: (applicationId: string, expectedRevision: number) =>
    request<KitView>("POST", `/api/applications/${encodeURIComponent(applicationId)}/kit/approve`, { expectedRevision }),
  kitArchiveUrl: (applicationId: string) => `/api/applications/${encodeURIComponent(applicationId)}/kit/archive`,
  documents: (applicationId: string) =>
    request<{ documents: DocumentView[] }>(
      "GET",
      `/api/applications/${encodeURIComponent(applicationId)}/documents`,
    ),
  document: (id: string) =>
    request<DocumentView>("GET", `/api/documents/${encodeURIComponent(id)}`),
  startDocument: (applicationId: string, options: NewDocument) =>
    generate<{ documentId: string; runId: string }>(
      `/api/applications/${encodeURIComponent(applicationId)}/documents`,
      options,
      ["documentId", "runId"],
    ),
  cancelRun: (id: string) =>
    request<void>("POST", `/api/runs/${encodeURIComponent(id)}/cancel`),
  cancelResume: (id: string) =>
    request<void>("POST", `/api/resumes/${encodeURIComponent(id)}/cancel`),
  cancelSource: (id: string) =>
    request<void>("POST", `/api/sources/${encodeURIComponent(id)}/cancel`),
  resume: (id: string, version?: number) =>
    request<ResumeView>(
      "GET",
      `/api/resumes/${encodeURIComponent(id)}${versionQuery(version)}`,
    ),
  resumeVersions: (id: string) =>
    request<{ versions: { version: number; createdAt: number }[] }>(
      "GET",
      `/api/resumes/${encodeURIComponent(id)}/versions`,
    ),
  finalizeLegacyResume: (id: string, expectedVersion: number) =>
    request<{ version: number }>("POST", `/api/resumes/${encodeURIComponent(id)}/legacy-finalize`, { expectedVersion }),
  removeLegacyLine: (id: string, lineId: string, expectedVersion: number) =>
    request<{ version: number }>("POST", `/api/resumes/${encodeURIComponent(id)}/legacy-remove-line`, { lineId, expectedVersion }),
  removeLegacySection: (id: string, sectionIndex: number, expectedVersion: number) =>
    request<{ version: number }>("POST", `/api/resumes/${encodeURIComponent(id)}/legacy-remove-section`, { sectionIndex, expectedVersion }),
  removeLegacySkill: (id: string, skillIndex: number, expectedVersion: number) =>
    request<{ version: number }>("POST", `/api/resumes/${encodeURIComponent(id)}/legacy-remove-skill`, { skillIndex, expectedVersion }),
  removeResumeLine: (id: string, lineId: string, expectedVersion: number) =>
    request<{ version: number }>("POST", `/api/resumes/${encodeURIComponent(id)}/remove-line`, { lineId, expectedVersion }),
  removeResumeSkill: (id: string, skillIndex: number, expectedVersion: number) =>
    request<{ version: number }>("POST", `/api/resumes/${encodeURIComponent(id)}/remove-skill`, { skillIndex, expectedVersion }),
  beginResumeReview: (id: string, expectedVersion: number) =>
    request<{ version: number }>("POST", `/api/resumes/${encodeURIComponent(id)}/grounding-review`, { expectedVersion }),
  pdfUrl: (resumeId: string, version?: number) =>
    `/api/resumes/${encodeURIComponent(resumeId)}/pdf${versionQuery(version)}`,
  docxUrl: (resumeId: string, version?: number) =>
    `/api/resumes/${encodeURIComponent(resumeId)}/docx${versionQuery(version)}`,
  documentDocxUrl: (documentId: string) =>
    `/api/documents/${encodeURIComponent(documentId)}/docx`,
  previewUrl: (resumeId: string, version?: number) =>
    `/api/resumes/${encodeURIComponent(resumeId)}/preview${versionQuery(version)}`,
  billing: () => request<BillingView>("GET", "/api/billing"),
  checkout: (planId: string) =>
    generate<{ url: string }>("/api/billing/checkout", { planId }, ["url"]),
  cancelCheckout: () => request<void>("POST", "/api/billing/checkout/cancel"),
  billingPortal: () => request<{ url: string }>("POST", "/api/billing/portal"),
  shares: () => request<{ grants: ShareGrant[] }>("GET", "/api/shares"),
  /** The copies other people have shared with this account as their coach. */
  coachClients: () => request<{ clients: CoachClient[]; needsSignIn: boolean }>("GET", "/api/coach/clients"),
  /** Opens a client's copy from the list, without its link. The copy then reads at /share?g=. */
  openCoachClient: (grantId: string) =>
    request<{ grantId: string }>("POST", `/api/coach/clients/${encodeURIComponent(grantId)}/open`),
  removeCoachClient: (grantId: string) => request<void>("DELETE", `/api/coach/clients/${encodeURIComponent(grantId)}`),
  /** What this account wrote on a client's copy, and the replies to it. */
  coachComments: (grantId: string) =>
    request<{ threads: CommentThread[] }>("GET", `/api/coach/clients/${encodeURIComponent(grantId)}/comments`),
  /** A retry after an uncertain reply sends the same key, so it makes one comment. */
  addCoachComment: (grantId: string, comment: NewShareComment) =>
    generate<ShareComment>(`/api/coach/clients/${encodeURIComponent(grantId)}/comments`, comment, ["id"]),
  removeCoachComment: (grantId: string, id: string) =>
    request<void>("DELETE", `/api/coach/clients/${encodeURIComponent(grantId)}/comments/${encodeURIComponent(id)}`),
  /** Suggested wording for one line of a client's copy. A retry after an uncertain reply makes one suggestion. Deleted as a comment is. */
  suggestOnShare: (grantId: string, input: NewSuggestion) =>
    generate<ShareComment>(`/api/coach/clients/${encodeURIComponent(grantId)}/suggestions`, input, ["id"]),
  /** Finished cover letters and interview preparation, and whether each can be shared. */
  shareableDocuments: () => request<{ documents: ShareableDocument[] }>("GET", "/api/documents"),
  createShare: (selection: {
    factIds: string[];
    resumes: { id: string; version: number }[];
    documents?: { id: string; version: number }[];
    expiresAt?: number;
    /** The owner's own note of who the link is for. The reader never sees it. */
    label?: string;
    /** True puts the owner's name at the top of the copy. */
    showName?: boolean;
    /** True says which job each shared resume or document was made for. */
    showJobs?: boolean;
    /** The sign-in address of the one account that may act as this copy's coach. */
    coachEmail?: string;
  }) =>
    request<{ grant: ShareGrant; url: string }>(
      "POST",
      "/api/shares",
      selection,
    ),
  revokeShare: (id: string) =>
    request<void>("DELETE", `/api/shares/${encodeURIComponent(id)}`),
  /** What a coach wrote on the copies this account shared, with its own replies. */
  shareComments: () => request<{ threads: OwnerCommentThread[] }>("GET", "/api/shares/comments"),
  /** Marks seen the coach's comments the page showed as new, by ID, and no others. */
  markShareCommentsSeen: (ids: string[]) => request<void>("POST", "/api/v2/shares/comments/seen", { ids }),
  /** A reply to a coach's comment, by that comment's ID. */
  replyToShareComment: (id: string, body: string) =>
    generate<ShareComment>(`/api/shares/comments/${encodeURIComponent(id)}/replies`, { body }, ["id"]),
  removeShareComment: (id: string) =>
    request<void>("DELETE", `/api/shares/comments/${encodeURIComponent(id)}`),
  /** Starts the owner's own check of a coach's suggested wording. Accepting again finds the same check. */
  acceptSuggestion: (id: string) =>
    generate<{ documentId: string; runId: string }>(`/api/shares/suggestions/${encodeURIComponent(id)}/accept`, undefined, ["documentId", "runId"]),
  declineSuggestion: (id: string) =>
    request<void>("POST", `/api/shares/suggestions/${encodeURIComponent(id)}/decline`),
  exportUrl: "/api/export",
  exportArchiveUrl: "/api/export/archive",

  // The redesign's stages add their calls here, each inside its own block.

  // stage 2: the shell
  /** What waits for the owner in each room. Loaded by the shell on a change of room. */
  today: () => request<Today>("GET", "/api/v2/today"),

  // stage 3: today

  // stage 4: facts

  // stage 5: jobs

  // stage 6: sharing and account
  /** The apps this person connected, for Sharing › Overview. ConnectedApps reads the same route itself. */
  mcpGrants: () => request<{ grants: McpGrant[] }>("GET", "/api/mcp/grants"),

  // stage 7: outside
  /**
   * A client's copy, read in the app from this account's client list. A copy that has ended is a
   * 409 and one not in the list a 404 ("no such client"); only this account being gone is a 410.
   * The type is imported in place so that this stage changes nothing outside its block.
   */
  coachCopy: (grantId: string) => request<import("../shared/sharing").SharedView>("GET", `/api/coach/clients/${encodeURIComponent(grantId)}/copy`),
};
