import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import { directory } from "../../src/shared/stubs";
import { base64url, fromBase64url, sha256 } from "../../src/worker/crypto";
import { GOOGLE } from "../../src/worker/oidc";
import { createSession } from "../../src/worker/session";
import { nowSeconds, rsaSigner } from "../support/keys";
import { call, cookieFrom, signIn, testLogin, uniqueEmail } from "./support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("test sign-in (staging only)", () => {
  it("requires the test key", async () => {
    const email = uniqueEmail();
    await directory(env).addInvite(email);
    expect((await testLogin(email, "wrong-key")).status).toBe(403);
    expect((await testLogin(email, "")).status).toBe(403);
  });

  it("does not need an invite, so the staging end-to-end check can make fresh accounts", async () => {
    expect((await testLogin(uniqueEmail("e2e"))).status).toBe(204);
  });

  it("returns the same user and vault on every sign-in", async () => {
    const email = uniqueEmail();
    const first = await signIn(email);
    const second = await signIn(email);
    const a = await first.json("/api/me");
    const b = await second.json("/api/me");
    expect(a.userId).toBe(b.userId);
    expect(a.quota).toMatchObject({ used: 0, limit: 3 });
  });

  it("gives racing first sign-ins the same vault", async () => {
    const email = uniqueEmail();
    await directory(env).addInvite(email);
    const results = await Promise.all([1, 2, 3].map(() => directory(env).signIn({ provider: "test", subject: email, email, hint: "enam" })));
    expect(new Set(results.map((r) => r.vaultId)).size).toBe(1);
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
  });
});

describe("invites", () => {
  it("are required for real sign-ups while sign-up is invite-only", async () => {
    const email = uniqueEmail("Stranger");
    const google = { provider: "google" as const, subject: `g-${email}`, email, hint: "enam" as const, authEpoch: await directory(env).googleAuthEpoch() };
    const refused = await directory(env)
      .signIn(google)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String(refused)).toMatch(/forbidden: /);
    await directory(env).addInvite(email.toUpperCase());
    expect((await directory(env).signIn(google)).vaultId).toBeTruthy();
  });
});

describe("the control plane", () => {
  it("is never on the path of an /api request", async () => {
    const user = await signIn();
    const methods = ["signIn", "deleteAccount", "listVaults", "addInvite", "removeInvite", "listInvites"] as const;
    const spies = methods.map((m) => vi.spyOn(Directory.prototype, m));
    try {
      for (const path of ["/api/me", "/api/profile", "/api/sources", "/api/roles", "/api/facts", "/api/applications", "/api/export"]) {
        expect((await user.fetch(path)).status, path).toBe(200);
      }
      expect((await user.send("PUT", "/api/profile", { name: "Jane" })).status).toBe(200);
      expect((await user.send("POST", "/api/review", { confirm: [], reject: [] })).status).toBe(204);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();

      // The spies do see Directory calls: signing in again is one.
      await signIn(user.email);
      expect(spies[0]).toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("sessions", () => {
  it("refuses API calls without a valid session cookie", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", { cookie: "__Host-session=not-a-token" })).status).toBe(401);

    const user = await signIn();
    const [body, mac] = user.cookie.slice("__Host-session=".length).split(".");
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body!)));
    const forged = base64url(new TextEncoder().encode(JSON.stringify({ ...claims, gen: claims.gen + 1 })));
    expect((await call("/api/me", { cookie: `__Host-session=${forged}.${mac}` })).status).toBe(401);
  });

  it("refuses an expired session", async () => {
    const user = await signIn();
    const me = await user.json("/api/me");
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(user.cookie.slice("__Host-session=".length).split(".")[0]!)));
    const old = await createSession(env.SESSION_KEY, { uid: me.userId, vid: claims.vid, gen: claims.gen }, Date.now() - 8 * 24 * 3600 * 1000);
    expect((await call("/api/me", { cookie: `__Host-session=${old}` })).status).toBe(401);
  });

  it("sets a host-only, HTTPS-only, script-invisible cookie", async () => {
    const email = uniqueEmail();
    await directory(env).addInvite(email);
    const res = await testLogin(email);
    const header = res.headers.getSetCookie().find((h) => h.startsWith("__Host-session="))!;
    expect(header).toMatch(/; Path=\//);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).not.toMatch(/Domain=/i);
  });

  it("signs out every session at once", async () => {
    const email = uniqueEmail();
    const laptop = await signIn(email);
    const phone = await signIn(email);
    expect((await phone.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    expect((await laptop.fetch("/api/me")).status).toBe(401);
    expect((await phone.fetch("/api/me")).status).toBe(401);
    const again = await signIn(email);
    expect((await again.fetch("/api/me")).status).toBe(200);
  });

  it("clears the cookie on logout", async () => {
    const user = await signIn();
    const res = await user.send("POST", "/auth/logout");
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().some((h) => h.startsWith("__Host-session=;") && h.includes("Max-Age=0"))).toBe(true);
  });

  it("refuses cross-site writes", async () => {
    const user = await signIn();
    const res = await user.fetch("/api/profile", {
      method: "PUT",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Mallory" }),
    });
    expect(res.status).toBe(403);
    expect((await user.json("/api/profile")).name).toBe("");
  });

  it("adds security headers and keeps personal data out of caches", async () => {
    const user = await signIn();
    const res = await user.fetch("/api/me");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Google sign-in", () => {
  async function stubGoogle(claims: (nonce: string) => Record<string, unknown>) {
    const signer = await rsaSigner();
    const seen: { verifier?: string; redirectUri?: string } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === GOOGLE.jwks) return Response.json(signer.jwks);
      if (url === GOOGLE.token) {
        const form = new URLSearchParams(String(init?.body));
        seen.verifier = form.get("code_verifier") ?? undefined;
        seen.redirectUri = form.get("redirect_uri") ?? undefined;
        if (form.get("code") !== "good-code") return new Response("bad code", { status: 400 });
        return Response.json({ id_token: await signer.sign(claims(pending.nonce)) });
      }
      return new Response("unexpected fetch in test", { status: 599 });
    });
    const pending = { nonce: "" };
    return { signer, seen, pending };
  }

  async function startLogin() {
    const res = await call("/auth/login");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    const cookie = cookieFrom(res, "__Host-oidc")!;
    expect(cookie).toBeTruthy();
    return { location, cookie };
  }

  it("signs in with a verified Google identity, checking state, nonce and PKCE", async () => {
    const email = uniqueEmail("google");
    await directory(env).addInvite(email);
    const google = await stubGoogle((nonce) => ({
      iss: "https://accounts.google.com",
      aud: env.OIDC_CLIENT_ID,
      sub: `google-${email}`,
      email,
      email_verified: true,
      nonce,
      exp: nowSeconds() + 600,
      iat: nowSeconds(),
    }));

    const { location, cookie } = await startLogin();
    expect(location.origin + location.pathname).toBe(GOOGLE.authorize);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBe("openid email");
    google.pending.nonce = location.searchParams.get("nonce")!;

    const res = await call(`/auth/callback?code=good-code&state=${location.searchParams.get("state")}`, { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const session = cookieFrom(res, "__Host-session");
    expect(session).toBeTruthy();
    expect(res.headers.getSetCookie().some((h) => h.startsWith("__Host-oidc=;"))).toBe(true);

    // The verifier sent to Google matches the challenge sent to the browser.
    expect(base64url(await sha256(google.seen.verifier!))).toBe(location.searchParams.get("code_challenge"));
    expect(google.seen.redirectUri).toBe("https://resumatic.test/auth/callback");
    expect((await call("/api/me", { cookie: session! })).status).toBe(200);
  });

  it("does not establish a session if another account was deleted after OAuth start", async () => {
    const email = uniqueEmail("google-stale");
    await directory(env).addInvite(email);
    const google = await stubGoogle((nonce) => ({
      iss: "https://accounts.google.com", aud: env.OIDC_CLIENT_ID,
      sub: `google-${email}`, email, email_verified: true, nonce,
      exp: nowSeconds() + 600,
    }));
    const otherEmail = uniqueEmail("other-account");
    const other = await directory(env).signIn({ provider: "test", subject: otherEmail, email: otherEmail, hint: "enam" });
    const { location, cookie } = await startLogin();
    google.pending.nonce = location.searchParams.get("nonce")!;
    await directory(env).deleteAccount(other.userId, other.vaultId);
    const res = await call(`/auth/callback?code=good-code&state=${location.searchParams.get("state")}`, { cookie });
    expect(res.headers.get("location")).toBe("/?error=conflict");
    expect(cookieFrom(res, "__Host-session")).toBeNull();
    expect(await directory(env).existingIdentity("google", `google-${email}`)).toBeNull();
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    await stubGoogle(() => ({}));
    const { cookie } = await startLogin();
    const res = await call("/auth/callback?code=good-code&state=forged", { cookie });
    expect(res.headers.get("location")).toBe("/?error=unauthenticated");
    expect(cookieFrom(res, "__Host-session")).toBeNull();
  });

  it("rejects a token with the wrong nonce or audience, or an unverified email", async () => {
    const email = uniqueEmail("google");
    await directory(env).addInvite(email);
    const base = { iss: "https://accounts.google.com", aud: env.OIDC_CLIENT_ID, sub: "g-1", email, email_verified: true, exp: nowSeconds() + 600 };
    for (const [variant, expected] of [
      [(nonce: string) => ({ ...base, nonce: `${nonce}x` }), "unauthenticated"],
      [(nonce: string) => ({ ...base, nonce, aud: "someone-else" }), "unauthenticated"],
      [(nonce: string) => ({ ...base, nonce, aud: [env.OIDC_CLIENT_ID, "untrusted-client"] }), "unauthenticated"],
      [(nonce: string) => ({ ...base, nonce, azp: "untrusted-client" }), "unauthenticated"],
      [(nonce: string) => ({ ...base, nonce, iss: "https://evil.example" }), "unauthenticated"],
      [(nonce: string) => ({ ...base, nonce, exp: nowSeconds() - 3600 }), "unauthenticated"],
      [(nonce: string) => ({ ...base, nonce, email_verified: false }), "forbidden"],
      [(nonce: string) => ({ ...base, nonce, sub: 42 }), "forbidden"],
      [(nonce: string) => ({ ...base, nonce, sub: "" }), "forbidden"],
      [(nonce: string) => ({ ...base, nonce, email: { value: email } }), "forbidden"],
      [(nonce: string) => ({ ...base, nonce, email: "user\n@example.com" }), "forbidden"],
    ] as const) {
      const google = await stubGoogle(variant);
      const { location, cookie } = await startLogin();
      google.pending.nonce = location.searchParams.get("nonce")!;
      const res = await call(`/auth/callback?code=good-code&state=${location.searchParams.get("state")}`, { cookie });
      expect(res.headers.get("location")).toBe(`/?error=${expected}`);
      vi.unstubAllGlobals();
    }
  });

  it("accepts the configured client as the sole audience and authorized party", async () => {
    const email = uniqueEmail("google-azp");
    await directory(env).addInvite(email);
    const google = await stubGoogle((nonce) => ({
      iss: "https://accounts.google.com", aud: [env.OIDC_CLIENT_ID],
      azp: env.OIDC_CLIENT_ID, sub: `google-${email}`, email,
      email_verified: true, nonce, exp: nowSeconds() + 600,
    }));
    const { location, cookie } = await startLogin();
    google.pending.nonce = location.searchParams.get("nonce")!;
    const res = await call(`/auth/callback?code=good-code&state=${location.searchParams.get("state")}`, { cookie });
    expect(res.headers.get("location")).toBe("/");
    expect(cookieFrom(res, "__Host-session")).toBeTruthy();
  });

  it("refuses an uninvited Google account", async () => {
    const email = uniqueEmail("uninvited");
    const google = await stubGoogle((nonce) => ({
      iss: "accounts.google.com",
      aud: env.OIDC_CLIENT_ID,
      sub: "g-uninvited",
      email,
      email_verified: "true",
      nonce,
      exp: nowSeconds() + 600,
    }));
    const { location, cookie } = await startLogin();
    google.pending.nonce = location.searchParams.get("nonce")!;
    const res = await call(`/auth/callback?code=good-code&state=${location.searchParams.get("state")}`, { cookie });
    expect(res.headers.get("location")).toBe("/?error=forbidden");
  });
});

describe("admin", () => {
  const team = () => env.ACCESS_TEAM_DOMAIN;

  async function accessToken(claims: Record<string, unknown> = {}) {
    const signer = await rsaSigner();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${team()}/cdn-cgi/access/certs`) return Response.json(signer.jwks);
      return new Response("unexpected fetch in test", { status: 599 });
    });
    return signer.sign({ iss: team(), aud: [env.ACCESS_AUD], email: "admin@example.com", exp: nowSeconds() + 600, ...claims });
  }

  it("refuses requests without a valid Cloudflare Access token", async () => {
    expect((await call("/admin/vaults")).status).toBe(403);
    expect((await call("/admin/vaults", { headers: { "cf-access-jwt-assertion": "nope" } })).status).toBe(403);
    const wrongAudience = await accessToken({ aud: ["another-app"] });
    expect((await call("/admin/vaults", { headers: { "cf-access-jwt-assertion": wrongAudience } })).status).toBe(403);
  });

  it("does not accept a user session in place of Access", async () => {
    const user = await signIn();
    expect((await user.fetch("/admin/vaults")).status).toBe(403);
  });

  it("lists vaults and manages invites", async () => {
    const token = await accessToken();
    const headers = { "cf-access-jwt-assertion": token, "content-type": "application/json" };
    const user = await signIn();
    const me = await user.json("/api/me");

    const vaults = await call("/admin/vaults?limit=200", { headers });
    expect(vaults.status).toBe(200);
    const { vaults: rows } = (await vaults.json()) as { vaults: { userId: string; state: string; email: string }[] };
    expect(rows.find((r) => r.userId === me.userId)).toMatchObject({ state: "active", email: user.email });

    const invitee = uniqueEmail("Invitee").toUpperCase();
    expect((await call("/admin/invites", { method: "POST", headers, body: JSON.stringify({ email: invitee }) })).status).toBe(201);
    const listed = (await (await call("/admin/invites", { headers })).json()) as { invites: { email: string }[] };
    expect(listed.invites.map((i) => i.email)).toContain(invitee.toLowerCase());
    expect((await testLogin(invitee.toLowerCase())).status).toBe(204);

    expect((await call(`/admin/invites/${encodeURIComponent(invitee)}`, { method: "DELETE", headers })).status).toBe(422);
    const operation = crypto.randomUUID();
    expect((await call(`/admin/invites/${encodeURIComponent(invitee)}`, { method: "DELETE", headers: { ...headers, "Idempotency-Key": operation } })).status).toBe(204);
    expect((await call(`/admin/invites/revocations/${operation}`, { headers })).status).toBe(200);
    const after = (await (await call("/admin/invites", { headers })).json()) as { invites: { email: string }[] };
    expect(after.invites.map((i) => i.email)).not.toContain(invitee.toLowerCase());
    expect((await call("/admin/invites", { method: "POST", headers, body: JSON.stringify({ email: invitee }) })).status).toBe(201);
    expect((await call(`/admin/invites/${encodeURIComponent(invitee)}`, { method: "DELETE", headers: { ...headers, "Idempotency-Key": operation } })).status).toBe(204);
    const reissued = (await (await call("/admin/invites", { headers })).json()) as { invites: { email: string }[] };
    expect(reissued.invites.map((i) => i.email)).toContain(invitee.toLowerCase());
  });
});
