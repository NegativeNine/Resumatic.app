/** Usage is reported for every attempt, including replies rejected by schema validation. */
export interface Usage {
  attemptId?: string;
  route: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null means unpriced/unreported, never free. */
  costUsd: number | null;
}

export type UsageObserver = (usage: Usage) => void | Promise<void>;
export interface ModelAttempt {
  attemptId: string;
  route: string;
  model: string;
  inputChars: number;
  maxOutputTokens: number;
}
export interface ModelObservers {
  onAttemptStart?: (attempt: ModelAttempt) => void | Promise<void>;
  onUsage?: UsageObserver;
  /** Failure does not imply zero provider spend; reservations may need reconciliation. */
  onAttemptError?: (attempt: ModelAttempt) => void | Promise<void>;
}

/** Await reservation before dispatch and settlement before exposing a model reply. */
export async function modelAttempt<T>(
  request: Omit<ModelAttempt, "attemptId">,
  observers: ModelObservers,
  invoke: () => Promise<T>,
  usageOf: (response: T) => unknown,
): Promise<T> {
  const attempt: ModelAttempt = { ...request, attemptId: crypto.randomUUID() };
  await observers.onAttemptStart?.(attempt);
  let response: T;
  try {
    response = await invoke();
  } catch (error) {
    await observers.onAttemptError?.(attempt);
    throw error;
  }
  await observers.onUsage?.({
    ...reportUsage(request.route, request.model, usageOf(response)),
    attemptId: attempt.attemptId,
  });
  return response;
}

/** USD per million tokens. Reviewed 2026-11-05; unknown models remain unpriced. */
export const MODEL_PRICES: Readonly<Record<string, readonly [number, number]>> =
  {
    "meta/muse-ember-1.0": [0.1, 0.5],
    "@cf/cloudflare/clef": [0.24, 0],
    "@cf/openai/gpt-oss-120b": [0.35, 0.75],
    "@cf/openai/gpt-oss-20b": [0.2, 0.3],
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [0.293, 2.253],
    "@cf/cloudflare/clairic": [0.1, 0],
    "@cf/baai/bge-m3": [0.012, 0],
    "@cf/baai/bge-reranker-base": [0.00311, 0], // Cloudflare model page, reviewed 2026-11-06
    "@cf/meta/llama-3.2-11b-vision-instruct": [0.0485, 0.676],
  };

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function reportUsage(route: string, model: string, raw: unknown): Usage {
  const source =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inputTokens = count(source.input_tokens ?? source.prompt_tokens);
  const outputTokens = count(source.output_tokens ?? source.completion_tokens);
  const price = MODEL_PRICES[model];
  const costUsd =
    price && inputTokens !== null && (outputTokens !== null || price[1] === 0)
      ? (inputTokens * price[0] + (outputTokens ?? 0) * price[1]) / 1_000_000
      : null;
  const usage = { route, model, inputTokens, outputTokens, costUsd };
  return usage;
}
