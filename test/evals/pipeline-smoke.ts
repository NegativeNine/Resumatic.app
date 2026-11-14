import type { Models } from "../../src/ai/models";
import { CLEF_MODEL, decisionJudge } from "../../src/ai/decision-judge";
import { reportUsage } from "../../src/ai/usage";
import { offers } from "../../src/pipeline/match";
import { splitLines } from "../../src/pipeline/split";
import { tagUpload, type ProposedTag } from "../../src/pipeline/tag";
import { MemoryStore, Taxonomy } from "../../src/taxonomy";
import { EvalBudget } from "../extract-evals/budget";
import { freezePilotLedger } from "../extract-evals/budget-ledger.mjs";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";
import type { EvalCredentials } from "./rest-models";

/** A tiny synthetic smoke, not the shared staging pilot or a release-quality evaluation. */
export const SMOKE_LIMITS = { usd: 1, weightedCalls: 50, expectedRequests: 8 } as const;
export const SMOKE_LIMITATIONS = [
  "Synthetic smoke only; no release or rollout eligibility.",
  "A predetermined adversarial split tests the real judge; Muse proposal generation is not exercised.",
  "No vector candidates, real taxonomy index, real resumes, deployed Workflow or full eval suite is tested.",
  "The independent durable ledger limits this isolated run only; shared-pilot identity remains unverified and unchanged.",
] as const;

const unused = async (): Promise<never> => { throw new Error("pipeline_smoke_unexpected_route"); };

export interface SmokeCheck { name: string; passed: boolean; detail: unknown }
export interface SmokeQuestion {
  suite: "extraction" | "tailoring";
  alias: string;
  claim: string;
  facts: string[];
  choice: "supported" | "unsupported" | "overstated" | null;
  probabilities: { supported: number; unsupported: number; overstated: number } | null;
  verdict: "supported" | "unsupported" | "overstated" | null;
  supportedThreshold: 0.8;
  failed: boolean;
}

/** Copy only reviewed decision fields, never the provider's full response or credentials. */
function diagnosticAnswer(raw: unknown): Pick<SmokeQuestion, "choice" | "probabilities"> {
  const answer = (raw as { answers?: { verdict?: { choice?: unknown; probabilities?: Record<string, unknown> } } })?.answers?.verdict;
  const choice = typeof answer?.choice === "string" && ["supported", "unsupported", "overstated"].includes(answer.choice) ? answer.choice as SmokeQuestion["choice"] : null;
  const p = answer?.probabilities;
  const valid = p && [p.supported, p.unsupported, p.overstated].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1);
  return { choice, probabilities: valid ? { supported: p.supported as number, unsupported: p.unsupported as number, overstated: p.overstated as number } : null };
}

/**
 * Calls only the production typed judge through Workers AI. Every request is reserved and
 * settled in the existing private ledger before its response is exposed. Unknown failures
 * freeze the campaign. Serial questions avoid dispatching more after a malformed answer.
 */
export function boundedSmokeModels(
  creds: EvalCredentials,
  ledger: string,
  suite: "extraction" | "tailoring",
  fetcher: typeof fetch = fetch,
  onQuestion?: (question: SmokeQuestion) => void,
): Models {
  if (!/^[a-f0-9]{32}$/i.test(creds.accountId) || !creds.token || !/^[a-z0-9-]{1,64}$/.test(creds.gatewayId))
    throw new Error("pipeline_smoke_credentials_required");
  const budget = new EvalBudget({ usd: 0.5, maxCalls: suite === "extraction" ? 18 : 32, ledger: { file: ledger, suite } });
  let answer: Pick<SmokeQuestion, "choice" | "probabilities"> = { choice: null, probabilities: null };
  const env = {
    AI_GATEWAY_ID: creds.gatewayId,
    AI: { async run(model: string, input: unknown) {
      if (model !== CLEF_MODEL) throw new Error("pipeline_smoke_unexpected_model");
      const body = JSON.stringify(input);
      const id = budget.reserve(model, body, 0, 6, 6);
      let value: { result?: unknown; success?: boolean };
      try {
        const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${model}`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
          headers: {
            authorization: `Bearer ${creds.token}`, "content-type": "application/json",
            "cf-aig-gateway-id": creds.gatewayId, "cf-aig-collect-log-payload": "false",
            "cf-aig-skip-cache": "true", "cf-aig-max-attempts": "1",
          }, body,
        });
        if (!response.ok) throw new Error("pipeline_smoke_provider_failed");
        value = await response.json() as typeof value;
        if (value.success === false || !value.result) throw new Error("pipeline_smoke_provider_failed");
      } catch {
        budget.failAttempt(id);
        throw new Error("pipeline_smoke_provider_failed");
      }
      budget.observe({ ...reportUsage("judge", model, (value.result as { usage?: unknown }).usage), attemptId: id });
      answer = diagnosticAnswer(value.result);
      return value.result;
    } },
  } as unknown as Env;
  return {
    async judge(items) {
      const verdicts = [];
      try {
        for (const item of items) {
          answer = { choice: null, probabilities: null };
          const question = { suite, alias: item.alias, claim: item.text, facts: item.facts.map((fact) => fact.text), supportedThreshold: 0.8 as const };
          try {
            const result = await decisionJudge(env, [item]);
            verdicts.push(...result.verdicts);
            onQuestion?.({ ...question, ...answer, verdict: result.verdicts[0]?.verdict ?? null, failed: false });
          } catch (error) {
            onQuestion?.({ ...question, ...answer, verdict: null, failed: true });
            throw error;
          }
        }
      } catch (error) {
        freezePilotLedger(ledger);
        throw error;
      }
      return { verdicts };
    },
    complete: unused, embed: unused, rerank: unused, toMarkdown: unused,
  };
}

/** Exactly eight judge questions on fixed, public synthetic fixtures. No career input is accepted. */
export async function runPipelineSmoke(splitModels: Models, otherModels: Models, onCheck?: (check: SmokeCheck) => void) {
  const checks: SmokeCheck[] = [];
  const record = (check: SmokeCheck) => { checks.push(check); onCheck?.(check); };
  const line = "Wrote the on-call runbooks and ran weekly incident reviews";
  // Word numbers: Wrote(0) the(1) on-call(2) runbooks(3) and(4) ran(5)
  // weekly(6) incident(7) reviews(8). Both wrong clauses use the line's words.
  const proposed: Models = { ...splitModels, complete: async (_route, _messages, schema) => schema.parse({ lines: [{ id: "1", parts: [
    { kind: "clause", words: [{ from: 0, to: 0 }, { from: 6, to: 8 }], of: null },
    { kind: "clause", words: [{ from: 1, to: 3 }, { from: 5, to: 5 }], of: null },
  ] }] }) };
  const [split] = await splitLines(proposed, [{ id: "synthetic-trap", text: line }]);
  record({ name: "wrong verb-object split refused", passed: split!.parts === null && split!.refusal === "reads_differently", detail: split });

  const same = await offers(otherModels, [{ later: { id: "later", text: "Cut deploy time from 40 minutes to 6 minutes" }, earlier: { id: "earlier", text: "Reduced deploy time from 40 minutes to 6 minutes" } }]);
  record({ name: "equivalent wording positive control", passed: same.length === 1 && same[0]!.relation === "same", detail: same });

  const credit = await offers(otherModels, [{ later: { id: "led", text: "Led the migration to Kubernetes" }, earlier: { id: "helped", text: "Helped lead the migration to Kubernetes" } }]);
  record({ name: "stronger credit never offered", passed: credit.length === 0, detail: credit });

  const texts = ["Wrote services in C++", "Never used C++", "Proposed rewriting services in C++"];
  const tags: ProposedTag[] = [];
  const taxonomy = new Taxonomy(new MemoryStore(TAXONOMY_FIXTURE));
  const report = await tagUpload(otherModels, taxonomy, {
    roles: [], facts: texts.map((text, i) => ({ id: `synthetic-${i}`, roleId: null, kind: "accomplishment", text, asWritten: false, held: [] })),
    total: { roles: 0, facts: texts.length },
  }, { model: CLEF_MODEL, taxonomyVersion: TAXONOMY_FIXTURE.info.version }, async (found) => { tags.push(...found); return { stored: found.length, refused: 0 }; }, async () => []);
  record({ name: "tagging exercised all three judge questions", passed: report.failed === undefined && report.asked === 3, detail: report });
  record({ name: "real skill use tagged, denial and intention untagged", passed: tags.length === 1 && tags[0]!.subject.id === "synthetic-0" && tags[0]!.conceptId === "onet:tool:c++", detail: tags });
  return { complete: true, passed: checks.every((check) => check.passed), models: { judge: CLEF_MODEL }, checks, limitations: SMOKE_LIMITATIONS };
}
