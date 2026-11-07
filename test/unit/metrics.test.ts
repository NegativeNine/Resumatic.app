import { describe, expect, it, vi } from "vitest";
import { alertQuery } from "../../src/worker/alerts";
import { metricsQueries, operationalMetrics } from "../../src/worker/metrics";

const env = {
  CF_ACCOUNT_ID: "a".repeat(32),
  CF_ANALYTICS_TOKEN: "private-token",
  METRICS_DATASET: "resumatic_steps",
};

describe("operational metric aggregates", () => {
  it("weights sampled events and separates model attempts from successful run latency", () => {
    const queries = metricsQueries("resumatic_steps", 48);
    expect(queries.models).toContain("SUM(_sample_interval)");
    expect(queries.models).toContain("blob2 NOT IN ('http', 'run_total')");
    expect(queries.models).toContain(
      "quantileExactWeighted(0.95)(double1, _sample_interval)",
    );
    expect(queries.runs).toContain("blob2 = 'run_total' AND blob5 = 'ok'");
    expect(queries.runs).toContain("INTERVAL '48' HOUR");
    expect(alertQuery("resumatic_steps")).toContain(
      "blob2 NOT IN ('http', 'run_total')",
    );
  });

  it("returns numeric aggregate costs without raw event identifiers", async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return Response.json({
        data: String(init?.body).startsWith("SELECT blob3 AS route")
          ? [
              {
                route: "write",
                model: "@cf/test/model",
                attempts: "20",
                failures: "2",
                unknownCosts: "3",
                inputTokens: "1000",
                outputTokens: "400",
                costMicrousd: "150000",
                p50Ms: "500",
                p95Ms: "1200",
                vaultId: "must-not-return",
              },
            ]
          : [{ kind: "tailor", count: "4", p50Ms: "12000", p95Ms: "35000" }],
      });
    }) as unknown as typeof fetch;
    const report = await operationalMetrics(env, { hours: 48 }, fetcher);
    expect(report).toMatchObject({
      enabled: true,
      sampled: true,
      hours: 48,
      models: [
        {
          attempts: 20,
          failures: 2,
          unknownCosts: 3,
          knownCostUsd: 0.15,
          p50Ms: 500,
          p95Ms: 1200,
        },
      ],
      runs: [{ kind: "tailor", count: 4, p95Ms: 35000 }],
    });
    expect(JSON.stringify(report)).not.toMatch(
      /must-not-return|private-token|costMicrousd/,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows unavailable configuration without inventing zero-valued measurements", async () => {
    const fetcher = vi.fn();
    expect(
      await operationalMetrics({ CF_ACCOUNT_ID: "" }, {}, fetcher),
    ).toMatchObject({ enabled: false, models: [], runs: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unbounded or injectable query inputs before calling the service", async () => {
    const fetcher = vi.fn();
    await expect(
      operationalMetrics(env, { hours: 1000 }, fetcher),
    ).rejects.toThrow("168");
    expect(() => metricsQueries("metrics; DROP TABLE logs", 24)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sanitizes service failures and invalid aggregate responses", async () => {
    await expect(
      operationalMetrics(
        env,
        {},
        async () => new Response("private upstream detail", { status: 500 }),
      ),
    ).rejects.toThrow("metrics could not be read");
    await expect(
      operationalMetrics(env, {}, async () =>
        Response.json({ data: [{ p95Ms: null }] }),
      ),
    ).rejects.toThrow("metrics could not be read");
  });
});
