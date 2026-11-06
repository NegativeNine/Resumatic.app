import { z } from "zod";
import { modelAttempt, type ModelObservers } from "./usage";

export const CLAIRIC_MODEL = "@cf/cloudflare/clairic";
// A conservative character bound, not a claimed tokenizer limit.
export const MAX_FIELD_CHARS = 12_000;
export const MAX_FIELDS = 12;
export type FieldSpec =
  | { type: "text" | "date"; instructions?: string }
  | { type: "number"; decimals?: number; unit?: string; instructions?: string }
  | { type: "list"; items: "text"; instructions?: string };
const Span = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const Answer = z
  .object({
    value: z.unknown(),
    span: Span.optional(),
    spans: z.array(Span).max(400).optional(),
    confidence: z.number().min(0).max(1).optional(),
    p_null: z.number().min(0).max(1).optional(),
  })
  .passthrough();
export const FieldResultSchema = z.object({
  answers: z.record(z.string(), Answer),
  truncated: z.boolean(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      passes: z.number().int().positive(),
    })
    .optional(),
});
export type FieldResult = z.infer<typeof FieldResultSchema>;
export type FieldAnswer = z.infer<typeof Answer>;

export function fieldRequest(
  state: string,
  fields: Record<string, FieldSpec>,
  referenceDate: string,
) {
  if (!state.trim() || state.length > MAX_FIELD_CHARS)
    throw new Error("field_input_size");
  if (Object.keys(fields).length < 1 || Object.keys(fields).length > MAX_FIELDS)
    throw new Error("field_count");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) ||
    !Number.isFinite(Date.parse(referenceDate))
  )
    throw new Error("field_reference_date");
  return { model: "clairic", state, fields, reference_date: referenceDate };
}

export function parseFieldResult(raw: unknown): FieldResult {
  const result = FieldResultSchema.safeParse(raw);
  if (!result.success) throw new Error("field_response_shape");
  if (result.data.truncated) throw new Error("field_response_truncated");
  return result.data;
}

export async function extractFields(
  env: Env,
  state: string,
  fields: Record<string, FieldSpec>,
  referenceDate: string,
  observers: ModelObservers = {},
): Promise<FieldResult> {
  const request = fieldRequest(state, fields, referenceDate);
  // Direct binding until gateway payload suppression is verified for this preview model.
  const run = env.AI.run.bind(env.AI) as (
    model: string,
    input: unknown,
  ) => Promise<unknown>;
  const raw = await modelAttempt(
    {
      route: "fields",
      model: CLAIRIC_MODEL,
      inputChars: JSON.stringify(request).length * Object.keys(fields).length,
      maxOutputTokens: 0,
    },
    observers,
    () =>
      run(CLAIRIC_MODEL, request).catch(() => {
        throw new Error("field_request_failed");
      }),
    (response) => (response as { usage?: unknown })?.usage,
  );
  return parseFieldResult(raw);
}
