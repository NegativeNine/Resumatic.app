import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Models, Route } from "../../src/ai/models";
import { parseFieldResult } from "../../src/ai/fields";

export interface RecordingOptions {
  /** Explicit caller declaration: only synthetic fixture inputs may be recorded. */
  dataClass: "synthetic";
  modelIds: Partial<Record<Route, string>>;
  transcriptionModel?: string;
  embeddingModel?: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, stable(v)]),
    );
  return value;
}
export function recordingKey(
  kind: string,
  model: string,
  input: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify(stable({ format: 1, kind, model, input })))
    .digest("hex");
}
const numberList = z.array(z.number().finite());

function adapter(
  dir: string,
  options: RecordingOptions,
  real?: Models,
): Models {
  if (options.dataClass !== "synthetic")
    throw new Error("model_recording_requires_synthetic_data");
  async function call<T>(
    kind: string,
    model: string,
    input: unknown,
    validate: (value: unknown) => T,
    invoke: () => Promise<unknown>,
  ): Promise<T> {
    const key = recordingKey(kind, model, input);
    const directory = join(dir, kind);
    const file = join(directory, `${key}.json`);
    if (real) {
      if (existsSync(file)) throw new Error("model_recording_already_exists");
      const response = validate(await invoke());
      mkdirSync(directory, { recursive: true });
      // Exclusive creation prevents silently replacing an approved fixture with model drift.
      writeFileSync(
        file,
        JSON.stringify(
          { format: 1, dataClass: "synthetic", kind, model, key, response },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
      return response;
    }
    let value: unknown;
    try {
      if (statSync(file).size > 8 * 1024 * 1024) throw new Error("oversized");
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(
        `model_recording_missing_or_invalid: ${kind}/${key}.json`,
      );
    }
    const record = z
      .object({
        format: z.literal(1),
        dataClass: z.literal("synthetic"),
        kind: z.literal(kind),
        model: z.literal(model),
        key: z.literal(key),
        response: z.unknown(),
      })
      .safeParse(value);
    if (!record.success) throw new Error("model_recording_metadata_mismatch");
    return validate(record.data.response);
  }
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new Error("model_recording_response_shape");
    return result.data;
  };
  return {
    complete: (route, messages, schema, opts) => {
      const model = opts?.model ?? options.modelIds[route];
      if (!model) throw new Error("model_recording_model_required");
      return call(
        route,
        model,
        { messages, schema: z.toJSONSchema(schema) },
        (value) => parse(schema, value),
        () => real!.complete(route, messages, schema, opts),
      );
    },
    embed: (texts, opts) =>
      call(
        "embed",
        opts?.model ?? options.embeddingModel ?? "@cf/baai/bge-m3",
        { texts },
        (value) => {
          const vectors = parse(z.array(numberList), value);
          if (
            vectors.length !== texts.length ||
            vectors.some(
              (v) => v.length === 0 || v.length !== vectors[0]?.length,
            )
          )
            throw new Error("model_recording_embedding_shape");
          return vectors;
        },
        () => real!.embed(texts, opts),
      ),
    rerank: (query, texts) =>
      call(
        "rerank",
        "@cf/baai/bge-reranker-base",
        { query, texts },
        (value) => {
          const scores = parse(numberList, value);
          if (scores.length !== texts.length)
            throw new Error("model_recording_rerank_shape");
          return scores;
        },
        () => real!.rerank(query, texts),
      ),
    async toMarkdown(name, blob) {
      const digest = createHash("sha256")
        .update(new Uint8Array(await blob.arrayBuffer()))
        .digest("hex");
      return call(
        "convert",
        "toMarkdown",
        { name, type: blob.type, digest, metadata: false },
        (value) => parse(z.string().max(60_000), value),
        () => real!.toMarkdown(name, blob),
      );
    },
    extractFields: (state, fields, referenceDate) =>
      call(
        "fields",
        "@cf/cloudflare/clairic",
        { state, fields, referenceDate },
        parseFieldResult,
        async () => {
          if (!real?.extractFields)
            throw new Error("model_recording_adapter_unavailable");
          return real.extractFields(state, fields, referenceDate);
        },
      ),
    transcribePages: (input) => {
      if (!options.transcriptionModel)
        throw new Error("model_recording_model_required");
      return call(
        "transcribe",
        options.transcriptionModel,
        input,
        (value) => parse(z.object({ markdown: z.string().max(60_000) }), value),
        async () => {
          if (!real?.transcribePages)
            throw new Error("model_recording_adapter_unavailable");
          return real.transcribePages(input);
        },
      );
    },
  };
}

export function replayModels(dir: string, options: RecordingOptions): Models {
  return adapter(dir, options);
}
export function recordingModels(
  real: Models,
  dir: string,
  options: RecordingOptions,
): Models {
  return adapter(dir, options, real);
}
