import { AppError } from "../shared/errors";
import { verifyJwt } from "./jwt";

/**
 * Admin routes sit behind Cloudflare Access. The Worker also verifies the Access token itself,
 * so a request that bypasses Access (for example on the workers.dev hostname) is refused.
 */
export async function verifyAccess(env: Env, request: Request, fetcher: typeof fetch = fetch): Promise<{ email: string }> {
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "");
  if (!team || !env.ACCESS_AUD) throw new AppError("unavailable", "admin access is not configured");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AppError("forbidden", "Cloudflare Access token missing");
  try {
    const claims = await verifyJwt(token, {
      jwksUrl: `${team}/cdn-cgi/access/certs`,
      issuers: [team],
      audience: env.ACCESS_AUD,
      fetcher: (u) => fetcher(u),
    });
    return { email: typeof claims.email === "string" ? claims.email : "" };
  } catch {
    throw new AppError("forbidden", "Cloudflare Access token is not valid");
  }
}
