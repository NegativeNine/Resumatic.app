import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "extract-evals",
          include: ["test/extract-evals/**/*.eval.ts"],
          environment: "node",
          testTimeout: 300_000,
        },
      },
      {
        // Pure code (grounding, location, session helpers) runs in plain Node.
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // The no-fabrication evals call the real models, so they run only on request (npm run evals)
        // and are skipped when CF_ACCOUNT_ID and CF_AI_TOKEN are not set.
        test: {
          name: "evals",
          include: ["test/evals/**/*.eval.ts"],
          environment: "node",
          testTimeout: 300_000,
        },
      },
      {
        // Worker, Durable Objects and Workflows run inside workerd, in the same isolate as the
        // tests, so the setModels and setPdfRenderer seams reach them.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Keep tests hermetic: Workers AI, AI Gateway, Google and Browser Run are never called for real.
            remoteBindings: false,
            miniflare: {
              // Production has no pilot binding; the staging-only coordinator
              // is explicitly bound here for local runtime integration tests.
              durableObjects: { PILOT_BUDGET: "PilotBudget" },
              bindings: {
                // Test-only secrets and settings. None of these values exist anywhere else.
                SESSION_KEY: "test-session-key-that-is-long-enough-0123456789",
                TEST_SIGNIN_KEY: "test-signin-key",
                PILOT_BUDGET_KEY: "test-pilot-key-for-local-only-1234567890",
                ALLOW_TEST_SIGNIN: "true",
                OIDC_CLIENT_ID: "test-client.apps.googleusercontent.com",
                OIDC_CLIENT_SECRET: "test-client-secret",
                CF_AI_TOKEN: "unused-in-tests",
                CF_ACCOUNT_ID: "test-account",
                ACCESS_TEAM_DOMAIN:
                  "https://resumatic-test.cloudflareaccess.com",
                ACCESS_AUD: "test-access-aud",
                // Deletion finishes in one alarm run instead of waiting an hour for the second sweep.
                SWEEP_DELAY_MS: "0",
                RATE_LIMITS_ENABLED: "false",
                TAILOR_MONTHLY_LIMIT: "3",
              },
            },
          }),
        ],
        test: {
          name: "integration",
          include: [
            "test/integration/**/*.test.ts",
            // Opt-in only: this asserts a known-unsatisfied release invariant
            // and is expected to exit nonzero until placement is fenced.
            ...(process.env.RESUMATIC_PLACEMENT_DIAGNOSTIC === "1"
              ? ["test/diagnostics/*.diagnostic.ts"]
              : []),
            // Large streamed RPC test uses substantial memory and runs on request.
            ...(process.env.RESUMATIC_REVIEW_STREAM_STRESS === "1"
              ? ["test/diagnostics/review-stream.stress.ts"]
              : []),
          ],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
