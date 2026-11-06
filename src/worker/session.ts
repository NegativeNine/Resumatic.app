import { signToken, verifyToken } from "./crypto";

export const SESSION_COOKIE = "__Host-session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What the session cookie carries: the user, their vault, the session generation and an expiry. */
export interface Session {
  epoch?: string;
  uid: string;
  vid: string;
  gen: number;
  exp: number;
}

export async function createSession(
  secret: string,
  s: { uid: string; vid: string; gen: number; epoch?: string },
  now = Date.now(),
): Promise<string> {
  return signToken(secret, {
    ...s,
    exp: now + SESSION_TTL_MS,
  } satisfies Session);
}

export async function readSession(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): Promise<Session | null> {
  const s = await verifyToken<Session>(secret, token);
  if (
    !s ||
    typeof s.uid !== "string" ||
    typeof s.vid !== "string" ||
    typeof s.gen !== "number"
  )
    return null;
  if (typeof s.exp !== "number" || s.exp <= now) return null;
  return s;
}

/** Set-Cookie value for the session: host-only, HTTPS-only, invisible to scripts, sent on top-level navigation. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
