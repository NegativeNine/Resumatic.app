import { z } from "zod";
import { modelAttempt, type ModelAttempt, type ModelObservers } from "./usage";
import { AppError } from "../shared/errors";
import { modelHttpFailureDetail } from "../shared/model-failures";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatConfig extends ModelObservers {
  accountId: string;
  token: string;
  gatewayId: string;
  model: string;
  temperature: number;
  /** Route name, used in error messages only. */
  route: string;
  timeoutMs?: number;
  /** Eval accounting reserves before each network attempt, including schema retries. */
  beforeAttempt?: (
    model: string,
    input: string,
    maxOutputTokens: number,
    attemptId: string,
  ) => void | Promise<void>;
  maxOutputTokens?: number;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

// Request bodies and provider errors may contain career text. Emit only a
// reviewed event, a bounded route code and the numeric HTTP status (0 for a
// network failure); never log an exception or provider response.
function logRequestFailure(route: string, status: number): void {
  const safeRoute = ["extract", "analyze", "write", "repair", "judge"].includes(route) ? route : "other";
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  console.error(JSON.stringify({ event: "model_request_failed", route: safeRoute, status: safeStatus }));
}

/**
 * One structured completion through AI Gateway's OpenAI-compatible REST endpoints.
 * Third-party models are paid through Unified Billing, so only a Cloudflare token is needed.
 * Prompt and response bodies are kept out of gateway logs; metrics are still recorded.
 * Output must be JSON matching `schema`; one retry is allowed with the validation error attached,
 * and after that the error is left to the Workflow step's own retries.
 */
export async function chatComplete<T>(
  cfg: ChatConfig,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const withSchema: ChatMessage[] = [
    ...messages,
    {
      role: "system",
      content: `Reply with one JSON object only, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`,
    },
  ];
  let conversation = withSchema;
  let lastError = "";
  let lastModeError: JsonModeError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = await callOnce(cfg, conversation, z.toJSONSchema(schema), fetcher);
    } catch (error) {
      if (!(error instanceof JsonModeError)) throw error;
      lastModeError = error;
      conversation = [
        ...withSchema,
        {
          role: "user",
          content:
            "That reply was not valid JSON for the schema. Return a corrected JSON object only.",
        },
      ];
      continue;
    }
    const parsed = parseJson(raw);
    lastModeError = null;
    const result = parsed.ok ? schema.safeParse(parsed.value) : null;
    if (result?.success) return result.data;
    lastError = parsed.ok ? z.prettifyError(result!.error) : parsed.error;
    conversation = [
      ...withSchema,
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `That reply was not valid: ${lastError}\nReply again with corrected JSON only.`,
      },
    ];
  }
  // An unavailable error remains retryable and exposes only a fixed status code.
  if (lastModeError) throw lastModeError;
  // A plain error, so the Workflow step retries the call; the message holds no model output.
  throw new Error(
    `model output for ${cfg.route} did not match its schema twice`,
  );
}

class JsonModeError extends AppError {
  constructor(status: number) { super("unavailable", modelHttpFailureDetail(status)); }
}

async function callOnce(
  cfg: ChatConfig,
  messages: ChatMessage[],
  schema: unknown,
  fetcher: Fetcher,
): Promise<string> {
  const maxOutputTokens = cfg.maxOutputTokens ?? 8192;
  const timeoutMs = cfg.timeoutMs ?? (cfg.route === "extract" ? 180_000 : 60_000);
  // Cloudflare lists this model as Responses-only. Other models retain the
  // existing Chat Completions wire contract unless explicitly supported here.
  const responses = cfg.model === "openai/gpt-5.6-sol";
  const payload = responses
    ? {
        model: cfg.model,
        input: messages,
        max_output_tokens: maxOutputTokens,
        text: { format: { type: "json_object" } },
        // Responses may persist application state by default. Each call is
        // independent and must not retain career text in the provider's store.
        store: false,
        // Disable OpenAI's separate implicit prompt cache: explicit mode with
        // no breakpoints does not write a cache entry.
        prompt_cache_options: { mode: "explicit" },
      }
    : {
        model: cfg.model,
        messages,
        ...(/^(?:anthropic\/claude-(?:haiku|sonnet)-(?:5\.5|5-5)|openai\/gpt-5(?:-\d{4}-\d{2}-\d{2})?)$/.test(
          cfg.model,
        )
          ? {}
          : { temperature: cfg.temperature }),
        max_tokens: maxOutputTokens,
        response_format: cfg.model.startsWith("@cf/")
          ? { type: "json_schema", json_schema: schema }
          : { type: "json_object" },
      };
  const bodyText = JSON.stringify(payload);
  const body = await modelAttempt(
    {
      route: cfg.route,
      model: cfg.model,
      inputChars: bodyText.length,
      maxOutputTokens,
    },
    {
      ...cfg,
      async onAttemptStart(attempt: ModelAttempt) {
        await cfg.beforeAttempt?.(
          cfg.model,
          bodyText,
          maxOutputTokens,
          attempt.attemptId,
        );
        await cfg.onAttemptStart?.(attempt);
      },
    },
    async () => {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/v1/${responses ? "responses" : "chat/completions"}`,
        {
          method: "POST",
          // Workers supports manual redirects; never forward credentials or career text.
          redirect: "manual",
          headers: {
            authorization: `Bearer ${cfg.token}`,
            "content-type": "application/json",
            "cf-aig-gateway-id": cfg.gatewayId,
            "cf-aig-collect-log-payload": "false",
            "cf-aig-skip-cache": "true",
            "cf-aig-request-timeout": String(timeoutMs),
            // Workflow retries own network retry policy; avoid multiplying hidden gateway attempts.
            "cf-aig-max-attempts": "1",
          },
          signal,
          body: bodyText,
        },
      ).catch(() => {
        logRequestFailure(cfg.route, 0);
        throw new AppError("unavailable", signal.aborted
          ? "model provider request timed out"
          : "model provider network failure");
      });
      if (!res.ok) {
        logRequestFailure(cfg.route, res.status);
        // A redirect is a hard failure, even if its body resembles a JSON Mode error.
        if (res.status >= 300 && res.status < 400)
          throw new AppError("unavailable", modelHttpFailureDetail(res.status));
        const errorText = await res.text();
        if (/JSON Mode (?:couldn't|could not) be met/i.test(errorText))
          throw new JsonModeError(res.status);
        // Unavailable failures stay retryable and carry only an allowlisted status.
        throw new AppError("unavailable", modelHttpFailureDetail(res.status));
      }
      const value = await res.json().catch(() => {
        throw new Error(`model response for ${cfg.route} was not JSON`);
      });
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`model response for ${cfg.route} was not an object`);
      return value as {
        usage?: unknown;
        choices?: { message?: { content?: string | null } }[];
        status?: unknown;
        error?: unknown;
        output?: unknown;
      };
    },
    (response) => response.usage,
  );
  if (responses) return responseText(body, cfg.route);
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string")
    throw new Error(`model call for ${cfg.route} returned no content`);
  return content;
}

/** Refusals, partial responses, tools and ambiguous outputs are never model answers. */
function responseText(
  body: { status?: unknown; error?: unknown; output?: unknown },
  route: string,
): string {
  if (body.status !== "completed" || body.error != null || !Array.isArray(body.output))
    throw new Error(`model call for ${route} did not complete`);
  if (body.output.some((item: unknown) =>
    !item || typeof item !== "object" ||
    !["reasoning", "message"].includes(String((item as Record<string, unknown>).type)),
  )) throw new Error(`model call for ${route} returned unexpected output`);
  const messages = body.output.filter((item: unknown) =>
    item && typeof item === "object" && (item as Record<string, unknown>).type === "message",
  ) as Record<string, unknown>[];
  if (messages.length !== 1 || messages[0]!.role !== "assistant" ||
    (messages[0]!.status != null && messages[0]!.status !== "completed") ||
    !Array.isArray(messages[0]!.content))
    throw new Error(`model call for ${route} returned no content`);
  const content = messages[0]!.content as unknown[];
  if (content.length !== 1 || !content[0] || typeof content[0] !== "object")
    throw new Error(`model call for ${route} returned no content`);
  const item = content[0] as Record<string, unknown>;
  if (item.type !== "output_text" || typeof item.text !== "string")
    throw new Error(`model call for ${route} returned no content`);
  return item.text;
}

function parseJson(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, error: "the reply was not JSON" };
  }
}
