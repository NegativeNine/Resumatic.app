import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { setPdfRenderer } from "../../src/render/pdf";
import type { ApplicationView, FactView } from "../../src/shared/api";
import { MCP_SCOPES, type McpClaims, type McpFit } from "../../src/shared/mcp";
import type { ShareGrant } from "../../src/shared/sharing";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { call, cookieFrom, type User } from "./support";

// Everything a vault sends to anyone but its owner, gathered as text, so a test can say of some
// words "these went nowhere". A feature that adds a way out of a vault adds it here, and every
// such test then covers it.
//
// The application kit's ZIP is gathered too, though only its owner downloads it: it is what they
// send on to an employer, so it is a way out like the PDF and the Word file.
//
// Not gathered: the owner's own pages, export and document downloads, which are theirs to read;
// and the answers of the tools that write (add_job, start_tailoring), which hold only IDs. What
// those tools set going is read here as model inputs and as the resumes they make. preview_fit's
// answer is gathered, and a preview it starts is read as model inputs too.

/** A shared copy, as the test that made it holds it. */
export interface OutwardCopy {
  grant: Pick<ShareGrant, "id">;
  /** The link's token: the fragment of the address the owner was given. */
  token: string;
  /** The account the copy names as its coach, signed in. It is given the copy as a coach gets one. */
  coach?: User;
}

/** One thing sent out, and where it went. */
export interface OutwardPart {
  surface: "copy by its link" | "copy as its coach" | "coach's client list" | "coach's comments" | "list_facts" | "search_facts" | "list_jobs" | "get_resume" | "preview_fit" | "PDF" | "Word" | "print preview" | "application kit" | "model input";
  text: string;
}

/**
 * Makes the stand-in PDF the page it was printed from, so a PDF can be read as text. Call it
 * before any PDF is made: a version's PDF is rendered once and served from its cache after that.
 * Undo it with `setPdfRenderer(null)`.
 */
export function printAsText(): void {
  setPdfRenderer(async (_env, html) => new TextEncoder().encode(html));
}

function sessionOf(user: User): { uid: string; vid: string; gen: number; epoch?: string } {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
}

const jar = (...cookies: (string | null | undefined)[]) => cookies.filter(Boolean).join("; ");

/** A Word file as text: every part of the package, as stored and with its markup's escapes undone. */
function wordText(bytes: Uint8Array): string {
  const xml = Object.values(unzipSync(bytes)).map((part) => strFromU8(part)).join("\n");
  const plain = xml.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return `${xml}\n${plain}`;
}

/** Everything the vault sends outward, each part with the surface it left by. A refusal contributes nothing. */
export async function outwardParts({ owner, copies, inputs }: { owner: User; copies: readonly OutwardCopy[]; inputs: readonly string[] }): Promise<OutwardPart[]> {
  const parts: OutwardPart[] = [];
  const add = (surface: OutwardPart["surface"], text: string) => parts.push({ surface, text });

  // Each copy, as anyone with its link reads it and as the coach it names reads it.
  for (const copy of copies) {
    const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: copy.token }) });
    const link = exchange.status === 200 ? cookieFrom(exchange, `__Host-share-${copy.grant.id}`) : null;
    if (link) {
      const read = await call(`/share/snapshot?g=${copy.grant.id}`, { cookie: link });
      if (read.status === 200) add("copy by its link", await read.text());
    }
    if (!copy.coach) continue;
    // Taking a copy up needs its link's own session. Once taken up, it opens from the list without one.
    if (link) await call("/api/coach/clients", { method: "POST", cookie: jar(link, copy.coach.cookie), headers: { "content-type": "application/json" }, body: JSON.stringify({ grantId: copy.grant.id }) });
    const list = await copy.coach.fetch("/api/coach/clients");
    if (list.status === 200) add("coach's client list", await list.text());
    const opened = await copy.coach.send("POST", `/api/coach/clients/${copy.grant.id}/open`);
    if (opened.status === 200) {
      const read = await call(`/share/snapshot?g=${copy.grant.id}`, { cookie: jar(cookieFrom(opened, `__Host-share-${copy.grant.id}`), copy.coach.cookie) });
      if (read.status === 200) add("copy as its coach", await read.text());
    } else if (link) {
      const read = await call(`/share/snapshot?g=${copy.grant.id}`, { cookie: jar(link, copy.coach.cookie) });
      if (read.status === 200) add("copy as its coach", await read.text());
    }
    // What the coach wrote on the copy, suggested wording included, with the owner's replies and
    // where each suggestion stands, as the coach's page reads them.
    const comments = await copy.coach.fetch(`/api/coach/clients/${copy.grant.id}/comments`);
    if (comments.status === 200) add("coach's comments", await comments.text());
  }

  const jobs = (await owner.json<{ applications: ApplicationView[] }>("/api/applications")).applications;
  const finished: { id: string; version: number }[] = [];
  for (const resume of jobs.flatMap((job) => job.resumes).filter((made) => made.state === "ready")) {
    const { versions } = await owner.json<{ versions: { version: number }[] }>(`/api/resumes/${resume.id}/versions`);
    for (const saved of versions) finished.push({ id: resume.id, version: saved.version });
  }

  // Every tool that reads, through a connected app that was given every permission.
  const session = sessionOf(owner);
  const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
  const stub = vault(env, session.vid);
  const grant = await stub.createMcpGrant(who, {
    id: crypto.randomUUID(), clientId: "synthetic-outward-client", clientName: "Outward reader",
    // Long enough to wait for a fit preview of every job, so none is refused for the grant's age.
    scopes: [...MCP_SCOPES], expiresAt: Date.now() + 10 * 60_000,
  });
  const claims: McpClaims = {
    uid: session.uid, vid: session.vid, gen: grant.gen, epoch: grant.epoch,
    grantId: grant.id, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.expiresAt,
  };
  await stub.bindMcpGrant(claims, `synthetic-oauth-${grant.id}`);
  const tool = async (surface: OutwardPart["surface"], answer: () => Promise<unknown>) => {
    try {
      add(surface, JSON.stringify(await answer()));
    } catch {
      // The tool refused, as its server would say in one fixed sentence.
    }
  };
  try {
    await tool("list_facts", () => stub.mcpFacts(claims, { limit: 100 }));
    // A search for the words of each fact the owner has, marked or not: what a search could find.
    const own = (await owner.json<{ facts: FactView[] }>("/api/facts")).facts;
    for (const text of new Set(own.map((fact) => fact.text)))
      await tool("search_facts", () => stub.mcpFacts(claims, { query: text.slice(0, 200), limit: 100 }));
    await tool("list_jobs", () => stub.mcpJobs(claims, { limit: 100 }));
    for (const resume of finished) await tool("get_resume", () => stub.mcpResume(claims, resume.id, resume.version));
    // A fit preview of every saved job. One that isn't current is started, and asked for again with
    // the same key while it is being prepared: what it was measured from is then among the model
    // inputs. A refusal ends the asking at once and contributes nothing.
    for (const job of jobs) {
      const requestKey = crypto.randomUUID();
      await tool("preview_fit", async () => {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const answer = (await stub.mcpFit(claims, job.id, requestKey)) as McpFit;
          if (answer.state !== "preparing") return answer;
          if (Date.now() > deadline) throw new Error("timed out waiting for the fit preview");
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      });
    }
  } finally {
    await stub.revokeMcpGrant(who, grant.id);
  }

  // What each finished version prints: the PDF, the Word file and the print preview.
  for (const resume of finished) {
    const pdf = await owner.fetch(`/api/resumes/${resume.id}/pdf?version=${resume.version}`);
    if (pdf.status === 200) add("PDF", new TextDecoder().decode(await pdf.arrayBuffer()));
    const word = await owner.fetch(`/api/resumes/${resume.id}/docx?version=${resume.version}`);
    if (word.status === 200) add("Word", wordText(new Uint8Array(await word.arrayBuffer())));
    const preview = await owner.fetch(`/api/resumes/${resume.id}/preview?version=${resume.version}`);
    if (preview.status === 200) add("print preview", await preview.text());
  }

  // Each job's application kit as its ZIP: every file in it, a Word file as its text. A kit that
  // isn't approved, or that a check now refuses, gives nothing.
  for (const job of jobs) {
    const archive = await owner.fetch(`/api/applications/${job.id}/kit/archive`);
    if (archive.status !== 200) continue;
    for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(await archive.arrayBuffer()))))
      add("application kit", name.endsWith(".docx") ? wordText(bytes) : strFromU8(bytes));
  }

  for (const input of inputs) add("model input", input);
  return parts;
}

/** Everything the vault sends outward, as one text. */
export async function outward(given: { owner: User; copies: readonly OutwardCopy[]; inputs: readonly string[] }): Promise<string> {
  return (await outwardParts(given)).map((part) => part.text).join("\n");
}
