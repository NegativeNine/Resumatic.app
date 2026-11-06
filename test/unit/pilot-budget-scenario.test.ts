import { describe, expect, it } from "vitest";
import type { Models, Route } from "../../src/ai/models";
import { extractFacts } from "../../src/pipeline/distill";
import { judgeFacts, Entailment } from "../../src/pipeline/extract/judge";
import { analyzeJob, composeBody, selectFacts, verifyDraft, writeDraft } from "../../src/pipeline/tailor";
import type { FactRecord, RoleRecord } from "../../src/shared/types";
import { topMatches, toUnit } from "../../src/vault/search";
import { EvalBudget } from "../extract-evals/budget";
import { finishPilotSuite } from "../extract-evals/budget-ledger.mjs";
import { RESUME, JOB_DESCRIPTION, fakeModels } from "../support/fixtures";

// Invoked by the script test with an isolated temporary ledger; never calls a provider.
describe.skipIf(process.env.TEST_PILOT_BUDGET_SCENARIO !== "1")("pilot budget scenario", () => {
  it("runs a nonempty extraction and tailoring pipeline within the shared reservations", async () => {
    const file = process.env.EVAL_BUDGET_LEDGER!;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network must not be used"); };
    const makeModels = (suite: "extraction" | "tailoring", calls: number): Models => {
      const budget = new EvalBudget({
        usd: 5,
        maxCalls: calls,
        prices: { "provider/mock": [1, 1], "@cf/baai/bge-m3": [1, 0], "@cf/baai/bge-reranker-base": [1, 0] },
        ledger: { file, suite },
      });
      const base = fakeModels();
      const reserve = (model: string, input: unknown, outputTokens: number, weight: number) =>
        budget.reserve(model, JSON.stringify(input), outputTokens, weight, weight);
      const settle = (model: string, attemptId: string, outputTokens: number) =>
        budget.observe({ attemptId, model, route: "synthetic", inputTokens: 1, outputTokens, costUsd: null });
      return {
        ...base,
        async complete<T>(route: Route, messages: Parameters<Models["complete"]>[1], schema: Parameters<Models["complete"]>[2]): Promise<T> {
          const attempt = reserve("provider/mock", { route, messages }, 8192, 6);
          const out = schema === Entailment
            ? schema.parse({ verdicts: JSON.parse(messages.filter((m) => m.role === "user").at(-1)!.content).map(({ id }: { id: number }) => ({ id, verdict: "supported" })) })
            : await base.complete(route, messages, schema);
          settle("provider/mock", attempt, 1);
          return out as T;
        },
        async embed(texts, options) {
          const attempt = reserve("@cf/baai/bge-m3", texts, 0, 1);
          const out = await base.embed(texts, options);
          settle("@cf/baai/bge-m3", attempt, 0);
          return out;
        },
        async rerank(query, texts) {
          const attempt = reserve("@cf/baai/bge-reranker-base", { query, texts }, 0, 1);
          const out = await base.rerank(query, texts);
          settle("@cf/baai/bge-reranker-base", attempt, 0);
          return out;
        },
      };
    };
    try {
      const extractionModels = makeModels("extraction", 12);
      const extracted = await extractFacts(extractionModels, RESUME);
      expect(extracted.extraction.facts.length).toBeGreaterThan(0);
      expect(await judgeFacts(extractionModels, extracted.extraction.facts)).toHaveLength(extracted.extraction.facts.length);
      expect(finishPilotSuite(file, "extraction", true)).toBe(true);

      const models = makeModels("tailoring", 38);
      const { extraction } = await extractFacts(models, RESUME);
      const roles: RoleRecord[] = extraction.roles.map((r) => ({ id: `role-${r.key}`, kind: r.kind, org: r.org, title: r.title, startDate: r.startDate, endDate: r.endDate }));
      const facts: FactRecord[] = extraction.facts.map((f, i) => ({ id: `fact-${i + 1}`, roleId: f.roleKey ? `role-${f.roleKey}` : null, kind: f.kind, text: f.text, level: f.level, quote: f.quote }));
      const vectors = new Map((await models.embed(facts.map((f) => f.text))).map((v, i) => [facts[i]!.id, toUnit(v)]));
      const analysis = await analyzeJob(models, JOB_DESCRIPTION);
      const selection = await selectFacts(models, async (q, k) => topMatches(q, vectors, k), analysis, facts);
      const draft = await writeDraft(models, analysis, selection, facts, roles);
      const verified = await verifyDraft(models, draft, selection, facts);
      const body = composeBody(verified, roles, facts, selection);
      expect(body.sections.flatMap((section) => section.lines).length).toBeGreaterThan(0);
      expect(finishPilotSuite(file, "tailoring", true)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
