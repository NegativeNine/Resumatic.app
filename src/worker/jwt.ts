import { fromBase64url } from "./crypto";

export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  [claim: string]: unknown;
}

type Fetcher = (input: string) => Promise<Response>;

interface KeySet {
  keys: (JsonWebKey & { kid?: string })[];
  fetchedAt: number;
}

const KEYSET_TTL_MS = 60 * 60 * 1000;
const keysets = new Map<string, KeySet>();

/** Fetches and caches a JSON Web Key Set; refetches when a key ID is unknown or the cache is old. */
async function keyFor(url: string, kid: string, fetcher: Fetcher): Promise<JsonWebKey | null> {
  let set = keysets.get(url);
  const stale = !set || Date.now() - set.fetchedAt > KEYSET_TTL_MS;
  if (stale || !set!.keys.some((k) => k.kid === kid)) {
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`key set fetch failed with HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    set = { keys: body.keys ?? [], fetchedAt: Date.now() };
    keysets.set(url, set);
  }
  return set!.keys.find((k) => k.kid === kid) ?? null;
}

/** For tests: forget cached key sets. */
export function clearKeyCache(): void {
  keysets.clear();
}

/**
 * Verifies an RS256 JSON Web Token against a key set URL, then checks issuer, audience and expiry.
 * Returns the claims, or throws with a short reason.
 */
export async function verifyJwt(
  token: string,
  opts: { jwksUrl: string; issuers: string[]; audience: string; fetcher?: Fetcher; now?: number },
): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(fromBase64url(headerPart))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new Error("unexpected token algorithm");
  const jwk = await keyFor(opts.jwksUrl, header.kid, opts.fetcher ?? ((u) => fetch(u)));
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64url(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("bad token signature");
  const claims = JSON.parse(decoder.decode(fromBase64url(payloadPart))) as JwtClaims;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!claims.iss || !opts.issuers.includes(claims.iss)) throw new Error("unexpected token issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(opts.audience)) throw new Error("unexpected token audience");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + 60 < now) throw new Error("token expired");
  // Apply the same one-minute clock-skew allowance as expiration. An
  // explicitly malformed not-before value cannot be treated as absent.
  if (Object.hasOwn(claims, "nbf") &&
      (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + 60))
    throw new Error("token not yet valid");
  return claims;
}
