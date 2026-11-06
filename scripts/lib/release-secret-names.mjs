/** Secret names cannot shadow any setting used by the extraction evaluation. */
export function validEvaluationSecretNames(secrets) {
  if (!Array.isArray(secrets)) return false;
  return secrets.every((secret) =>
    secret && typeof secret.name === "string" && secret.name.length > 0 &&
    !secret.name.startsWith("MODEL_") &&
    !["EXTRACTOR", "EXTRACTOR_BY_FORMAT", "EXTRACTOR_EXPERIMENT", "ROLE_UNKNOWN_END_ENABLED"].includes(secret.name),
  );
}
export function validProductionSecretNames(secrets) {
  return validEvaluationSecretNames(secrets) && secrets.every((secret) => !["TEST_SIGNIN_KEY", "R2_CACHE_FENCE_ENABLED", "PLACEMENT_FENCE_ENABLED"].includes(secret.name));
}
