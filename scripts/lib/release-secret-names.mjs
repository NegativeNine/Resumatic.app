/** A secret with one of these names could replace a model or extractor variable. */
export function validProductionSecretNames(secrets) {
  if (!Array.isArray(secrets)) return false;
  return secrets.every((secret) =>
    secret && typeof secret.name === "string" && secret.name.length > 0 &&
    secret.name !== "TEST_SIGNIN_KEY" && !secret.name.startsWith("MODEL_") &&
    !["EXTRACTOR", "EXTRACTOR_BY_FORMAT", "EXTRACTOR_EXPERIMENT"].includes(secret.name),
  );
}
