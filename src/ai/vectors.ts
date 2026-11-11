import { AppError } from "../shared/errors";
import { modelAttempt, type ModelObservers } from "./usage";
import { rerankScores } from "./rerank";
import { usableEmbedding } from "../shared/embedding";
import { docxText } from "../pipeline/docx";
import { relevanceScores } from "./relevance";
import { embeddingInput } from "./embedding-input";

const EMBED_MODEL = "@cf/baai/bge-m3";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const EMBED_BATCH = 50;

/** Workers AI calls go through the same gateway, with logging off so no career text is stored. */
function gateway(env: Env) {
  return {
    gateway: { id: env.AI_GATEWAY_ID, collectLog: false, skipCache: true },
  };
}

/** Embeddings from the configured model, with a consistent dimension and input order. */
export async function embedTexts(
  env: Env,
  texts: string[],
  observers: ModelObservers = {},
  opts: { model?: string; purpose?: "query" | "document" } = {},
): Promise<number[][]> {
  const model = opts.model ?? env.EMBEDDING_MODEL ?? EMBED_MODEL;
  const run = env.AI.run.bind(env.AI) as (
    model: string,
    inputs: unknown,
    options: unknown,
  ) => Promise<{ data?: number[][]; usage?: unknown }>;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const input = embeddingInput(model, batch, opts.purpose);
    const res = await modelAttempt(
      {
        route: "embed",
        model,
        inputChars: JSON.stringify(input).length,
        maxOutputTokens: 0,
      },
      observers,
      () =>
        run(model, input, gateway(env)).catch(() => {
          throw new Error("embedding_request_failed");
        }),
      (response) => response.usage,
    );
    if (
      !res.data ||
      res.data.length !== batch.length ||
      res.data.some((v) => !usableEmbedding(v)) ||
      res.data.some(
        (v) => v.length !== (out[0]?.length ?? res.data![0]!.length),
      )
    )
      throw new Error("embedding call returned the wrong shape");
    out.push(...res.data);
  }
  return out;
}

/** Reranker scores for each text against the query, in the order of `texts`. */
export async function rerankTexts(
  env: Env,
  query: string,
  texts: string[],
  observers: ModelObservers = {},
): Promise<number[]> {
  if (texts.length === 0) return [];
  const model = env.RERANK_MODEL ?? RERANK_MODEL;
  if (model === "@cf/cloudflare/clef") return relevanceScores(env, query, texts, observers);
  if (model !== RERANK_MODEL) throw new AppError("unavailable", "model provider HTTP error");
  // The generated input type leaves out `query`, which the model requires.
  const inputs: Ai_Cf_Baai_Bge_Reranker_Base_Input & { query: string } = {
    query,
    contexts: texts.map((text) => ({ text })),
    top_k: texts.length,
  };
  const res = await modelAttempt(
    {
      route: "rerank",
      model: RERANK_MODEL,
      inputChars: JSON.stringify(inputs).length,
      maxOutputTokens: 0,
    },
    observers,
    () =>
      env.AI.run(RERANK_MODEL, inputs, gateway(env)).catch(() => {
        throw new Error("rerank_request_failed");
      }),
    (response) => (response as { usage?: unknown }).usage,
  );
  return rerankScores(res, texts.length);
}

/** PDF or DOCX to Markdown with Workers AI. */
export async function toMarkdown(
  env: Env,
  name: string,
  blob: Blob,
  observers: ModelObservers = {},
): Promise<string> {
  if (/\.docx$/i.test(name)) return docxText(new Uint8Array(await blob.arrayBuffer()));
  const result = await modelAttempt(
    {
      route: "convert",
      model: "toMarkdown",
      inputChars: blob.size,
      maxOutputTokens: 0,
    },
    observers,
    () =>
      env.AI.toMarkdown(
        { name, blob },
        { conversionOptions: { pdf: { metadata: false } } },
      ).catch(() => {
        throw new Error("conversion_request_failed");
      }),
    () => undefined,
  );
  if (result.format === "error")
    throw new AppError(
      "invalid",
      "This file couldn't be read. Try a Word file (.docx) or a PDF with selectable text.",
    );
  return result.data;
}
