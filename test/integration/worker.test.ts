import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Worker", () => {
  it("serves /api/health without a session", async () => {
    const res = await exports.default.fetch("https://resumatic.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers unknown API routes with JSON errors", async () => {
    const res = await exports.default.fetch("https://resumatic.test/api/nope");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
    const auth = await exports.default.fetch("https://resumatic.test/auth/nope");
    expect(auth.status).toBe(404);
    expect(await auth.json()).toMatchObject({ error: "not_found" });
  });

  it("starts Google sign-in with a redirect", async () => {
    const res = await exports.default.fetch("https://resumatic.test/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  });
});
