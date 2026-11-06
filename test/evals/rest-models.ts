import { readFileSync } from "node:fs";
import { chatComplete } from "../../src/ai/llm";
import { ROUTE_TEMPERATURE, modelFor, type Models } from "../../src/ai/models";
import {
  CLAIRIC_MODEL,
  fieldRequest,
  parseFieldResult,
} from "../../src/ai/fields";
import { reportUsage, type UsageObserver } from "../../src/ai/usage";
import { EvalBudget, evalBudgetFromEnv } from "../extract-evals/budget";

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
  if (!accountId || !token) return null;
  return {
    accountId,
    token,
    gatewayId: process.env.AI_GATEWAY_ID || "resumatic-staging",
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
  onUsage: UsageObserver,
  route: string,
  passes = 1,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Clairic may make up to one internal extraction pass per requested field.
    const attemptId = budget.reserve(
      model,
      JSON.stringify(body),
      0,
      passes,
      passes,
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
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        },
      );
    } catch (error) {
      budget.failAttempt(attemptId);
      throw error;
    }
    if (res.ok) {
      let result: T;
      try {
        result = ((await res.json()) as { result: T }).result;
      } catch (error) {
        budget.failAttempt(attemptId);
        throw error;
      }
      await onUsage({
        ...reportUsage(route, model, (result as { usage?: unknown })?.usage),
        attemptId,
      });
      return result;
    }
    budget.failAttempt(attemptId);
    if (attempt >= 2 || res.status < 500)
      throw new Error(`model request failed with HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

export function restModels(
  creds: EvalCredentials,
  vars: Record<string, string>,
  opts: { onUsage?: UsageObserver; budget?: EvalBudget } = {},
): Models {
  const env = vars as unknown as Env;
  // A supervised pilot must never accidentally replace its durable ledger with
  // an independently constructed, process-local budget.
  const sharedBudget = process.env.EVAL_BUDGET_LEDGER
    ? evalBudgetFromEnv()
    : undefined;
  if (sharedBudget && opts.budget && opts.budget !== sharedBudget)
    throw new Error("live_eval_ledger_required");
  const budget = sharedBudget ?? opts.budget ?? evalBudgetFromEnv();
  const onUsage: UsageObserver = async (usage) => {
    const observed = budget.observe(usage);
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
          onAttemptError: ({ attemptId }) => budget.failAttempt(attemptId),
          beforeAttempt: (model, input, maxOutputTokens, attemptId) =>
            // Until verified live, cover the platform maximum of five retries.
            {
              budget.reserve(model, input, maxOutputTokens, 6, 6, attemptId);
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
      const { response } = await workersAi<{
        response: { id: number; score: number }[];
      }>(
        creds,
        "@cf/baai/bge-reranker-base",
        {
          query,
          contexts: texts.map((text) => ({ text })),
        },
        budget,
        onUsage,
        "rerank",
      );
      const scores = new Array<number>(texts.length).fill(0);
      for (const r of response) scores[r.id] = r.score;
      return scores;
    },
    async toMarkdown(name, blob) {
      // Conversion pricing is not token-based; keep fixture acquisition an explicit live task.
      void name;
      void blob;
      throw new Error("eval_conversion_requires_frozen_fixture");
    },
  };
}
