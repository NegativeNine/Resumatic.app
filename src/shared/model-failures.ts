/** Fixed, non-content error details that are safe in Workflow metadata. */
const HTTP_STATUSES = [307, 400, 401, 402, 403, 404, 405, 408, 409, 413, 415, 422, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529] as const;
export const MODEL_FAILURE_DETAILS: readonly string[] = Object.freeze([
  "model provider network failure",
  "model provider request timed out",
  "model provider HTTP error",
  ...HTTP_STATUSES.map((status) => `model provider HTTP ${status}`),
]);

export function modelHttpFailureDetail(status: number): string {
  return HTTP_STATUSES.some((allowed) => allowed === status)
    ? `model provider HTTP ${status}`
    : "model provider HTTP error";
}
