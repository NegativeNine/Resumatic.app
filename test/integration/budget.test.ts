import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { signIn } from "./support";

it("requires the staging secret to fix an immutable synthetic-account budget", async () => {
  const user = await signIn();
  const budget = { maxCostMicros: 100000, maxCalls: 10 };
  const post = (secret: string, body: unknown) =>
    user.fetch("/api/test/model-budget", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-signin-key": secret,
      },
      body: JSON.stringify(body),
    });
  expect((await post("wrong", budget)).status).toBe(403);
  expect((await post(env.TEST_SIGNIN_KEY!, budget)).status).toBe(204);
  expect((await post(env.TEST_SIGNIN_KEY!, budget)).status).toBe(204);
  expect(
    (await post(env.TEST_SIGNIN_KEY!, { ...budget, maxCalls: 11 })).status,
  ).toBe(409);
});

it("keeps staging test endpoints closed when test sign-in is disabled, even with a secret", async () => {
  const user = await signIn();
  const old = env.ALLOW_TEST_SIGNIN;
  try {
    env.ALLOW_TEST_SIGNIN = "false";
    const login = await user.send("POST", "/auth/test-login", {
      email: "test@example.com",
    });
    expect(login.status).toBe(404);
    const result = await user.fetch("/api/test/model-budget", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-signin-key": env.TEST_SIGNIN_KEY!,
      },
      body: JSON.stringify({ maxCostMicros: 100000, maxCalls: 10 }),
    });
    expect(result.status).toBe(404);
  } finally {
    env.ALLOW_TEST_SIGNIN = old;
  }
});
