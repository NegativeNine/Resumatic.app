import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatConfig {
  accountId: string;
  token: string;
  gatewayId: string;
  model: string;
  temperature: number;
  /** Route name, used in error messages only. */
  route: string;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * One chat completion through AI Gateway's OpenAI-compatible REST endpoint.
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callOnce(cfg, conversation, fetcher);
    const parsed = parseJson(raw);
    const result = parsed.ok ? schema.safeParse(parsed.value) : null;
    if (result?.success) return result.data;
    lastError = parsed.ok ? z.prettifyError(result!.error) : parsed.error;
    conversation = [
      ...withSchema,
      { role: "assistant", content: raw },
      { role: "user", content: `That reply was not valid: ${lastError}\nReply again with corrected JSON only.` },
    ];
  }
  // A plain error, so the Workflow step retries the call; the message holds no model output.
  throw new Error(`model output for ${cfg.route} did not match its schema twice`);
}

async function callOnce(cfg: ChatConfig, messages: ChatMessage[], fetcher: Fetcher): Promise<string> {
  const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
      "cf-aig-gateway-id": cfg.gatewayId,
      "cf-aig-collect-log-payload": "false",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    // Thrown as a plain error so the Workflow step retries it.
    throw new Error(`model call for ${cfg.route} failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`model call for ${cfg.route} returned no content`);
  return content;
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
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
