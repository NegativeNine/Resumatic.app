import { z } from "zod";
import { AppError } from "../shared/errors";
import { signToken, verifyToken } from "./crypto";

export const SHARE_COOKIE = "__Host-share";
/**
 * Each shared copy has a cookie of its own, so a reader with two copies open (a coach with two
 * clients) reloads the right one. SHARE_COOKIE is the single cookie used before that: it is still
 * set, and still read when a request doesn't say which copy it wants.
 */
export function shareCookieName(grantId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(grantId))
    throw new AppError("gone", "this share link is unavailable or expired");
  return `${SHARE_COOKIE}-${grantId.toLowerCase()}`;
}
export const SHARE_SESSION_TTL_MS = 60 * 60 * 1000;
const Claims = z
  .object({
    kind: z.enum(["coach-link", "coach-session"]),
    vid: z.string().regex(/^[a-f0-9]{64}$/i),
    grantId: z.uuid(),
    epoch: z.string().min(1).max(128),
    exp: z.number().int().positive(),
  })
  .strict();
export type ShareClaims = z.infer<typeof Claims>;

function configured(secret: string): void {
  if (secret.length < 32)
    throw new AppError("unavailable", "sharing is not configured");
}

export async function createShareToken(
  secret: string,
  claims: Omit<ShareClaims, "kind">,
): Promise<string> {
  configured(secret);
  const parsed = Claims.safeParse({ ...claims, kind: "coach-link" });
  if (!parsed.success) throw new AppError("invalid", "invalid share grant");
  return signToken(secret, parsed.data);
}

export async function readShareToken(
  secret: string,
  token: string | null | undefined,
  kind: ShareClaims["kind"] = "coach-link",
  now = Date.now(),
): Promise<ShareClaims | null> {
  if (secret.length < 32 || !token || token.length > 4096) return null;
  const result = Claims.safeParse(await verifyToken<unknown>(secret, token));
  return result.success && result.data.kind === kind && result.data.exp > now
    ? result.data
    : null;
}

/** Invoke only after the Vault has checked the current grant and account epoch. */
export async function createShareSession(
  secret: string,
  link: ShareClaims,
  now = Date.now(),
  name: string = SHARE_COOKIE,
): Promise<string> {
  configured(secret);
  if (link.kind !== "coach-link" || link.exp <= now)
    throw new AppError("gone", "this share link has expired");
  const exp = Math.min(link.exp, now + SHARE_SESSION_TTL_MS);
  const token = await signToken(secret, {
    ...link,
    kind: "coach-session",
    exp,
  });
  const seconds = Math.max(0, Math.floor((exp - now) / 1000));
  return `${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
}

export function clearShareSession(): string {
  return `${SHARE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function shareLink(origin: string, token: string): string {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new AppError("invalid", "invalid sharing origin");
  // The secret never appears in an HTTP request target or Referer header.
  return `${url.origin}/share#${token}`;
}
