import { test } from "node:test";
import assert from "node:assert/strict";
import { modelIndependence } from "./lib/model-independence.mjs";

test("model evidence is tied to distinct configured models and attested families", () => {
  const vars = { MODEL_WRITE: "anthropic/claude", MODEL_JUDGE: "openai/gpt" };
  const models = { writerModel: vars.MODEL_WRITE, judgeModel: vars.MODEL_JUDGE, writerFamily: "claude", judgeFamily: "gpt" };
  assert.equal(modelIndependence(models, vars), true);
  assert.equal(modelIndependence({ ...models, judgeModel: vars.MODEL_WRITE }, vars), false);
  assert.equal(modelIndependence({ ...models, judgeFamily: "claude" }, vars), false);
  assert.equal(modelIndependence({ ...models, judgeFamily: "" }, vars), false);
  const same = { MODEL_WRITE: "provider/model", MODEL_JUDGE: "PROVIDER/MODEL" };
  assert.equal(modelIndependence({ ...models, writerModel: same.MODEL_WRITE, judgeModel: same.MODEL_JUDGE }, same), false);
  assert.equal(modelIndependence(models, { ...vars, MODEL_WRITE: " anthropic/claude" }), false);
  assert.equal(modelIndependence(models, {}), false);
});
