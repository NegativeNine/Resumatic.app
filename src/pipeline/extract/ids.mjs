/** The shared accepted extractor-ID grammar for runtime routing and release checks. */
export function validExtractorId(value) {
  if (typeof value !== "string") return false;
  const id = value.startsWith("judge:") ? value.slice(6) : value;
  return id === "llm:default" || id === "clairic" ||
    /^(?:llm|segment):(?:@cf\/|[a-z0-9_-]+\/)[a-zA-Z0-9/_.-]+$/.test(id);
}
