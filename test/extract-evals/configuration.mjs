import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { parseJsonc } from "../../scripts/lib/config.mjs";

/** Hash every strategy, verifier and scoring source plus the actual configured model IDs. */
export function extractionConfiguration(strategies, environment) {
  if (!["staging", "production"].includes(environment))
    throw new Error("extract_eval_environment_invalid");
  const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
  const vars =
    environment === "staging" ? config.env?.staging?.vars : config.vars;
  if (!vars || typeof vars !== "object")
    throw new Error("extract_eval_environment_invalid");
  const models = Object.fromEntries(
    Object.entries(vars)
      .filter(([key]) => key.startsWith("MODEL_"))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const paths = [
    "src/ai/prompts.ts",
    "src/ai/models.ts",
    "src/ai/llm.ts",
    "src/ai/usage.ts",
    "src/ai/vectors.ts",
    "test/evals/rest-models.ts",
    "test/extract-evals/run.eval.ts",
    "test/extract-evals/private-dataset.mjs",
    "src/ai/fields.ts",
    "test/extract-evals/configuration.mjs",
    "test/extract-evals/score.ts",
    "test/extract-evals/score-core.mjs",
    "test/extract-evals/budget.ts",
    "test/extract-evals/promotion.mjs",
    ...readdirSync("src/pipeline/extract")
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => `src/pipeline/extract/${name}`),
    ...readdirSync("src/grounding")
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => `src/grounding/${name}`),
  ];
  let prices = {};
  if (process.env.EVAL_MODEL_PRICES) {
    try {
      prices = JSON.parse(process.env.EVAL_MODEL_PRICES);
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
    prices,
    source: paths.map((file) => [file, readFileSync(file, "utf8")]),
  };
  return {
    models,
    hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}
