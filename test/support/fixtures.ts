import type { z } from "zod";
import type { ChatMessage } from "../../src/ai/llm";
import type { Models, Route } from "../../src/ai/models";
import { AppError } from "../../src/shared/errors";

// A fixture resume, what an imperfect model extracts from it, and deterministic stand-ins for
// every model call. Used by unit tests in Node and integration tests in workerd.

export const RESUME = `# Jane Doe

jane@example.com · Toronto

## Experience

### Acme Corp — Senior Software Engineer (2021-03 – Present)

- Led the migration of 40 services to Kubernetes, cutting deploy time by 60%
- Helped design the billing API used by 3 product teams
- Built a Go service that processes 2 million events per day

### Globex — Software Engineer (2018-06 – 2021-02)

- Implemented React dashboards for the sales team
- Mentored 2 junior engineers

## Education

### State University — B.S. Computer Science (2014 – 2018)

## Skills

Go, TypeScript, Kubernetes, PostgreSQL
`;

const ACME = "Acme Corp — Senior Software Engineer (2021-03 – Present)";
const GLOBEX = "Globex — Software Engineer (2018-06 – 2021-02)";
const SKILLS = "Go, TypeScript, Kubernetes, PostgreSQL";

/** What a careful but imperfect extract model returns for RESUME, including two claims the checks must drop. */
export const EXTRACTION = {
  roles: [
    { key: "acme", kind: "job", org: "Acme Corp", title: "Senior Software Engineer", startDate: "2021-03", endDate: null, quote: ACME },
    { key: "globex", kind: "job", org: "Globex", title: "Software Engineer", startDate: "2018-06", endDate: "2021-02", quote: GLOBEX },
    {
      key: "school",
      kind: "education",
      org: "State University",
      title: "B.S. Computer Science",
      startDate: "2014",
      endDate: "2018",
      quote: "State University — B.S. Computer Science (2014 – 2018)",
    },
    // Not in the resume at all: dropped.
    { key: "ghost", kind: "job", org: "Initech", title: "Staff Engineer", startDate: "2012", endDate: "2014", quote: "Initech — Staff Engineer (2012 – 2014)" },
  ],
  facts: [
    {
      roleKey: "acme",
      kind: "accomplishment",
      text: "Led the migration of 40 services to Kubernetes",
      level: "led",
      quote: "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%",
    },
    {
      roleKey: "acme",
      kind: "accomplishment",
      text: "Cut deploy time by 60% by migrating services to Kubernetes",
      level: "implemented",
      quote: "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%",
    },
    {
      roleKey: "acme",
      kind: "accomplishment",
      text: "Helped design the billing API used by 3 product teams",
      // The quote only supports "contributed"; the level is lowered.
      level: "owned",
      quote: "Helped design the billing API used by 3 product teams",
    },
    {
      roleKey: "acme",
      kind: "accomplishment",
      text: "Built a Go service that processes 2 million events per day",
      level: "implemented",
      quote: "Built a Go service that processes 2 million events per day",
    },
    {
      // Inflated number: dropped.
      roleKey: "acme",
      kind: "accomplishment",
      text: "Built a Go service that processes 5 million events per day",
      level: "implemented",
      quote: "Built a Go service that processes 2 million events per day",
    },
    {
      roleKey: "globex",
      kind: "accomplishment",
      text: "Implemented React dashboards for the sales team",
      level: "implemented",
      quote: "Implemented React dashboards for the sales team",
    },
    { roleKey: "globex", kind: "accomplishment", text: "Mentored 2 junior engineers", level: "led", quote: "Mentored 2 junior engineers" },
    {
      // Quote not in the resume: dropped.
      roleKey: "globex",
      kind: "accomplishment",
      text: "Won the Globex innovation award",
      level: null,
      quote: "Won the Globex innovation award in 2020",
    },
    { roleKey: null, kind: "skill", text: "Go", level: null, quote: SKILLS },
    { roleKey: null, kind: "skill", text: "Kubernetes", level: null, quote: SKILLS },
    { roleKey: null, kind: "skill", text: "PostgreSQL", level: null, quote: SKILLS },
  ],
};

export const JOB_DESCRIPTION = `Platform Engineer at Initrode

We are looking for a platform engineer to run Kubernetes and deploy automation, build Go services
that handle high event volumes, design internal APIs, mentor engineers and help with React tooling.
Rust experience is a plus.`;

export const ANALYSIS = {
  company: "Initrode",
  title: "Platform Engineer",
  requirements: [
    "Kubernetes and deploy automation",
    "Go services handling high event volumes",
    "API design",
    "Mentoring engineers",
    "React front-end work",
    "Rust systems programming",
  ],
};

// ---------------------------------------------------------------- fake models

export interface FakeModelOptions {
  extraction?: unknown;
  analysis?: unknown;
  /** Line texts to write instead of a fact's own text, keyed by the fact's text. */
  rewrites?: Record<string, string>;
  /** Extra lines: written under the role of the fact named by `under`, citing the facts named by `cites`. */
  extraLines?: { under: string; text: string; cites: string[] }[];
  summary?: { text: string; cites: string[] } | null;
  /** The judge rejects any line containing one of these. */
  judgeRejects?: string[];
  /** What the repair model returns, keyed by the failing line's text; otherwise the line unchanged. */
  repairs?: Record<string, string>;
  /** The analyze call waits for this, so a Tailor run can be held open. */
  hold?: Promise<void>;
  /** toMarkdown waits for this, so a Distill run can be held open. */
  holdConvert?: Promise<void>;
  toMarkdownError?: string;
  /** Each route's call count. */
  calls?: Partial<Record<Route | "embed" | "rerank" | "toMarkdown", number>>;
  /** When given, the text of every complete, embed and rerank call is added to it, in order. */
  inputs?: string[];
}

const TOPICS = ["kubernetes", "deploy", "\\bgo\\b", "events?", "\\bapis?\\b", "billing", "mentor", "react", "dashboards?", "sales", "rust", "postgres"];

/** Deterministic stand-in for bge-m3: one dimension per topic, plus a small constant so no vector is zero. */
export function topicVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [...TOPICS.map((t) => (new RegExp(t).test(lower) ? 1 : 0)), 0.05];
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

export function fakeModels(o: FakeModelOptions = {}): Models {
  const count = (k: keyof NonNullable<FakeModelOptions["calls"]>) => {
    if (o.calls) o.calls[k] = (o.calls[k] ?? 0) + 1;
  };
  return {
    async complete<T>(route: Route, messages: ChatMessage[], schema: z.ZodType<T>): Promise<T> {
      count(route);
      o.inputs?.push(JSON.stringify(messages));
      const user = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      let raw: unknown;
      switch (route) {
        case "extract":
          raw = o.extraction ?? EXTRACTION;
          break;
        case "analyze":
          if (o.hold) await o.hold;
          raw = o.analysis ?? ANALYSIS;
          break;
        case "write":
          raw = fakeWrite(user, o);
          break;
        case "judge": {
          const input: unknown = JSON.parse(user);
          const lines = Array.isArray(input) ? input : (input as { lines: unknown }).lines;
          if (!Array.isArray(lines)) throw new Error("invalid judge fixture input");
          raw = {
            verdicts: lines.map(({ id, text }: { id: string | number; text: string }) => {
              const bad = (o.judgeRejects ?? []).some((s) => text.includes(s));
              return { id, verdict: bad ? "unsupported" : "supported", reason: bad ? "adds a claim the facts do not make" : "" };
            }),
          };
          break;
        }
        case "repair": {
          const line = /^Line: (.*)$/m.exec(user)?.[1] ?? "";
          raw = { text: o.repairs?.[line] ?? line };
          break;
        }
      }
      return schema.parse(raw);
    },
    async embed(texts) {
      count("embed");
      o.inputs?.push(...texts);
      return texts.map(topicVector);
    },
    async rerank(query, texts) {
      count("rerank");
      o.inputs?.push(query, ...texts);
      const q = words(query);
      return texts.map((t) => {
        const w = words(t);
        let overlap = 0;
        for (const x of w) if (q.has(x)) overlap += 1;
        return overlap / (1 + w.size);
      });
    },
    async toMarkdown(_name, blob) {
      count("toMarkdown");
      if (o.holdConvert) await o.holdConvert;
      if (o.toMarkdownError) throw new AppError("invalid", o.toMarkdownError);
      return blob.text();
    },
  };
}

/** Writes each selected fact as its own line, then applies the scripted rewrites and extra lines. */
function fakeWrite(prompt: string, o: FakeModelOptions) {
  const facts = [...prompt.matchAll(/^\[(F\d+)\] \(([^)]+)\) (.*)$/gm)].map(([, alias, role, text]) => ({ alias: alias!, role: role!, text: text! }));
  const aliasOf = (text: string) => facts.find((f) => f.text === text)?.alias ?? "F99";
  const groups = new Map<string, { text: string; factIds: string[] }[]>();
  const add = (role: string, line: { text: string; factIds: string[] }) => {
    if (role === "no role") return;
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role)!.push(line);
  };
  for (const f of facts) add(f.role, { text: o.rewrites?.[f.text] ?? f.text, factIds: [f.alias] });
  for (const extra of o.extraLines ?? []) {
    const under = facts.find((f) => f.text === extra.under);
    if (under) add(under.role, { text: extra.text, factIds: extra.cites.map(aliasOf) });
  }
  return {
    summary: o.summary ? { text: o.summary.text, factIds: o.summary.cites.map(aliasOf) } : null,
    roles: [...groups.entries()].map(([roleId, lines]) => ({ roleId, lines })),
  };
}
