import { z } from "zod";

export interface AlertEnvironment {
  ALERTS_ENABLED?: string;
  ALERT_WEBHOOK_URL?: string;
  CF_ACCOUNT_ID: string;
  CF_ANALYTICS_TOKEN?: string;
  METRICS_DATASET?: string;
  ALERT_FAILURE_RATE?: string;
  ALERT_HTTP_5XX_RATE?: string;
  ALERT_MIN_ATTEMPTS?: string;
  ALERT_SPEND_USD_PER_15M?: string;
}
export interface AlertMetrics {
  modelAttempts: number;
  modelFailures: number;
  unknownCosts: number;
  httpRequests: number;
  http5xx: number;
  costUsd: number;
}
export interface AlertThresholds {
  failureRate: number;
  http5xxRate: number;
  minAttempts: number;
  spendUsd: number;
}
export type AlertCode =
  "model_failure_rate" | "http_5xx_rate" | "spend" | "unknown_cost";

export function alertCodes(
  metrics: AlertMetrics,
  thresholds: AlertThresholds,
): AlertCode[] {
  const codes: AlertCode[] = [];
  if (
    metrics.modelAttempts >= thresholds.minAttempts &&
    metrics.modelFailures / metrics.modelAttempts >= thresholds.failureRate
  )
    codes.push("model_failure_rate");
  if (
    metrics.httpRequests >= thresholds.minAttempts &&
    metrics.http5xx / metrics.httpRequests >= thresholds.http5xxRate
  )
    codes.push("http_5xx_rate");
  if (metrics.costUsd >= thresholds.spendUsd) codes.push("spend");
  if (metrics.unknownCosts > 0) codes.push("unknown_cost");
  return codes;
}

const Numeric = z
  .union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const Row = z.object({
  modelAttempts: Numeric,
  modelFailures: Numeric,
  unknownCosts: Numeric,
  httpRequests: Numeric,
  http5xx: Numeric,
  costMicrousd: Numeric,
});

/** The Workflow metrics' fourth double is integer micro-USD. Account for Analytics Engine sampling. */
export function alertQuery(dataset: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(dataset))
    throw new Error("Invalid metrics dataset");
  return `SELECT SUM(IF(blob2 NOT IN ('http', 'run_total'), _sample_interval, 0)) AS modelAttempts,
SUM(IF(blob2 NOT IN ('http', 'run_total') AND blob5 = 'failed', _sample_interval, 0)) AS modelFailures,
SUM(IF(blob2 NOT IN ('http', 'run_total') AND blob5 IN ('usage_unknown', 'failed'), _sample_interval, 0)) AS unknownCosts,
SUM(IF(blob2 = 'http', _sample_interval, 0)) AS httpRequests,
SUM(IF(blob2 = 'http' AND blob5 = 'failed', _sample_interval, 0)) AS http5xx,
SUM(IF(blob2 NOT IN ('http', 'run_total'), _sample_interval * double4, 0)) AS costMicrousd
FROM ${dataset} WHERE timestamp >= NOW() - INTERVAL '15' MINUTE FORMAT JSON`;
}

/** Cron calls this once per 15-minute window. No raw events, identities or career text leave the Worker. */
export async function checkOperationalAlerts(
  env: AlertEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<{ status: "disabled" | "quiet" | "sent"; alerts: AlertCode[] }> {
  if (env.ALERTS_ENABLED !== "true") return { status: "disabled", alerts: [] };
  let webhook: URL | null;
  try {
    webhook = env.ALERT_WEBHOOK_URL ? new URL(env.ALERT_WEBHOOK_URL) : null;
  } catch {
    throw new Error("Operational alerts are not configured");
  }
  const thresholds = {
    failureRate: Number(env.ALERT_FAILURE_RATE ?? "0.05"),
    http5xxRate: Number(env.ALERT_HTTP_5XX_RATE ?? "0.05"),
    minAttempts: Number(env.ALERT_MIN_ATTEMPTS ?? "20"),
    spendUsd: Number(env.ALERT_SPEND_USD_PER_15M),
  };
  if (
    !webhook ||
    webhook.protocol !== "https:" ||
    webhook.username ||
    webhook.password ||
    !/^[a-f0-9]{32}$/i.test(env.CF_ACCOUNT_ID) ||
    !env.CF_ANALYTICS_TOKEN ||
    !Number.isFinite(thresholds.failureRate) ||
    thresholds.failureRate <= 0 ||
    thresholds.failureRate > 1 ||
    !Number.isFinite(thresholds.http5xxRate) ||
    thresholds.http5xxRate <= 0 ||
    thresholds.http5xxRate > 1 ||
    !Number.isInteger(thresholds.minAttempts) ||
    thresholds.minAttempts < 1 ||
    !Number.isFinite(thresholds.spendUsd) ||
    thresholds.spendUsd <= 0
  )
    throw new Error("Operational alerts are not configured");
  let response: Response;
  try {
    response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
          "content-type": "text/plain",
        },
        body: alertQuery(env.METRICS_DATASET ?? "resumatic_steps"),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error("Metrics query failed");
  }
  if (!response.ok) throw new Error("Metrics query failed");
  let row: z.infer<typeof Row>;
  try {
    row = z
      .object({ data: z.array(Row).length(1) })
      .parse(await response.json()).data[0]!;
  } catch {
    throw new Error("Metrics response is invalid");
  }
  const metrics: AlertMetrics = {
    modelAttempts: row.modelAttempts,
    modelFailures: row.modelFailures,
    unknownCosts: row.unknownCosts,
    httpRequests: row.httpRequests,
    http5xx: row.http5xx,
    costUsd: row.costMicrousd / 1_000_000,
  };
  const alerts = alertCodes(metrics, thresholds);
  if (!alerts.length) return { status: "quiet", alerts };
  const payload = {
    source: "resumatic",
    windowMinutes: 15,
    alerts,
    metrics,
    sampled: true,
  };
  try {
    response = await fetcher(webhook.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Alert delivery failed");
  }
  if (!response.ok) throw new Error("Alert delivery failed");
  return { status: "sent", alerts };
}
