import { AppError } from "../shared/errors";

const EMBED_MODEL = "@cf/baai/bge-m3";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const EMBED_BATCH = 50;

/** Workers AI calls go through the same gateway, with logging off so no career text is stored. */
function gateway(env: Env) {
  return { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } };
}

/** bge-m3 embeddings, 1,024 values each, in the order of `texts`. */
export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = (await env.AI.run(EMBED_MODEL, { text: batch }, gateway(env))) as { data?: number[][] };
    if (!res.data || res.data.length !== batch.length) throw new Error("embedding call returned the wrong shape");
    out.push(...res.data);
  }
  return out;
}

/** Reranker scores for each text against the query, in the order of `texts`. */
export async function rerankTexts(env: Env, query: string, texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];
  // The generated input type leaves out `query`, which the model requires.
  const inputs: Ai_Cf_Baai_Bge_Reranker_Base_Input & { query: string } = {
    query,
    contexts: texts.map((text) => ({ text })),
  };
  const res = await env.AI.run(RERANK_MODEL, inputs, gateway(env));
  const scores = new Array<number>(texts.length).fill(0);
  for (const r of res.response ?? []) {
    if (typeof r.id === "number" && typeof r.score === "number") scores[r.id] = r.score;
  }
  return scores;
}

/** PDF or DOCX to Markdown with Workers AI. */
export async function toMarkdown(env: Env, name: string, blob: Blob): Promise<string> {
  const result = await env.AI.toMarkdown({ name, blob });
  if (result.format === "error") throw new AppError("invalid", `could not read ${name}: ${result.error}`);
  return result.data;
}
