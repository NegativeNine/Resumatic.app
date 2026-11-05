import type {
  ApiErrorBody,
  ApplicationView,
  FactView,
  Me,
  NewFact,
  Profile,
  ResumeView,
  ReviewRequest,
  ReviewState,
  RolePatch,
  RoleView,
  SourceView,
} from "../shared/api";

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let payload: Partial<ApiErrorBody> = {};
    try {
      payload = (await res.json()) as ApiErrorBody;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, payload.error ?? "http_" + res.status, payload.message ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? await res.json() : undefined) as T;
}

export const api = {
  // Auth. Sign-in itself is a full-page navigation to /auth/login.
  loginUrl: "/auth/login",
  logout: () => request<void>("POST", "/auth/logout"),
  deleteAccount: () => request<{ deleting: true }>("DELETE", "/auth/account"),

  me: () => request<Me>("GET", "/api/me"),
  profile: () => request<Profile>("GET", "/api/profile"),
  updateProfile: (patch: Partial<Profile>) => request<Profile>("PUT", "/api/profile", patch),
  signOutEverywhere: () => request<void>("POST", "/api/account/sign-out-everywhere"),

  uploadSource: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ sourceId: string }>("POST", "/api/sources", form);
  },
  sources: () => request<{ sources: SourceView[] }>("GET", "/api/sources"),
  sourceFileUrl: (sourceId: string) => `/api/sources/${encodeURIComponent(sourceId)}/file`,

  roles: () => request<{ roles: RoleView[] }>("GET", "/api/roles"),
  updateRole: (id: string, patch: RolePatch) => request<void>("PATCH", `/api/roles/${encodeURIComponent(id)}`, patch),
  facts: (state?: ReviewState) =>
    request<{ facts: FactView[] }>("GET", state ? `/api/facts?state=${state}` : "/api/facts"),
  addFact: (fact: NewFact) => request<{ factId: string }>("POST", "/api/facts", fact),
  editFact: (id: string, text: string) => request<void>("PATCH", `/api/facts/${encodeURIComponent(id)}`, { text }),
  review: (r: ReviewRequest) => request<void>("POST", "/api/review", r),

  addApplication: (jdText: string) => request<{ applicationId: string }>("POST", "/api/applications", { jdText }),
  applications: () => request<{ applications: ApplicationView[] }>("GET", "/api/applications"),
  tailor: (applicationId: string) =>
    request<{ resumeId: string }>("POST", `/api/applications/${encodeURIComponent(applicationId)}/resumes`),
  resume: (id: string) => request<ResumeView>("GET", `/api/resumes/${encodeURIComponent(id)}`),
  editLine: (resumeId: string, lineId: string, text: string) =>
    request<void>(
      "PATCH",
      `/api/resumes/${encodeURIComponent(resumeId)}/lines/${encodeURIComponent(lineId)}`,
      { text },
    ),
  pdfUrl: (resumeId: string) => `/api/resumes/${encodeURIComponent(resumeId)}/pdf`,
  exportUrl: "/api/export",
};
