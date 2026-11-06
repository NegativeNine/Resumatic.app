import { z } from "zod";
import { AppError } from "../shared/errors";

export interface MetricsEnvironment {
  CF_ACCOUNT_ID: string;
  CF_ANALYTICS_TOKEN?: string;
  METRICS_DATASET?: string;
}
const Numeric = z
  .union([z.number(), z.string().regex(/^\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?$/)])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const ModelRow = z.object({
  route: z.string().max(100),
  model: z.string().max(300),
  attempts: Numeric,
  failures: Numeric,
  unknownCosts: Numeric,
  inputTokens: Numeric,
  outputTokens: Numeric,
  costMicrousd: Numeric,
  p50Ms: Numeric,
  p95Ms: Numeric,
});
const RunRow = z.object({
  kind: z.string().max(100),
  count: Numeric,
  p50Ms: Numeric,
  p95Ms: Numeric,
});
export interface MetricsDashboard {
  enabled: boolean;
  hours: number;
  generatedAt: string;
  sampled: true;
  models: (Omit<z.infer<typeof ModelRow>, "costMicrousd"> & {
    knownCostUsd: number;
  })[];
  runs: z.infer<typeof RunRow>[];
}

/** Weighted aggregates follow Workers Analytics Engine's sampling contract. */
export function metricsQueries(
  dataset: string,
  hours = 24,
): { models: string; runs: string } {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(dataset) ||
    !Number.isSafeInteger(hours) ||
    hours < 1 ||
    hours > 168
  )
    throw new AppError(
      "invalid",
      "choose a metrics window from one to 168 hours",
    );
  const window = `timestamp >= NOW() - INTERVAL '${hours}' HOUR`;
  return {
    models: `SELECT blob3 AS route, blob4 AS model,
SUM(_sample_interval) AS attempts,
SUM(IF(blob5 = 'failed', _sample_interval, 0)) AS failures,
SUM(IF(blob5 IN ('usage_unknown', 'failed'), _sample_interval, 0)) AS unknownCosts,
SUM(_sample_interval * double2) AS inputTokens,
SUM(_sample_interval * double3) AS outputTokens,
SUM(_sample_interval * double4) AS costMicrousd,
quantileExactWeighted(0.5)(double1, _sample_interval) AS p50Ms,
quantileExactWeighted(0.95)(double1, _sample_interval) AS p95Ms
FROM ${dataset} WHERE ${window} AND blob2 NOT IN ('http', 'run_total') AND blob4 != ''
GROUP BY route, model ORDER BY attempts DESC LIMIT 200 FORMAT JSON`,
    runs: `SELECT blob3 AS kind, SUM(_sample_interval) AS count,
quantileExactWeighted(0.5)(double1, _sample_interval) AS p50Ms,
quantileExactWeighted(0.95)(double1, _sample_interval) AS p95Ms
FROM ${dataset} WHERE ${window} AND blob2 = 'run_total' AND blob5 = 'ok'
GROUP BY kind ORDER BY count DESC LIMIT 20 FORMAT JSON`,
  };
}

/** Returns aggregates only: no run IDs, vault IDs, query strings or career text. */
export async function operationalMetrics(
  env: MetricsEnvironment,
  options: { hours?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<MetricsDashboard> {
  const hours = options.hours ?? 24;
  const queries = metricsQueries(
    env.METRICS_DATASET ?? "resumatic_steps",
    hours,
  );
  const base: MetricsDashboard = {
    enabled: false,
    hours,
    generatedAt: new Date().toISOString(),
    sampled: true,
    models: [],
    runs: [],
  };
  if (!env.CF_ANALYTICS_TOKEN) return base;
  if (!/^[a-f0-9]{32}$/i.test(env.CF_ACCOUNT_ID))
    throw new AppError("unavailable", "metrics are not configured");
  async function query<T>(sql: string, schema: z.ZodType<T>): Promise<T> {
    try {
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
            "content-type": "text/plain",
          },
          body: sql,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error("query_failed");
      return schema.parse(await response.json());
    } catch {
      throw new AppError(
        "unavailable",
        "metrics could not be read; try again later",
      );
    }
  }
  const [models, runs] = await Promise.all([
    query(queries.models, z.object({ data: z.array(ModelRow).max(200) })),
    query(queries.runs, z.object({ data: z.array(RunRow).max(20) })),
  ]);
  return {
    ...base,
    enabled: true,
    models: models.data.map(({ costMicrousd, ...row }) => ({
      ...row,
      knownCostUsd: costMicrousd / 1_000_000,
    })),
    runs: runs.data,
  };
}
