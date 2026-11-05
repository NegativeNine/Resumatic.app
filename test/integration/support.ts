import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { directory } from "../../src/shared/stubs";

export * from "../support/fixtures";

// Stand-ins for everything outside Cloudflare's local runtime: model calls, and a signed-in user
// made through the staging-only test sign-in route. Google and Access have their own tests.

export const ORIGIN = "https://resumatic.test";

export function uniqueEmail(tag = "user"): string {
  return `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

export async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cookie) headers.set("cookie", cookie);
  // Redirects are returned, not followed: a service binding would send them back to this Worker.
  return exports.default.fetch(new Request(ORIGIN + path, { redirect: "manual", ...rest, headers }));
}

/** The `name=value` part of a Set-Cookie header for the given cookie, or null. */
export function cookieFrom(res: Response, name: string): string | null {
  for (const header of res.headers.getSetCookie()) {
    const pair = header.split(";")[0]!;
    if (pair.startsWith(`${name}=`) && pair.length > name.length + 1) return pair;
  }
  return null;
}

export class User {
  constructor(
    readonly email: string,
    public cookie: string,
  ) {}

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return call(path, { ...init, cookie: this.cookie });
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  send(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  upload(filename: string, content: string | Uint8Array, type = "application/pdf"): Promise<Response> {
    const form = new FormData();
    form.set("file", new File([content], filename, { type }));
    return this.fetch("/api/sources", { method: "POST", body: form });
  }
}

/** Invites the email and signs in through POST /auth/test-login. */
export async function signIn(email = uniqueEmail()): Promise<User> {
  await directory(env).addInvite(email);
  const res = await testLogin(email);
  expect(res.status, await res.clone().text()).toBe(204);
  const cookie = cookieFrom(res, "__Host-session");
  expect(cookie).toBeTruthy();
  return new User(email, cookie!);
}

export function testLogin(email: string, key = env.TEST_SIGNIN_KEY ?? ""): Promise<Response> {
  return call("/auth/test-login", {
    method: "POST",
    headers: { "x-test-signin-key": key, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

export async function waitForSource(user: User, sourceId: string): Promise<{ state: string; error: string | null; proposed: number }> {
  return eventually(async () => {
    const { sources } = await user.json<{ sources: { id: string; state: string; error: string | null; proposed: number }[] }>("/api/sources");
    const source = sources.find((s) => s.id === sourceId);
    return source && source.state !== "queued" ? source : null;
  }, `source ${sourceId} to finish`);
}

export async function waitForResume(user: User, resumeId: string): Promise<any> {
  return eventually(async () => {
    const resume = await user.json(`/api/resumes/${resumeId}`);
    return resume.state !== "running" ? resume : null;
  }, `resume ${resumeId} to finish`);
}

