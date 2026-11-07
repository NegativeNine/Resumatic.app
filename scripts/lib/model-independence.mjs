/** Compare reviewed model-family attestations with production configuration. */
export function modelIndependence(models, vars) {
  const writer = vars?.MODEL_WRITE;
  const judge = vars?.MODEL_JUDGE;
  const validId = (id) => typeof id === "string" && id.length > 0 && id === id.trim();
  const validFamily = (family) => typeof family === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(family);
  return Boolean(validId(writer) && validId(judge) && writer.toLowerCase() !== judge.toLowerCase() &&
    models?.writerModel === writer && models?.judgeModel === judge &&
    validFamily(models?.writerFamily) && validFamily(models?.judgeFamily) &&
    models.writerFamily !== models.judgeFamily);
}
