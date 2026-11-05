import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatComplete } from "../../src/ai/llm";
import { renderResumeHtml, formatDate } from "../../src/render/template";
import { AppError, errorCode, errorDetail } from "../../src/shared/errors";

const cfg = { accountId: "acct", token: "tok", gatewayId: "gw", model: "anthropic/claude-haiku-5-5", temperature: 0, route: "analyze" };
const Schema = z.object({ answer: z.number() });

function replies(...bodies: (string | Response)[]) {
  const requests: { url: string; init: RequestInit; body: any }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = bodies.shift()!;
    return typeof next === "string" ? Response.json({ choices: [{ message: { content: next } }] }) : next;
  };
  return { fetcher, requests };
}

describe("chatComplete", () => {
  it("calls the gateway with logging off and the schema attached", async () => {
    const { fetcher, requests } = replies('```json\n{"answer": 42}\n```');
    expect(await chatComplete(cfg, [{ role: "user", content: "q" }], Schema, fetcher)).toEqual({ answer: 42 });
    const [req] = requests;
    expect(req!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions");
    const headers = new Headers(req!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("cf-aig-gateway-id")).toBe("gw");
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(req!.body).toMatchObject({ model: "anthropic/claude-haiku-5-5", temperature: 0, response_format: { type: "json_object" } });
    expect(req!.body.messages.at(-1).content).toContain('"answer"');
  });

  it("retries once with the validation error, then leaves it to the Workflow's retries", async () => {
    const second = replies('{"answer": "forty-two"}', '{"answer": 42}');
    expect(await chatComplete(cfg, [{ role: "user", content: "q" }], Schema, second.fetcher)).toEqual({ answer: 42 });
    expect(second.requests[1]!.body.messages.at(-1).content).toMatch(/^That reply was not valid/);

    const never = replies("not json", '{"wrong": true, "secret": "career text"}');
    const error = await chatComplete(cfg, [{ role: "user", content: "q" }], Schema, never.fetcher).catch((e) => e);
    expect(errorCode(error)).toBeNull();
    expect(error.message).toBe("model output for analyze did not match its schema twice");
  });

  it("throws a plain, retryable error when the gateway fails", async () => {
    const { fetcher } = replies(new Response("busy", { status: 529 }));
    const error = await chatComplete(cfg, [{ role: "user", content: "q" }], Schema, fetcher).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBeNull();
  });
});

describe("error codes", () => {
  it("survive RPC and Workflow re-throws", () => {
    const original = new AppError("gone", "this vault no longer exists");
    expect(errorCode(original)).toBe("gone");
    expect(errorCode(new Error(original.message))).toBe("gone");
    expect(errorCode(new Error(`NonRetryableError: ${original.message}`))).toBe("gone");
    expect(errorDetail(new Error(`Error: NonRetryableError: ${original.message}`))).toBe("this vault no longer exists");
    expect(errorCode(new Error("gone fishing"))).toBeNull();
  });
});

describe("resume template", () => {
  const data = {
    profile: { name: "Jane <Doe>", email: "jane@example.com", phone: "", location: "Toronto", links: ["https://x.test/?a=1&b=2"] },
    version: 1,
    company: "Initrode",
    title: "Platform Engineer",
    body: {
      summary: { id: "s", text: "Builds \"reliable\" systems", factIds: ["f"], status: "kept" as const },
      sections: [
        { roleId: "r1", kind: "job" as const, org: "Acme & Co", title: "Engineer", startDate: "2021-03", endDate: null, lines: [{ id: "l", text: "Cut costs by 30% <fast>", factIds: ["f"], status: "kept" as const }] },
        { roleId: "r2", kind: "education" as const, org: "State University", title: "B.S.", startDate: "2014", endDate: "2018", lines: [] },
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
});
