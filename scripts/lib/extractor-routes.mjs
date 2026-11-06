import { validExtractorId } from "../../src/pipeline/extract/ids.mjs";

/** Return every configured production extractor, including possible experiment traffic. */
export function configuredExtractors(vars) {
  const fallback = vars.EXTRACTOR || "llm:default";
  if (!validExtractorId(fallback)) throw new Error("invalid_extractor");
  const selected = new Set([fallback]);
  if (vars.EXTRACTOR_BY_FORMAT) {
    const routes = JSON.parse(vars.EXTRACTOR_BY_FORMAT);
    if (!routes || typeof routes !== "object" || Array.isArray(routes)) throw new Error("invalid_routes");
    for (const [format, strategy] of Object.entries(routes)) {
      if (!["pdf", "docx", "linkedin", "ocr"].includes(format) || !validExtractorId(strategy)) throw new Error("invalid_routes");
      selected.add(strategy);
    }
  }
  if (vars.EXTRACTOR_EXPERIMENT) {
    const experiment = JSON.parse(vars.EXTRACTOR_EXPERIMENT);
    if (!experiment || typeof experiment !== "object" || Array.isArray(experiment) ||
      !validExtractorId(experiment.strategy) ||
      typeof experiment.percent !== "number" || !Number.isFinite(experiment.percent) ||
      experiment.percent < 0 || experiment.percent > 100) throw new Error("invalid_experiment");
    if (experiment.percent > 0) selected.add(experiment.strategy);
  }
  return { fallback, selected };
}
