import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "../../scripts/lib/config.mjs";

/** Hash every strategy, verifier and scoring source plus the actual configured model IDs. */
export function extractionConfiguration(strategies, environment, opts = {}) {
  if (!["staging", "production"].includes(environment))
    throw new Error("extract_eval_environment_invalid");
  const root = opts.root ?? process.cwd();
  const config = parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  const vars =
    environment === "staging" ? config.env?.staging?.vars : config.vars;
  if (!vars || typeof vars !== "object")
    throw new Error("extract_eval_environment_invalid");
  const models = Object.fromEntries(
    Object.entries(vars)
      .filter(([key]) => key.startsWith("MODEL_"))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  if (vars.ROLE_UNKNOWN_END_ENABLED !== undefined && !["true", "false"].includes(vars.ROLE_UNKNOWN_END_ENABLED))
    throw new Error("extract_eval_environment_invalid");
  const behavior = { roleUnknownEnd: vars.ROLE_UNKNOWN_END_ENABLED === "true" };
  const paths = [
    "src/ai/prompts.ts",
    "src/ai/models.ts",
    "src/ai/llm.ts",
    "src/ai/usage.ts",
    "src/ai/vectors.ts",
    "src/ai/transcribe.ts",
    "src/pipeline/distill.ts",
    "src/pipeline/linkedin.ts",
    "src/pipeline/linkedin-extract.ts",
    "src/workflows/distill.ts",
    "src/shared/api.ts",
    "src/shared/types.ts",
    "test/evals/nonvacuity.ts",
    "test/evals/rest-models.ts",
    "test/extract-evals/cli.mjs",
    "test/extract-evals/run.eval.ts",
    "test/extract-evals/private-dataset.mjs",
    "src/ai/fields.ts",
    "test/extract-evals/configuration.mjs",
    "test/extract-evals/score.ts",
    "test/extract-evals/score-core.mjs",
    "test/extract-evals/budget.ts",
    "test/extract-evals/promotion.mjs",
    ...readdirSync(join(root, "src/pipeline/extract"))
      .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs"))
      .sort()
      .map((name) => `src/pipeline/extract/${name}`),
    ...readdirSync(join(root, "src/grounding"))
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => `src/grounding/${name}`),
  ];
  let prices = {};
  const inputPrices = opts.priceOverrides === undefined ? process.env.EVAL_MODEL_PRICES : JSON.stringify(opts.priceOverrides);
  if (inputPrices) {
    try {
      prices = JSON.parse(inputPrices);
    } catch {
      throw new Error("live_eval_price_invalid");
    }
    if (
      !prices ||
      typeof prices !== "object" ||
      Array.isArray(prices) ||
      Object.entries(prices).some(
        ([model, price]) =>
          !/^[A-Za-z0-9_@/:.\-]{1,240}$/.test(model) ||
          !Array.isArray(price) ||
          price.length !== 2 ||
          price.some(
            (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0,
          ) ||
          price.every((n) => n === 0),
      )
    )
      throw new Error("live_eval_price_invalid");
    prices = Object.fromEntries(
      Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  const payload = {
    strategies,
    environment,
    models,
    behavior,
    prices,
    source: paths.map((file) => [file, readFileSync(join(root, file), "utf8")]),
  };
  return {
    models,
    behavior,
    hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}
