import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Pure code (grounding, location, session helpers) runs in plain Node.
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // Worker, Durable Objects and Workflows run inside workerd.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Keep tests hermetic: Workers AI and Browser Run are never called for real here.
            remoteBindings: false,
          }),
        ],
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
        },
      },
    ],
  },
});
