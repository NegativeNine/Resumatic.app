import { readFileSync } from "node:fs";
import { chatComplete } from "../../src/ai/llm";
import { ROUTE_TEMPERATURE, modelFor, type Models } from "../../src/ai/models";

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
  return { accountId, token, gatewayId: process.env.AI_GATEWAY_ID || "resumatic-staging" };
}

/** Vars from wrangler.jsonc, top level or for one environment. Comments are stripped outside strings. */
export function wranglerVars(environment?: string): Record<string, string> {
  const text: string = readFileSync(decodeURIComponent(new URL("../../wrangler.jsonc", import.meta.url).pathname), "utf8");
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
  const config = JSON.parse(json.replace(/,(\s*[}\]])/g, "$1")) as { vars: Record<string, string>; env?: Record<string, { vars?: Record<string, string> }> };
  return environment ? (config.env?.[environment]?.vars ?? {}) : config.vars;
}

async function workersAi<T>(creds: EvalCredentials, model: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return ((await res.json()) as { result: T }).result;
    if (attempt >= 2 || res.status < 500) throw new Error(`${model} failed with HTTP ${res.status}: ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

export function restModels(creds: EvalCredentials, vars: Record<string, string>): Models {
  const env = vars as unknown as Env;
  return {
    complete: (route, messages, schema) =>
      chatComplete(
        { accountId: creds.accountId, token: creds.token, gatewayId: creds.gatewayId, model: modelFor(env, route), temperature: ROUTE_TEMPERATURE[route], route },
        messages,
        schema,
      ),
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 50) {
        const { data } = await workersAi<{ data: number[][] }>(creds, "@cf/baai/bge-m3", { text: texts.slice(i, i + 50) });
        out.push(...data);
      }
      return out;
    },
    async rerank(query, texts) {
      if (texts.length === 0) return [];
      const { response } = await workersAi<{ response: { id: number; score: number }[] }>(creds, "@cf/baai/bge-reranker-base", {
        query,
        contexts: texts.map((text) => ({ text })),
      });
      const scores = new Array<number>(texts.length).fill(0);
      for (const r of response) scores[r.id] = r.score;
      return scores;
    },
    async toMarkdown() {
      throw new Error("evals start from Markdown");
    },
  };
}
