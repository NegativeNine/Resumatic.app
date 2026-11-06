import { afterEach, describe, expect, it, vi } from "vitest";
import { beginLogin, finishLogin, GOOGLE, OIDC_COOKIE } from "../../src/worker/oidc";
import { signToken } from "../../src/worker/crypto";
import { clearKeyCache } from "../../src/worker/jwt";
import { rsaSigner } from "../support/keys";

const env = {
  SESSION_KEY: "synthetic-session-secret",
  OIDC_CLIENT_ID: "synthetic-client",
  OIDC_CLIENT_SECRET: "synthetic-client-secret",
} as Env;

describe("OAuth state expiry", () => {
  afterEach(() => { vi.restoreAllMocks(); clearKeyCache(); });

  it.each(["token", "jwks"] as const)("rejects when state expires during %s I/O", async (slow) => {
    let now = Date.UTC(2026, 10, 1);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const signer = await rsaSigner();
    const start = await beginLogin(env, "https://resumatic.test", undefined, 37);
    const location = new URL(start.location);
    const cookie = start.cookie.split(";")[0]!.slice(`${OIDC_COOKIE}=`.length);
    const token = await signer.sign({
      iss: GOOGLE.issuers[0], aud: env.OIDC_CLIENT_ID, sub: "synthetic-subject",
      email: "synthetic@example.test", email_verified: true,
      nonce: location.searchParams.get("nonce"), exp: Math.floor(now / 1000) + 3600,
    });
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GOOGLE.token) {
        if (slow === "token") now += 10 * 60 * 1000;
        return Response.json({ id_token: token });
      }
      if (url === GOOGLE.jwks) {
        if (slow === "jwks") now += 10 * 60 * 1000;
        return Response.json(signer.jwks);
      }
      throw new Error("unexpected synthetic request");
    };
    await expect(finishLogin(env, "https://resumatic.test", new URLSearchParams({
      code: "synthetic", state: location.searchParams.get("state")!,
    }), cookie, fetcher)).rejects.toThrow("sign-in took too long");
  });

  it("returns the authenticated state expiry for later account and session checks", async () => {
    const now = Date.UTC(2026, 10, 1);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const signer = await rsaSigner();
    const start = await beginLogin(env, "https://resumatic.test", undefined, 37);
    const location = new URL(start.location);
    const cookie = start.cookie.split(";")[0]!.slice(`${OIDC_COOKIE}=`.length);
    const token = await signer.sign({
      iss: GOOGLE.issuers[0], aud: env.OIDC_CLIENT_ID, sub: "synthetic-subject",
      email: "synthetic@example.test", email_verified: true,
      nonce: location.searchParams.get("nonce"), exp: Math.floor(now / 1000) + 3600,
    });
    const fetcher = async (input: RequestInfo | URL) =>
      String(input) === GOOGLE.token ? Response.json({ id_token: token }) : Response.json(signer.jwks);
    expect(await finishLogin(env, "https://resumatic.test", new URLSearchParams({
      code: "synthetic", state: location.searchParams.get("state")!,
    }), cookie, fetcher)).toMatchObject({ subject: "synthetic-subject", authExpiryMs: now + 10 * 60 * 1000, authEpoch: 37 });
  });

  it("rejects a Google identity token whose not-before time is in the future", async () => {
    const now = Date.UTC(2026, 10, 1);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const signer = await rsaSigner();
    const start = await beginLogin(env, "https://resumatic.test", undefined, 37);
    const location = new URL(start.location);
    const cookie = start.cookie.split(";")[0]!.slice(`${OIDC_COOKIE}=`.length);
    const token = await signer.sign({
      iss: GOOGLE.issuers[0], aud: env.OIDC_CLIENT_ID, sub: "synthetic-subject",
      email: "synthetic@example.test", email_verified: true,
      nonce: location.searchParams.get("nonce"), exp: Math.floor(now / 1000) + 3600,
      nbf: Math.floor(now / 1000) + 300,
    });
    const fetcher = async (input: RequestInfo | URL) =>
      String(input) === GOOGLE.token ? Response.json({ id_token: token }) : Response.json(signer.jwks);
    await expect(finishLogin(env, "https://resumatic.test", new URLSearchParams({
      code: "synthetic", state: location.searchParams.get("state")!,
    }), cookie, fetcher)).rejects.toThrow("the identity token could not be verified");
  });
  it("rejects old signed cookies without an epoch before contacting Google", async () => {
    const cookie = await signToken(env.SESSION_KEY, { state: "old-state", nonce: "old-nonce", verifier: "old-verifier", exp: Date.now() + 60_000 });
    const fetcher = vi.fn();
    await expect(finishLogin(env, "https://resumatic.test", new URLSearchParams({ state: "old-state", code: "old-code" }), cookie, fetcher as unknown as typeof fetch)).rejects.toThrow("sign-in service changed");
    expect(fetcher).not.toHaveBeenCalled();
  });

});
