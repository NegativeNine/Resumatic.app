/** Secret names cannot shadow any setting used by the extraction evaluation. */
export function validEvaluationSecretNames(secrets) {
  if (!Array.isArray(secrets)) return false;
  return secrets.every((secret) =>
    secret && typeof secret.name === "string" && secret.name.length > 0 &&
    !secret.name.startsWith("MODEL_") &&
    !["EXTRACTOR", "EXTRACTOR_BY_FORMAT", "EXTRACTOR_EXPERIMENT", "ROLE_UNKNOWN_END_ENABLED"].includes(secret.name),
  );
}
// Keep this list limited to actual secret values. A new production secret
// requires a reviewed change here and in the operations documentation.
const PRODUCTION_SECRET_NAMES = new Set([
  "SESSION_KEY", "OIDC_CLIENT_SECRET", "CF_AI_TOKEN", "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET", "ALERT_WEBHOOK_URL", "CF_ANALYTICS_TOKEN",
]);

/** Secret values are opaque to preflight, so reject unknown names and any
 * secret that shadows a reviewed Wrangler variable. */
export function validProductionSecretNames(secrets, vars) {
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return false;
  const reviewedVariables = new Set(Object.keys(vars));
  return validEvaluationSecretNames(secrets) && secrets.every((secret) =>
    PRODUCTION_SECRET_NAMES.has(secret.name) && !reviewedVariables.has(secret.name),
  );
}
