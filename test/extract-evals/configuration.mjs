import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "../../scripts/lib/config.mjs";

/** Bind promotion evidence to relevant checked-in code, dependencies and configured models.
 * This fingerprint is not an attestation of installed package integrity or provider behavior. */
export function extractionConfiguration(strategies, environment, opts = {}) {
  if (!["staging", "production"].includes(environment))
    throw new Error("extract_eval_environment_invalid");
  const root = opts.root ?? process.cwd();
  // A linked code root or manifest can otherwise change without a reviewable
  // repository change. Fail closed rather than silently follow it.
  for (const dir of ["src", "scripts", "test", "test/evals", "test/extract-evals"]) {
    if (!lstatSync(join(root, dir)).isDirectory()) throw new Error("extract_eval_source_invalid");
  }
  for (const file of ["wrangler.jsonc", "package.json", "package-lock.json", "vitest.config.ts"]) {
    if (!lstatSync(join(root, file)).isFile()) throw new Error("extract_eval_source_invalid");
  }
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
  // Hash complete code trees, not a hand-maintained import list. A new local
  // module can affect model requests, validation, scoring or orchestration.
  // Private cases are separately bound by manifestHash; bundled synthetic
  // fixtures are not used as the private promotion dataset.
  const paths = ["package.json", "package-lock.json", "vitest.config.ts"];
  const walk = (dir) => {
    const entries = readdirSync(join(root, dir), { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const file = `${dir}/${entry.name}`;
      if (file === "test/extract-evals/fixtures") continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) paths.push(file);
      else throw new Error("extract_eval_source_invalid");
    }
  };
  for (const dir of ["src", "scripts", "test/evals", "test/extract-evals"]) walk(dir);
  paths.sort();
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
    source: paths.map((file) => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")]),
  };
  return {
    models,
    behavior,
    hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}
