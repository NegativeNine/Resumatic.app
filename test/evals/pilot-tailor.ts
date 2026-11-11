import type { Models, Route } from "../../src/ai/models";
import { checkLine } from "../../src/grounding/verdict";
import { analyzeJob, composeBody, selectFacts, verifyDraft, writeDraft } from "../../src/pipeline/tailor";
import type { FactRecord, RoleRecord } from "../../src/shared/types";
import { topMatches, toUnit } from "../../src/vault/search";
import { requireCitedDraft } from "./nonvacuity";

// A tiny independent synthetic case for the authorized exploratory run. The
// fact is treated as already confirmed, not as output of the extraction eval.
// This is not evidence of conversion, Workflow execution or real-user recall.
const role: RoleRecord = {
  id: "pilot-role", kind: "job", org: "Example Works", title: "Software Engineer",
  startDate: "2021-01", endDate: null,
};
const fact: FactRecord = {
  id: "pilot-fact", roleId: role.id, kind: "accomplishment",
  text: "Reduced deployment time by 35% with Kubernetes",
  quote: "Reduced deployment time by 35% with Kubernetes",
  level: "implemented", origin: "extracted", revision: 1,
};
const job = "Software Engineer. Requirement: reduce deployment time using Kubernetes.";

/** Exercise the production tailoring functions with synthetic confirmed facts. */
export async function runPilotTailoring(base: Models): Promise<void> {
  const calls = { embed: 0, rerank: 0, judge: 0 };
  const models: Models = {
    ...base,
    // A typed-decision judge is asked through `judge`, and a chat judge through `complete`.
    ...(base.judge ? { async judge(items: Parameters<NonNullable<Models["judge"]>>[0]) { calls.judge++; return base.judge!(items); } } : {}),
    async embed(texts, options) { calls.embed++; return base.embed(texts, options); },
    async rerank(query, texts) { calls.rerank++; return base.rerank(query, texts); },
    async complete<T>(route: Route, messages: Parameters<Models["complete"]>[1], schema: Parameters<Models["complete"]>[2], options?: Parameters<Models["complete"]>[3]): Promise<T> {
      if (route === "judge") calls.judge++;
      return base.complete(route, messages, schema, options) as Promise<T>;
    },
  };
  const facts = [fact], roles = [role];
  const embedded = await models.embed(facts.map((item) => item.text));
  const vectors = new Map(embedded.map((vector, index) => [facts[index]!.id, toUnit(vector)]));
  const analysis = await analyzeJob(models, job);
  const selection = await selectFacts(models, async (queries, k) => topMatches(queries, vectors, k), analysis, facts);
  const draft = await writeDraft(models, analysis, selection, facts, roles);
  const verified = await verifyDraft(models, draft, selection, facts);
  const body = composeBody(verified, roles, facts, selection);
  requireCitedDraft(body);
  if (calls.embed < 2 || calls.rerank < 1 || calls.judge < 1)
    throw new Error("pilot_tailoring_path_incomplete");
  const selected = new Set([...selection.factIds, ...selection.skillIds]);
  const byId = new Map(facts.map((item) => [item.id, item]));
  const lines = [
    ...(body.summary ? [{ ...body.summary, roleId: null }] : []),
    ...body.sections.flatMap((section) => section.lines.map((line) => ({ ...line, roleId: section.roleId }))),
  ];
  if (lines.some((line) => !checkLine(line, byId, selected).ok))
    throw new Error("pilot_tailoring_unsupported_line");
}
