import type { z } from "zod";
import { chatComplete, type ChatMessage } from "./llm";
import { embedTexts, rerankTexts, toMarkdown } from "./vectors";
import { extractFields, type FieldResult, type FieldSpec } from "./fields";
import type { ModelObservers } from "./usage";
import { transcribePages, type TranscriptionInput } from "./transcribe";
import { CLEF_MODEL, decisionJudge } from "./decision-judge";
import type { JudgeItem, JudgeOut } from "./prompts";
export type { Usage } from "./usage";
export type { ModelAttempt, ModelObservers } from "./usage";

/** Every model call names its route; each route has its own model and settings. */
export type Route = "extract" | "analyze" | "write" | "repair" | "judge";

export const ROUTE_TEMPERATURE: Record<Route, number> = {
  extract: 0,
  analyze: 0,
  write: 0.4,
  repair: 0.2,
  judge: 0,
};

/** Model IDs come from vars, as "provider/model" names served through AI Gateway. */
export function modelFor(env: Env, route: Route): string {
  switch (route) {
    case "extract":
      return env.MODEL_EXTRACT;
    case "analyze":
      return env.MODEL_ANALYZE;
    case "write":
    case "repair":
      return env.MODEL_WRITE;
    case "judge":
      return env.MODEL_JUDGE;
  }
}

/** Everything the pipelines need from models. Tests and the eval runner supply their own. */
export interface Models {
  judge?(items: JudgeItem[]): Promise<z.infer<typeof JudgeOut>>;
  complete<T>(
    route: Route,
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    opts?: { model?: string },
  ): Promise<T>;
  /** Optional so existing deterministic adapters remain usable by the baseline strategy. */
  extractFields?(
    state: string,
    fields: Record<string, FieldSpec>,
    referenceDate: string,
  ): Promise<FieldResult>;
  transcribePages?(input: TranscriptionInput): Promise<{ markdown: string }>;
  embed(texts: string[], opts?: { model?: string; purpose?: "query" | "document" }): Promise<number[][]>;
  /** Relevance scores for texts against the query, in the same order as texts. */
  rerank(query: string, texts: string[]): Promise<number[]>;
  toMarkdown(name: string, blob: Blob): Promise<string>;
}

let override: ((env: Env) => Models) | null = null;

/** Replaces the models for tests. Pass null to restore the real ones. */
export function setModels(factory: ((env: Env) => Models) | null): void {
  override = factory;
}

export function models(env: Env, opts: ModelObservers = {}): Models {
  if (override) return override(env);
  return {
    ...(env.MODEL_JUDGE === CLEF_MODEL ? { judge: (items: JudgeItem[]) => decisionJudge(env, items, opts) } : {}),
    complete: (route, messages, schema, callOpts) =>
      chatComplete(
        {
          accountId: env.CF_ACCOUNT_ID,
          token: env.CF_AI_TOKEN,
          gatewayId: env.AI_GATEWAY_ID,
          model: callOpts?.model ?? modelFor(env, route),
          temperature: ROUTE_TEMPERATURE[route],
          route,
          ...opts,
        },
        messages,
        schema,
      ),
    extractFields: (state, fields, referenceDate) =>
      extractFields(env, state, fields, referenceDate, opts),
    transcribePages: (input) => transcribePages(env, input, opts),
    embed: (texts, callOpts) => embedTexts(env, texts, opts, callOpts),
    rerank: (query, texts) => rerankTexts(env, query, texts, opts),
    toMarkdown: (name, blob) => toMarkdown(env, name, blob, opts),
  };
}
