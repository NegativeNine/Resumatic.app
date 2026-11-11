export interface LimitBindings {
  RATE_LIMITS_ENABLED?: string;
  AUTH_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  WRITE_LIMIT?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  SESSION_KEY: string;
}

export type HttpRoute =
  | "auth"
  | "oauth"
  | "mcp"
  | "sources"
  | "generation"
  | "account"
  | "admin"
  | "other";
export function httpRoute(path: string): HttpRoute {
  if (path.startsWith("/auth/")) return "auth";
  if (path.startsWith("/oauth/")) return "oauth";
  if (path === "/mcp") return "mcp";
  if (path.startsWith("/api/sources")) return "sources";
  if (
    /^\/api\/(applications\/[^/]+\/(resumes|documents)|resumes\/[^/]+\/refine|shares\/suggestions\/[^/]+\/accept)/.test(
      path,
    )
  )
    return "generation";
  if (path.startsWith("/api/account") || path.startsWith("/api/billing"))
    return "account";
  if (path.startsWith("/admin/")) return "admin";
  return "other";
}

/** Burst protection is approximate and per Cloudflare location; Vault quotas remain authoritative. */
export async function rateLimitRequest(
  request: Request,
  env: LimitBindings,
  userId?: string,
): Promise<Response | null> {
  if (env.RATE_LIMITS_ENABLED === "false") return null;
  const path = new URL(request.url).pathname;
  const anonymous =
    !userId &&
    (path.startsWith("/auth/") ||
      path.startsWith("/oauth/") ||
      path === "/mcp" ||
      path === "/share/session");
  const write = userId && !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const binding = anonymous
    ? env.AUTH_LIMIT
    : write
      ? env.WRITE_LIMIT
      : undefined;
  if (!binding || request.method === "OPTIONS") return null;
  let key: string;
  if (userId) key = `user:${userId}`;
  else {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const secret = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SESSION_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      secret,
      new TextEncoder().encode(`burst:${ip}`),
    );
    key = `guest:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  const reply = (status: number, error: string, message: string) =>
    new Response(JSON.stringify({ error, message }), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "60",
      },
    });
  try {
    return (await binding.limit({ key })).success
      ? null
      : reply(429, "quota", "Too many requests. Try again in a minute.");
  } catch {
    return reply(
      503,
      "unavailable",
      "Request protection is temporarily unavailable.",
    );
  }
}

export function recordHttp(
  env: { METRICS?: AnalyticsEngineDataset },
  event: { route: HttpRoute; status: number; ms: number; vaultId?: string },
): void {
  if (
    !Number.isInteger(event.status) ||
    !Number.isFinite(event.ms) ||
    event.ms < 0
  )
    return;
  env.METRICS?.writeDataPoint({
    indexes: [event.vaultId ?? "http"],
    blobs: ["", "http", event.route, "", event.status >= 500 ? "failed" : "ok"],
    doubles: [event.ms, 0, 0, 0],
  });
}
