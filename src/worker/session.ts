import { SESSION_TTL_MS } from "../shared/session";
import { signToken, verifyToken } from "./crypto";

export const SESSION_COOKIE = "__Host-session";
export { SESSION_TTL_MS };

/** What the session cookie carries: the user, their vault, the session generation and an expiry. */
export interface Session {
  epoch?: string;
  uid: string;
  vid: string;
  gen: number;
  exp: number;
  /**
   * The address the person signed in with, as the sign-in provider verified it, in lower case.
   * It is what lets someone be named as a coach by address. A session from before it was carried
   * has none, and acts as nobody's coach until the person signs in again.
   */
  email?: string;
}

/** A sign-in address as sessions and coach grants compare it. Null for anything that isn't one. */
export function sessionEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export async function createSession(
  secret: string,
  s: { uid: string; vid: string; gen: number; epoch?: string; email?: string },
  now = Date.now(),
): Promise<string> {
  const email = sessionEmail(s.email);
  return signToken(secret, {
    uid: s.uid,
    vid: s.vid,
    gen: s.gen,
    ...(s.epoch === undefined ? {} : { epoch: s.epoch }),
    ...(email ? { email } : {}),
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
  // Only a well-formed address counts. Anything else is a session without one.
  const email = sessionEmail(s.email);
  if (email) s.email = email;
  else delete s.email;
  return s;
}

/** Set-Cookie value for the session: host-only, HTTPS-only, invisible to scripts, sent on top-level navigation. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
