import { AppError } from "../shared/errors";
import {
  base64url,
  randomToken,
  sha256,
  signToken,
  verifyToken,
} from "./crypto";
import { verifyJwt } from "./jwt";

export const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};

export const OIDC_COOKIE = "__Host-oidc";
const OIDC_TTL_MS = 10 * 60 * 1000;

interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
  returnTo?: string;
}

function redirectUri(origin: string): string {
  return `${origin}/auth/callback`;
}

function requireConfig(env: Env): void {
  if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.SESSION_KEY) {
    throw new AppError("unavailable", "sign-in is not configured");
  }
}

/** Starts sign-in: a state, a nonce and a PKCE verifier go into a short-lived signed cookie. */
export async function beginLogin(
  env: Env,
  origin: string,
  returnTo?: string,
): Promise<{ location: string; cookie: string }> {
  requireConfig(env);
  const pending: PendingLogin = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    exp: Date.now() + OIDC_TTL_MS,
    returnTo: safeReturnTo(returnTo),
  };
  const params = new URLSearchParams({
    client_id: env.OIDC_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: "openid email",
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: base64url(await sha256(pending.verifier)),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  const token = await signToken(env.SESSION_KEY, pending);
  return {
    location: `${GOOGLE.authorize}?${params}`,
    cookie: `${OIDC_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${OIDC_TTL_MS / 1000}`,
  };
}

export function clearOidcCookie(): string {
  return `${OIDC_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Finishes sign-in: checks the state against the cookie, exchanges the code with the PKCE
 * verifier, and verifies the ID token's signature, issuer, audience, expiry and nonce.
 */
export async function finishLogin(
  env: Env,
  origin: string,
  query: URLSearchParams,
  cookieValue: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ subject: string; email: string; returnTo?: string }> {
  requireConfig(env);
  const pending = await verifyToken<PendingLogin>(env.SESSION_KEY, cookieValue);
  if (!pending || pending.exp < Date.now())
    throw new AppError("unauthenticated", "sign-in took too long; try again");
  if (query.get("error"))
    throw new AppError("unauthenticated", "sign-in was cancelled");
  const code = query.get("code");
  if (!code || query.get("state") !== pending.state)
    throw new AppError("unauthenticated", "sign-in could not be verified");

  const res = await fetcher(GOOGLE.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.OIDC_CLIENT_ID,
      client_secret: env.OIDC_CLIENT_SECRET,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  if (!res.ok)
    throw new AppError("unauthenticated", "Google did not accept the sign-in");
  const { id_token: idToken } = (await res.json()) as { id_token?: string };
  if (!idToken)
    throw new AppError("unauthenticated", "Google returned no identity");

  let claims;
  try {
    claims = await verifyJwt(idToken, {
      jwksUrl: GOOGLE.jwks,
      issuers: GOOGLE.issuers,
      audience: env.OIDC_CLIENT_ID,
      fetcher: (u) => fetcher(u),
    });
  } catch {
    throw new AppError(
      "unauthenticated",
      "the identity token could not be verified",
    );
  }
  if (claims.nonce !== pending.nonce)
    throw new AppError("unauthenticated", "sign-in could not be verified");
  // Only this application's client ID is trusted as an ID-token audience.
  // A token presented on behalf of another client must not establish a session.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    audiences.some((audience) => audience !== env.OIDC_CLIENT_ID) ||
    (claims.azp !== undefined && claims.azp !== env.OIDC_CLIENT_ID)
  )
    throw new AppError("unauthenticated", "sign-in could not be verified");
  const verified =
    claims.email_verified === true || claims.email_verified === "true";
  if (
    typeof claims.sub !== "string" ||
    !/^[\x21-\x7e]{1,255}$/.test(claims.sub) ||
    typeof claims.email !== "string" ||
    claims.email.length === 0 ||
    claims.email.length > 320 ||
    /[\x00-\x20\x7f]/.test(claims.email) ||
    !verified
  )
    throw new AppError("forbidden", "a verified email address is required");
  return {
    subject: claims.sub,
    email: claims.email,
    ...(safeReturnTo(pending.returnTo)
      ? { returnTo: safeReturnTo(pending.returnTo) }
      : {}),
  };
}

/** Only the local OAuth consent route may survive sign-in; never accept an arbitrary redirect. */
export function safeReturnTo(value?: string): string | undefined {
  if (!value || value.length > 8192 || /[\r\n\\]/.test(value)) return undefined;
  try {
    const url = new URL(value, "https://resumatic.invalid");
    return url.origin === "https://resumatic.invalid" &&
      value.startsWith("/") &&
      url.pathname === "/oauth/authorize" &&
      !url.hash
      ? url.pathname + url.search
      : undefined;
  } catch {
    return undefined;
  }
}
