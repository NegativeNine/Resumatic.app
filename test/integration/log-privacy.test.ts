import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import { directory } from "../../src/shared/stubs";
import { app } from "../../src/worker/routes";
import worker from "../../src/worker/index";

const sensitive = "Synthetic private resume content";
function sensitiveError(): Error {
  const error = new Error(sensitive);
  error.name = sensitive;
  return error;
}

it("does not log an unhandled provider's mutable error name", async () => {
  const fakeNamespace = {
    idFromName: () => ({}),
    get: () => ({ googleAuthEpoch: async () => { throw sensitiveError(); } }),
  };
  const bindings = { ...env, DIRECTORY: fakeNamespace } as unknown as Env;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.fetch(new Request("https://resumatic.test/auth/login"), bindings);
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledWith("unhandled error", { code: "unexpected", route: "auth" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  } finally { log.mockRestore(); }
});

it.each(["non-error", "message-getter", "status-getter", "http-message-getter", "proxy"] as const)(
  "returns a fixed secure response and records metrics for a hostile %s throw",
  async (kind) => {
    const metric = vi.fn();
    let thrown: unknown = sensitive;
    if (kind === "message-getter") {
      const value = new Error("initial");
      Object.defineProperty(value, "message", { get() { throw new Error(sensitive); } });
      thrown = value;
    } else if (kind === "status-getter") {
      const value = new HTTPException(400);
      Object.defineProperty(value, "status", { get() { throw new Error(sensitive); } });
      thrown = value;
    } else if (kind === "http-message-getter") {
      const value = new HTTPException(400);
      Object.defineProperty(value, "message", { get() { throw new Error(sensitive); } });
      thrown = value;
    } else if (kind === "proxy") {
      thrown = new Proxy({}, { getPrototypeOf() { throw new Error(sensitive); } });
    }
    const fakeNamespace = {
      idFromName: () => ({}),
      get: () => ({ googleAuthEpoch: async () => { throw thrown; } }),
    };
    const bindings = { ...env, RATE_LIMITS_ENABLED: "false", DIRECTORY: fakeNamespace, METRICS: { writeDataPoint: metric } } as unknown as Env;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetch = worker.fetch as (request: Request, env: Env, context: ExecutionContext) => Promise<Response>;
      const response = await fetch(new Request("https://resumatic.test/auth/login"), bindings, {} as ExecutionContext);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal", message: "something went wrong" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(metric).toHaveBeenCalledWith(expect.objectContaining({ blobs: ["", "http", "auth", "", "failed"] }));
      expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
    } finally { log.mockRestore(); }
  },
);

it("preserves the stricter referrer policy when a share request fails before routing", async () => {
  const bindings = { ...env, RATE_LIMITS_ENABLED: "true", AUTH_LIMIT: { limit: async () => ({ success: true }) } } as unknown as Env;
  Object.defineProperty(bindings, "SESSION_KEY", { get() { throw sensitiveError(); } });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const fetch = worker.fetch as (request: Request, env: Env, context: ExecutionContext) => Promise<Response>;
    const response = await fetch(new Request("https://resumatic.test/share/session", { method: "POST" }), bindings, {} as ExecutionContext);
    expect(response.status).toBe(500);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  } finally { log.mockRestore(); }
});

it("does not turn a successful response into a failure when metrics throw", async () => {
  const fakeNamespace = {
    idFromName: () => ({}),
    get: () => ({ googleAuthEpoch: async () => 0 }),
  };
  const bindings = { ...env, RATE_LIMITS_ENABLED: "false", DIRECTORY: fakeNamespace, METRICS: { writeDataPoint() { throw sensitiveError(); } } } as unknown as Env;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const fetch = worker.fetch as (request: Request, env: Env, context: ExecutionContext) => Promise<Response>;
    const response = await fetch(new Request("https://resumatic.test/auth/login"), bindings, {} as ExecutionContext);
    expect(response.status).toBe(302);
    expect(log).toHaveBeenCalledWith("http metrics failed", { code: "unexpected" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  } finally { log.mockRestore(); }
});

it("logs only a fixed code if a deletion attempt throws an arbitrary error name", async () => {
  const global = directory(env);
  const subject = `log-privacy-${crypto.randomUUID()}@example.test`;
  const account = await global.signIn({ provider: "test", subject, email: subject, hint: "enam" });
  await global.deleteAccount(account.userId, account.vaultId);
  await runInDurableObject(global, async (instance) => {
    const fake = vi.spyOn(instance as unknown as { erase: (vaultId: string) => Promise<void> }, "erase")
      .mockRejectedValueOnce(sensitiveError());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await instance.alarm();
      expect(log).toHaveBeenCalledWith("deletion step failed", { vaultId: account.vaultId, code: "unexpected" });
      expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
    } finally { fake.mockRestore(); log.mockRestore(); }
  });
});
