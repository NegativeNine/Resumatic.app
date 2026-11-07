import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chatComplete } from "../../src/ai/llm";
import { renderResumeHtml, formatDate } from "../../src/render/template";
import { AppError, errorCode, errorDetail } from "../../src/shared/errors";

const cfg = {
  accountId: "acct",
  token: "tok",
  gatewayId: "gw",
  model: "anthropic/claude-haiku-5-5",
  temperature: 0,
  route: "analyze",
};
const Schema = z.object({ answer: z.number() });

function replies(...bodies: (string | Response)[]) {
  const requests: { url: string; init: RequestInit; body: any }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = bodies.shift()!;
    return typeof next === "string"
      ? Response.json({ choices: [{ message: { content: next } }] })
      : next;
  };
  return { fetcher, requests };
}

describe("chatComplete", () => {
  it("logs only an approved route and numeric status for provider and network failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const secret = "private synthetic resume text";
      await expect(chatComplete(
        { ...cfg, route: "extract", token: secret },
        [{ role: "user", content: secret }],
        Schema,
        async () => new Response(secret, { status: 403 }),
      )).rejects.toThrow(/HTTP 403/);
      await expect(chatComplete(
        { ...cfg, route: secret },
        [{ role: "user", content: secret }],
        Schema,
        async () => { throw new Error(secret); },
      )).rejects.toThrow();
      expect(log.mock.calls).toEqual([
        [JSON.stringify({ event: "model_request_failed", route: "extract", status: 403 })],
        [JSON.stringify({ event: "model_request_failed", route: "other", status: 0 })],
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });

  it("calls the gateway with logging off and the schema attached", async () => {
    const { fetcher, requests } = replies('```json\n{"answer": 42}\n```');
    expect(
      await chatComplete(
        cfg,
        [{ role: "user", content: "q" }],
        Schema,
        fetcher,
      ),
    ).toEqual({ answer: 42 });
    const [req] = requests;
    expect(req!.init.redirect).toBe("manual");
    expect(req!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
    );
    const headers = new Headers(req!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("cf-aig-gateway-id")).toBe("gw");
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(req!.body).toMatchObject({
      model: "anthropic/claude-haiku-5-5",
      response_format: { type: "json_object" },
    });
    expect(req!.body).not.toHaveProperty("temperature");
    expect(req!.body.messages.at(-1).content).toContain('"answer"');
  });

  it.each([
    ["anthropic/claude-haiku-5.5", false],
    ["anthropic/claude-sonnet-5.5", false],
    ["anthropic/claude-sonnet-5-5", false],
    ["openai/gpt-5", false],
    ["openai/gpt-5-2025-08-07", false],
    ["openai/gpt-5.2", true],
    ["anthropic/claude-haiku-4-5", true],
  ])(
    "uses supported temperature settings for %s",
    async (model, hasTemperature) => {
      const { fetcher, requests } = replies('{"answer": 42}');
      await chatComplete({ ...cfg, model }, [], Schema, fetcher);
      expect(Object.hasOwn(requests[0]!.body, "temperature")).toBe(
        hasTemperature,
      );
    },
  );

  it("retries once with the validation error, then leaves it to the Workflow's retries", async () => {
    const second = replies('{"answer": "forty-two"}', '{"answer": 42}');
    expect(
      await chatComplete(
        cfg,
        [{ role: "user", content: "q" }],
        Schema,
        second.fetcher,
      ),
    ).toEqual({ answer: 42 });
    expect(second.requests[1]!.body.messages.at(-1).content).toMatch(
      /^That reply was not valid/,
    );

    const never = replies(
      "not json",
      '{"wrong": true, "secret": "career text"}',
    );
    const error = await chatComplete(
      cfg,
      [{ role: "user", content: "q" }],
      Schema,
      never.fetcher,
    ).catch((e) => e);
    expect(errorCode(error)).toBeNull();
    expect(error.message).toBe(
      "model output for analyze did not match its schema twice",
    );
  });

  it("throws a retryable unavailable error with a safe status when the gateway fails", async () => {
    const { fetcher } = replies(new Response("busy", { status: 529 }));
    const error = await chatComplete(
      cfg,
      [{ role: "user", content: "q" }],
      Schema,
      fetcher,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBe("unavailable");
    expect(error.message).toBe("unavailable: model provider HTTP 529");
  });

  it("keeps only the safe HTTP code if JSON Mode fails twice", async () => {
    const secret = "private synthetic resume text";
    const { fetcher, requests } = replies(
      new Response(`JSON Mode couldn't be met ${secret}`, { status: 400 }),
      new Response(`JSON Mode couldn't be met ${secret}`, { status: 400 }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await chatComplete(cfg, [{ role: "user", content: secret }], Schema, fetcher).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("expected model call to fail");
      expect(error.message).toBe("unavailable: model provider HTTP 400");
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
      expect(requests).toHaveLength(2);
    } finally { log.mockRestore(); }
  });

  it("maps unreviewed provider status codes to a fixed generic detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await chatComplete(cfg, [], Schema, async () => new Response("private response", { status: 418 })).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("expected model call to fail");
      expect(error.message).toBe("unavailable: model provider HTTP error");
      expect(error.message).not.toContain("private response");
    } finally { log.mockRestore(); }
  });

  it("does not follow or replay redirected model requests", async () => {
    const { fetcher, requests } = replies(new Response("JSON Mode couldn't be met: private response", { status: 307, headers: { location: "https://other.example/model" } }));
    await expect(chatComplete(cfg, [], Schema, fetcher)).rejects.toThrow(/HTTP 307/);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init.redirect).toBe("manual");
  });
});

describe("error codes", () => {
  it("survive RPC and Workflow re-throws", () => {
    const original = new AppError("gone", "this vault no longer exists");
    expect(errorCode(original)).toBe("gone");
    expect(errorCode(new Error(original.message))).toBe("gone");
    expect(errorCode(new Error(`NonRetryableError: ${original.message}`))).toBe(
      "gone",
    );
    expect(
      errorDetail(new Error(`Error: NonRetryableError: ${original.message}`)),
    ).toBe("this vault no longer exists");
    expect(errorCode(new Error("gone fishing"))).toBeNull();
  });
});

describe("resume template", () => {
  const data = {
    profile: {
      name: "Jane <Doe>",
      email: "jane@example.com",
      phone: "",
      location: "Toronto",
      links: ["https://x.test/?a=1&b=2"],
    },
    version: 1,
    company: "Initrode",
    title: "Platform Engineer",
    body: {
      summary: {
        id: "s",
        text: 'Builds "reliable" systems',
        factIds: ["f"],
        status: "kept" as const,
      },
      sections: [
        {
          roleId: "r1",
          kind: "job" as const,
          org: "Acme & Co",
          title: "Engineer",
          startDate: "2021-03",
          endDate: null,
          lines: [
            {
              id: "l",
              text: "Cut costs by 30% <fast>",
              factIds: ["f"],
              status: "kept" as const,
            },
          ],
        },
        {
          roleId: "r2",
          kind: "education" as const,
          org: "State University",
          title: "B.S.",
          startDate: "2014",
          endDate: "2018",
          lines: [],
        },
      ],
      skills: ["Go", "C++"],
    },
  };

  it("escapes every value and prints dates readably", () => {
    const html = renderResumeHtml(data);
    expect(html).toContain("<h1>Jane &lt;Doe&gt;</h1>");
    expect(html).toContain("Acme &amp; Co");
    expect(html).toContain("Cut costs by 30% &lt;fast&gt;");
    expect(html).toContain("Builds &quot;reliable&quot; systems");
    expect(html).toContain("https://x.test/?a=1&amp;b=2");
    expect(html).toContain("Mar 2021 – Present");
    expect(html).toContain("2014 – 2018");
    expect(html.indexOf("Experience")).toBeLessThan(html.indexOf("Education"));
    expect(html).not.toMatch(/<(script|img|link|iframe)\b/);
  });

  it("formats dates", () => {
    expect(formatDate("2021-03")).toBe("Mar 2021");
    expect(formatDate("2021")).toBe("2021");
    expect(formatDate(null)).toBe("");
  });
  it("renders a known start and unknown end without inventing present employment", () => {
    const value = structuredClone(data);
    Object.assign(value.body.sections[0]!, { startDate: null, endDate: null, unknownEndStartDate: "2020" });
    const html = renderResumeHtml(value);
    expect(html).toContain("Start: 2020 (end unknown)");
    expect(html).not.toContain("2020 – Present");
  });
});
