import { readFileSync } from "node:fs";
import { chatComplete } from "../../src/ai/llm";
import { ROUTE_TEMPERATURE, modelFor, type Models } from "../../src/ai/models";
import {
  CLAIRIC_MODEL,
  fieldRequest,
  parseFieldResult,
} from "../../src/ai/fields";
import { reportUsage, type UsageObserver } from "../../src/ai/usage";
import { rerankScores } from "../../src/ai/rerank";
import { EvalBudget, evalBudgetFromEnv } from "../extract-evals/budget";
import { sharedPilotFromEnv, type SharedPilot } from "./shared-pilot.mjs";

// The real models, called over Cloudflare's REST API from Node, with the same model names the
// Worker uses (read from wrangler.jsonc) and the same chat client.

export interface EvalCredentials {
  accountId: string;
  token: string;
  gatewayId: string;
}

export function credentials(): EvalCredentials | null {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_AI_TOKEN;
  const gatewayId = process.env.AI_GATEWAY_ID;
  if (!accountId || !token || !gatewayId || !/^[a-z0-9-]{1,64}$/.test(gatewayId)) return null;
  return {
    accountId,
    token,
    gatewayId,
  };
}

/** Vars from wrangler.jsonc, top level or for one environment. Comments are stripped outside strings. */
export function wranglerVars(environment?: string): Record<string, string> {
  const text: string = readFileSync(
    decodeURIComponent(
      new URL("../../wrangler.jsonc", import.meta.url).pathname,
    ),
    "utf8",
  );
  let json = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      json += c;
      if (c === "\\") json += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      json += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      json += "\n";
    } else {
      json += c;
    }
  }
  const config = JSON.parse(json.replace(/,(\s*[}\]])/g, "$1")) as {
    vars: Record<string, string>;
    env?: Record<string, { vars?: Record<string, string> }>;
  };
  return environment ? (config.env?.[environment]?.vars ?? {}) : config.vars;
}

async function workersAi<T>(
  creds: EvalCredentials,
  model: string,
  body: unknown,
  budget: EvalBudget,
  pilot: SharedPilot,
  onUsage: UsageObserver,
  route: string,
  passes = 1,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Every call is routed through the configured gateway. Until the live
    // retry policy is established, reserve for the platform's documented
    // maximum of five retries in addition to the initial request. Clairic may
    // also make one internal extraction pass per requested field.
    const gatewayAttempts = 6;
    const bound = passes * gatewayAttempts;
    const attemptId = await reserveBoth(budget, pilot,
      model,
      JSON.stringify(body),
      0,
      bound,
      bound,
    );
    let res: Response;
    try {
      res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${model}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${creds.token}`,
            "content-type": "application/json",
            "cf-aig-gateway-id": creds.gatewayId,
            "cf-aig-collect-log-payload": "false",
            "cf-aig-skip-cache": "true",
            "cf-aig-max-attempts": "1",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        },
      );
    } catch (error) {
      await failBoth(budget, pilot, attemptId);
      throw error;
    }
    if (res.ok) {
      let result: T;
      try {
        result = ((await res.json()) as { result: T }).result;
      } catch (error) {
        await failBoth(budget, pilot, attemptId);
        throw error;
      }
      await onUsage({
        ...reportUsage(route, model, (result as { usage?: unknown })?.usage),
        attemptId,
      });
      return result;
    }
    await failBoth(budget, pilot, attemptId);
    if (attempt >= 2 || res.status < 500)
      throw new Error(`model request failed with HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function reserveBoth(budget: EvalBudget, pilot: SharedPilot, model: string, input: string,
  output: number, passes: number, calls: number, id?: string): Promise<string> {
  const attemptId = budget.reserve(model, input, output, passes, calls, id);
  try { await pilot.reserve(attemptId, budget.reservation(attemptId), calls); }
  catch (error) {
    try { budget.failAttempt(attemptId); } finally { await pilot.freeze().catch(() => {}); }
    throw error;
  }
  return attemptId;
}

async function failBoth(budget: EvalBudget, pilot: SharedPilot, id: string): Promise<void> {
  try { await pilot.settle(id, null); } catch { await pilot.freeze().catch(() => {}); }
  budget.failAttempt(id);
}

export function restModels(
  creds: EvalCredentials,
  vars: Record<string, string>,
  opts: { onUsage?: UsageObserver; budget?: EvalBudget; pilot?: SharedPilot } = {},
): Models {
  if (!/^[a-z0-9-]{1,64}$/.test(creds.gatewayId))
    throw new Error("evaluation_gateway_required");
  const env = vars as unknown as Env;
  // A supervised pilot must never accidentally replace its durable ledger with
  // an independently constructed, process-local budget.
  const sharedBudget = process.env.EVAL_BUDGET_LEDGER
    ? evalBudgetFromEnv()
    : undefined;
  if (sharedBudget && opts.budget && opts.budget !== sharedBudget)
    throw new Error("live_eval_ledger_required");
  if (sharedBudget && opts.pilot)
    throw new Error("shared_pilot_required");
  const budget = sharedBudget ?? opts.budget ?? evalBudgetFromEnv();
  // Every direct live adapter uses the same durable coordinator as staging.
  // Injection is used by hermetic tests; deployed eval runners use the
  // authenticated staging URL and key and never create/reset the ledger.
  const pilot = opts.pilot ?? sharedPilotFromEnv();
  const onUsage: UsageObserver = async (usage) => {
    if (!usage.attemptId) throw new Error("shared_pilot_unavailable");
    try { await pilot.settle(usage.attemptId, budget.actualMicros(usage)); }
    catch (error) {
      try { budget.failAttempt(usage.attemptId); } finally { await pilot.freeze().catch(() => {}); }
      throw error;
    }
    let observed;
    try { observed = budget.observe(usage); }
    catch (error) {
      // The shared reservation may already be settled; an unresolved local
      // ledger must still stop all subsequent supervised attempts.
      await pilot.freeze().catch(() => {});
      throw error;
    }
    await opts.onUsage?.(observed);
  };
  return {
    complete: (route, messages, schema, callOpts) =>
      chatComplete(
        {
          accountId: creds.accountId,
          token: creds.token,
          gatewayId: creds.gatewayId,
          model: callOpts?.model ?? modelFor(env, route),
          temperature: ROUTE_TEMPERATURE[route],
          route,
          onUsage,
          onAttemptError: ({ attemptId }) => failBoth(budget, pilot, attemptId),
          // Until verified live, cover the platform maximum of five retries.
          beforeAttempt: async (model, input, maxOutputTokens, attemptId) => {
            await reserveBoth(budget, pilot, model, input, maxOutputTokens, 6, 6, attemptId);
          },
        },
        messages,
        schema,
      ),
    async extractFields(state, fields, referenceDate) {
      const body = fieldRequest(state, fields, referenceDate);
      return parseFieldResult(
        await workersAi(
          creds,
          CLAIRIC_MODEL,
          body,
          budget,
          pilot,
          onUsage,
          "fields",
          Object.keys(fields).length,
        ),
      );
    },
    async embed(texts, callOpts) {
      const model =
        callOpts?.model ?? vars.EMBEDDING_MODEL ?? "@cf/baai/bge-m3";
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 50) {
        const { data } = await workersAi<{ data: number[][] }>(
          creds,
          model,
          { text: texts.slice(i, i + 50) },
          budget,
          pilot,
          onUsage,
          "embed",
        );
        if (
          !Array.isArray(data) ||
          data.length !== texts.slice(i, i + 50).length ||
          data.some(
            (v) =>
              !Array.isArray(v) ||
              v.length === 0 ||
              v.some((n) => !Number.isFinite(n)),
          ) ||
          data.some((v) => v.length !== (out[0]?.length ?? data[0]!.length))
        )
          throw new Error("embedding_response_shape");
        out.push(...data);
      }
      return out;
    },
    async rerank(query, texts) {
      if (texts.length === 0) return [];
      const result = await workersAi<unknown>(
        creds,
        "@cf/baai/bge-reranker-base",
        {
          query,
          contexts: texts.map((text) => ({ text })),
          top_k: texts.length,
        },
        budget,
        pilot,
        onUsage,
        "rerank",
      );
      return rerankScores(result, texts.length);
    },
    async toMarkdown(name, blob) {
      // Conversion pricing is not token-based; keep fixture acquisition an explicit live task.
      void name;
      void blob;
      throw new Error("eval_conversion_requires_frozen_fixture");
    },
  };
}
