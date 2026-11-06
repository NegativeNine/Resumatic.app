import { afterEach, describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../../src/worker/crypto";
import { clearKeyCache, verifyJwt } from "../../src/worker/jwt";
import { SESSION_TTL_MS, createSession, readSession, sessionCookie } from "../../src/worker/session";
import { nowSeconds, rsaSigner } from "../support/keys";

const SECRET = "unit-test-secret";

describe("signed tokens", () => {
  it("round-trip, and reject tampering or the wrong key", async () => {
    const token = await signToken(SECRET, { uid: "u1", gen: 1 });
    expect(await verifyToken(SECRET, token)).toEqual({ uid: "u1", gen: 1 });
    expect(await verifyToken("another-secret", token)).toBeNull();
    const [body, mac] = token.split(".");
    expect(await verifyToken(SECRET, `${body}x.${mac}`)).toBeNull();
    expect(await verifyToken(SECRET, `${body}.${mac!.slice(0, -2)}AA`)).toBeNull();
    expect(await verifyToken(SECRET, "garbage")).toBeNull();
    expect(await verifyToken(SECRET, undefined)).toBeNull();
    expect(await verifyToken("", token)).toBeNull();
  });

  it("refuses to sign without a key", async () => {
    await expect(signToken("", {})).rejects.toThrow();
  });
});

describe("sessions", () => {
  it("expire after seven days", async () => {
    const issued = Date.UTC(2026, 10, 1);
    const token = await createSession(SECRET, { uid: "u1", vid: "v1", gen: 3 }, issued);
    expect(await readSession(SECRET, token, issued + SESSION_TTL_MS - 1)).toMatchObject({ uid: "u1", vid: "v1", gen: 3 });
    expect(await readSession(SECRET, token, issued + SESSION_TTL_MS)).toBeNull();
  });

  it("reject payloads of the wrong shape", async () => {
    const token = await signToken(SECRET, { uid: "u1", vid: "v1", gen: "3", exp: Date.now() + 1000 });
    expect(await readSession(SECRET, token)).toBeNull();
  });

  it("use a host-only cookie that scripts cannot read", () => {
    expect(sessionCookie("t")).toBe("__Host-session=t; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800");
  });
});

describe("verifyJwt", () => {
  afterEach(() => clearKeyCache());

  async function setup() {
    const signer = await rsaSigner();
    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      return Response.json(signer.jwks);
    };
    const opts = { jwksUrl: "https://issuer.test/certs", issuers: ["https://issuer.test"], audience: "app", fetcher };
    const claims = { iss: "https://issuer.test", aud: "app", sub: "s1", exp: nowSeconds() + 300 };
    return { signer, opts, claims, fetches: () => fetches };
  }

  it("accepts a valid token and caches the key set", async () => {
    const { signer, opts, claims, fetches } = await setup();
    expect((await verifyJwt(await signer.sign(claims), opts)).sub).toBe("s1");
    expect((await verifyJwt(await signer.sign({ ...claims, aud: ["other", "app"] }), opts)).sub).toBe("s1");
    expect(fetches()).toBe(1);
  });

  it("rejects bad signatures, algorithms, issuers, audiences and expired tokens", async () => {
    const { signer, opts, claims } = await setup();
    const other = await rsaSigner(signer.kid);
    await expect(verifyJwt(await other.sign(claims), opts)).rejects.toThrow("bad token signature");
    await expect(verifyJwt(await signer.sign(claims, { alg: "HS256" }), opts)).rejects.toThrow("unexpected token algorithm");
    await expect(verifyJwt(await signer.sign({ ...claims, iss: "https://evil.test" }), opts)).rejects.toThrow("unexpected token issuer");
    await expect(verifyJwt(await signer.sign({ ...claims, aud: "another-app" }), opts)).rejects.toThrow("unexpected token audience");
    await expect(verifyJwt(await signer.sign({ ...claims, exp: nowSeconds() - 120 }), opts)).rejects.toThrow("token expired");
    await expect(verifyJwt("a.b", opts)).rejects.toThrow("malformed token");
  });

  it("refetches the key set for an unknown key ID, then gives up", async () => {
    const { signer, opts, claims, fetches } = await setup();
    await verifyJwt(await signer.sign(claims), opts);
    await expect(verifyJwt(await signer.sign(claims, { kid: "rotated-away" }), opts)).rejects.toThrow("unknown signing key");
    expect(fetches()).toBe(2);
  });

  it("rejects a signed token whose expiry parses to infinity", async () => {
    const { signer, opts, claims } = await setup();
    const json = JSON.stringify({ ...claims, exp: null }).replace('"exp":null', '"exp":1e400');
    expect(JSON.parse(json).exp).toBe(Infinity);
    await expect(verifyJwt(await signer.signRaw(json), opts)).rejects.toThrow("token expired");
  });
});
