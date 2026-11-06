import type {
  ApiErrorBody,
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
  SourceView,
} from "../shared/api";
import type { DocumentView, NewDocument } from "../shared/documents";
import type { ShareGrant } from "../shared/sharing";

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
// Keys live only for the current page session; successful requests clear them.
const generationKeys = new Map<string, string>();
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
  const fingerprint = JSON.stringify([path, body]);
  const key = generationKeys.get(fingerprint) ?? crypto.randomUUID();
  generationKeys.set(fingerprint, key);
  // A later rejection does not establish whether an earlier request reached
  // the server. Keep the original key across every failure until a response
  // confirms the result, including a 4xx received while another attempt runs.
  const result = requireResponseFields(await request<T>("POST", path, body, key), fields);
  if (generationKeys.get(fingerprint) === key) generationKeys.delete(fingerprint);
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
  signOutEverywhere: () =>
    request<void>("POST", "/api/account/sign-out-everywhere"),

  uploadSource,
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
  review: (r: ReviewRequest) => request<void>("POST", "/api/review", r),

  addApplication: (jdText: string) =>
    generate<{ applicationId: string }>("/api/v2/applications", { jdText }, ["applicationId"]),
  applications: () =>
    request<{ applications: ApplicationView[] }>("GET", "/api/applications"),
  updateApplication: (
    id: string,
    patch: {
      status?: ApplicationStatus;
      appliedAt?: string | null;
      notes?: string;
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
  createShare: (selection: {
    factIds: string[];
    resumes: { id: string; version: number }[];
    expiresAt?: number;
  }) =>
    request<{ grant: ShareGrant; url: string }>(
      "POST",
      "/api/shares",
      selection,
    ),
  revokeShare: (id: string) =>
    request<void>("DELETE", `/api/shares/${encodeURIComponent(id)}`),
  exportUrl: "/api/export",
  exportArchiveUrl: "/api/export/archive",
};
