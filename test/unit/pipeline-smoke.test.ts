import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { auditPilotLedger, createPilotLedger } from "../extract-evals/budget-ledger.mjs";
import { boundedSmokeModels, runPipelineSmoke, type SmokeQuestion } from "../evals/pipeline-smoke";
import { createSmokeReport } from "../evals/pipeline-smoke-report";

const creds = { accountId: "a".repeat(32), token: "synthetic-secret", gatewayId: "synthetic" };
function campaign() {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-smoke-test-"));
  const { file } = createPilotLedger(directory, 1_000_000, 50, 18);
  return { directory, file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const response = (supported: boolean, usage: unknown = { input_tokens: 100, output_tokens: 0 }) => ({
  answers: { verdict: { type: "choice", choice: supported ? "supported" : "unsupported", probabilities: supported ? { supported: 0.98, unsupported: 0.01, overstated: 0.01 } : { supported: 0.01, unsupported: 0.98, overstated: 0.01 } } }, usage,
});

describe("isolated synthetic pipeline smoke", () => {
  it("exercises real pipeline and judge code with eight requests, settled before results, and no shared-pilot changes", async () => {
    const c = campaign();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const state = JSON.parse(String(init!.body)).state;
      const before = auditPilotLedger(c.file);
      expect(before.attempts.filter((attempt: { state: string }) => attempt.state === "pending")).toHaveLength(1);
      expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/@cf/cloudflare/clef`);
      expect(new Headers(init!.headers).get("cf-aig-collect-log-payload")).toBe("false");
      expect(new Headers(init!.headers).get("cf-aig-max-attempts")).toBe("1");
      // This offline provider rejects the two wrong clauses and their combined wording,
      // agrees on the equivalent deploy lines, and only agrees with actual C++ use.
      const fact = state.facts.map((item: { text: string }) => item.text).join(" ");
      const supported = fact.includes("deploy time") || fact === "Wrote services in C++";
      return Response.json({ success: true, result: response(supported) });
    });
    try {
      const result = await runPipelineSmoke(boundedSmokeModels(creds, c.file, "extraction", fetcher), boundedSmokeModels(creds, c.file, "tailoring", fetcher));
      expect(result.passed, JSON.stringify(result.checks)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(8);
      const audit = auditPilotLedger(c.file);
      expect(audit.attempts).toHaveLength(8);
      expect(audit.attempts.every((attempt: { state: string }) => attempt.state === "settled")).toBe(true);
      expect(audit.budgets.map((row: { reservedCalls: number }) => row.reservedCalls)).toEqual([18, 30]);
      expect(audit.frozen).toBe(false);
      expect(() => createPilotLedger(c.directory, 1_000_000, 50, 18)).toThrow("live_eval_campaign_already_started");
      expect(JSON.stringify(result)).not.toContain(creds.token);
    } finally { c.cleanup(); }
  });

  it("fails the positive controls when every model decision declines, and the negative controls when every answer agrees", async () => {
    for (const supported of [false, true]) {
      const c = campaign();
      const fetcher = vi.fn(async () => Response.json({ result: response(supported) }));
      try {
        const result = await runPipelineSmoke(boundedSmokeModels(creds, c.file, "extraction", fetcher), boundedSmokeModels(creds, c.file, "tailoring", fetcher));
        expect(result.passed).toBe(false);
        expect(result.checks.filter((check) => !check.passed).length).toBeGreaterThan(0);
        expect(fetcher).toHaveBeenCalledTimes(8);
      } finally { c.cleanup(); }
    }
  });

  it("freezes missing usage or malformed decisions without asking the next question", async () => {
    for (const raw of [response(true, {}), { ...response(true), answers: {} }]) {
      const c = campaign();
      const fetcher = vi.fn(async () => Response.json({ result: raw }));
      const models = boundedSmokeModels(creds, c.file, "extraction", fetcher);
      try {
        await expect(models.judge!([
          { alias: "one", text: "Built services", facts: [{ text: "Built services", quote: null }] },
          { alias: "two", text: "Built services", facts: [{ text: "Built services", quote: null }] },
        ])).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(auditPilotLedger(c.file).frozen).toBe(true);
      } finally { c.cleanup(); }
    }
  });

  it("does not dispatch beyond the durable suite allowance, including from a new adapter instance", async () => {
    const c = campaign();
    const fetcher = vi.fn(async () => Response.json({ result: response(true) }));
    const item = { alias: "one", text: "Built services", facts: [{ text: "Built services", quote: null }] };
    try {
      await boundedSmokeModels(creds, c.file, "extraction", fetcher).judge!([item, item, item]);
      // The production judge sanitizes binding errors, including a refused reservation.
      await expect(boundedSmokeModels(creds, c.file, "extraction", fetcher).judge!([item])).rejects.toThrow("model provider network failure");
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(auditPilotLedger(c.file).budgets[0]!.reservedCalls).toBe(18);
    } finally { c.cleanup(); }
  });

  it("records raw choice and probabilities separately from the thresholded verdict, without provider extras or credentials", async () => {
    const c = campaign();
    const questions: SmokeQuestion[] = [];
    const raw = response(true);
    raw.answers.verdict.probabilities = { supported: 0.79, unsupported: 0.2, overstated: 0.01 };
    const fetcher = vi.fn(async () => Response.json({ result: { ...raw, provider_extra: creds.token }, debug: creds.token }));
    try {
      const model = boundedSmokeModels(creds, c.file, "tailoring", fetcher, (question) => questions.push(question));
      await model.judge!([{ alias: "synthetic", text: "Used the software: C++", facts: [{ text: "Wrote services in C++", quote: null }] }]);
      expect(questions).toMatchObject([{ choice: "supported", probabilities: { supported: 0.79 }, verdict: "unsupported", supportedThreshold: 0.8, failed: false }]);
      expect(JSON.stringify(questions)).not.toContain(creds.token);
      expect(Object.keys(questions[0]!)).not.toContain("usage");
    } finally { c.cleanup(); }
  });

  it("persists completed checks before later dispatch and retains them when a later provider request fails", async () => {
    const c = campaign();
    const file = join(c.directory, "pipeline-smoke-report.json");
    const report = createSmokeReport(c.directory);
    let calls = 0;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls === 6) {
        const checkpoint = JSON.parse(readFileSync(file, "utf8"));
        expect(checkpoint.checks).toHaveLength(3);
        expect(checkpoint.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
        expect(checkpoint.questions).toHaveLength(5);
        return new Response(creds.token, { status: 503 });
      }
      const supported = JSON.parse(String(init!.body)).state.facts[0].text.includes("deploy time");
      return Response.json({ result: response(supported) });
    });
    try {
      const result = await runPipelineSmoke(boundedSmokeModels(creds, c.file, "extraction", fetcher, report.question), boundedSmokeModels(creds, c.file, "tailoring", fetcher, report.question), report.check);
      expect(report.finish(result)).toEqual({ complete: false, passed: false });
      report.fail();
      const saved = JSON.parse(readFileSync(file, "utf8"));
      expect(saved.checks.slice(0, 3).every((check: { passed: boolean }) => check.passed)).toBe(true);
      expect(saved.questions).toHaveLength(6);
      expect(saved.questions[5]).toMatchObject({ choice: null, probabilities: null, verdict: null, failed: true });
      expect(saved.accounting.frozen).toBe(true);
      expect(saved.complete).toBe(false);
      expect(JSON.stringify(saved)).not.toContain(creds.token);
      expect(statSync(file).mode & 0o077).toBe(0);
      expect(() => createSmokeReport(c.directory)).toThrow();
    } finally { c.cleanup(); }
  });
});
