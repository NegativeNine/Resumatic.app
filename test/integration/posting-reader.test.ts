import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { ApplicationView, FactView, Me, RoleView } from "../../src/shared/api";
import type { PostingRead } from "../../src/shared/postings";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { setPostingFetcher } from "../../src/worker/postings";
import { ANALYSIS, call, fakeModels, JOB_DESCRIPTION, ORIGIN, RESUME, signIn, waitForResume, waitForSource, type User } from "./support";

const LINK = "https://jobs.example.com/litware/platform-engineer";
const DESCRIPTION = "Run our Kubernetes fleet and build the tools product teams ship with. Own the release pipeline.";
const PAGE = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "JobPosting", title: "Platform Engineer",
  hiringOrganization: { name: "Litware" }, description: `<p>${DESCRIPTION}</p>`,
})}</script></head><body></body></html>`;

let asked: string[] = [];
/** Every address is this one page unless a test says otherwise. No test reaches a real site. */
function site(answer: (url: string) => Response = () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })) {
  asked = [];
  setPostingFetcher(async (url) => {
    asked.push(url);
    return answer(url);
  });
}

// The local runtime shares one set of settings between the tests and the Worker, so the switch is
// thrown here for each test and put back after it. Nothing else in the suite turns the reader on.
const settings = env as unknown as { POSTING_READER_ENABLED?: string };
const AS_CONFIGURED = settings.POSTING_READER_ENABLED;

beforeEach(() => {
  setModels(() => fakeModels());
  site();
  settings.POSTING_READER_ENABLED = "true";
});
afterEach(() => {
  setModels(null);
  setPostingFetcher(null);
  settings.POSTING_READER_ENABLED = AS_CONFIGURED;
});

/** A request to the Worker with the reader switched on, as the person or as nobody. */
function on(user: User | null, method: string, path: string, body?: unknown, key?: string) {
  return call(path, {
    method,
    ...(user ? { cookie: user.cookie } : {}),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}
const jobs = async (user: User) => (await user.json<{ applications: ApplicationView[] }>("/api/applications")).applications;

describe("reading a posting from its link", () => {
  it("is off unless the Worker is told otherwise, and says so to the app", async () => {
    const user = await signIn();
    // As the suite and every environment are configured: the setting isn't there at all.
    expect(AS_CONFIGURED).toBeUndefined();
    for (const off of [AS_CONFIGURED, "false", "TRUE", "1", ""]) {
      settings.POSTING_READER_ENABLED = off;
      const refused = await user.send("POST", "/api/postings/read", { url: LINK });
      expect(refused.status, String(off)).toBe(503);
      expect(await refused.json(), String(off)).toMatchObject({ error: "unavailable" });
      expect((await user.json<Me>("/api/me")).capabilities?.postingReader, String(off)).toBe(false);
    }
    expect(asked).toEqual([]);
    settings.POSTING_READER_ENABLED = "true";
    expect((await user.json<Me>("/api/me")).capabilities?.postingReader).toBe(true);
    expect((await user.send("POST", "/api/postings/read", { url: LINK })).status).toBe(200);
  });

  it("reads for a signed-in person only, returns what the page says and saves nothing", async () => {
    expect((await on(null, "POST", "/api/postings/read", { url: LINK })).status).toBe(401);
    expect(asked).toEqual([]);
    const user = await signIn();
    const response = await on(user, "POST", "/api/postings/read", { url: `${LINK}#apply` });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      posting: { text: `Platform Engineer at Litware\n\n${DESCRIPTION}`, title: "Platform Engineer", company: "Litware", truncated: false, host: "jobs.example.com" },
    });
    expect(asked).toEqual([LINK]);
    expect(await jobs(user)).toEqual([]);
  });

  it("asks no site for an address inside a network, a malformed one, or none", async () => {
    const user = await signIn();
    for (const url of [
      "https://169.254.169.254/latest/meta-data/", "https://localhost/admin", "https://127.0.0.1/", "https://[::1]/", "https://wiki.corp/",
      "https://jobs.example.com:8443/a", `${ORIGIN}/api/export`, "ftp://jobs.example.com/a", "not a link", "",
    ]) {
      const response = await on(user, "POST", "/api/postings/read", { url });
      expect(response.status, url).toBe(422);
      expect(await response.json(), url).toMatchObject({ error: "invalid" });
    }
    for (const body of [{}, { url: 7 }, { url: null }, { link: LINK }])
      expect((await on(user, "POST", "/api/postings/read", body)).status, JSON.stringify(body)).toBe(422);
    expect(asked).toEqual([]);
  });

  it("answers plainly when a page gives no posting", async () => {
    const user = await signIn();
    const read = async () => (await (await on(user, "POST", "/api/postings/read", { url: LINK })).json()) as PostingRead;
    site(() => new Response("Forbidden", { status: 403, headers: { "content-type": "text/html" } }));
    expect(await read()).toEqual({ posting: null, reason: "unreachable" });
    site(() => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }));
    expect(await read()).toEqual({ posting: null, reason: "not_a_page" });
    site(() => new Response("<html><body>Apply in the app.</body></html>", { headers: { "content-type": "text/html" } }));
    expect(await read()).toEqual({ posting: null, reason: "no_posting" });
    // A redirect that points inward ends the read. The address it names is never asked for.
    site(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    expect(await read()).toEqual({ posting: null, reason: "unreachable" });
    expect(asked).toEqual([LINK]);
  });
});

describe("saving a job with the name its page gives", () => {
  const body = { jdText: `Platform Engineer at Litware\n\n${DESCRIPTION}`, url: LINK, title: "  Platform Engineer ", company: "Litware" };

  it("names the job at once, and treats a retry as the same job", async () => {
    const user = await signIn();
    const key = crypto.randomUUID();
    const created = await on(user, "POST", "/api/v2/applications", body, key);
    expect(created.status, await created.clone().text()).toBe(201);
    const { applicationId } = (await created.json()) as { applicationId: string };
    expect(await jobs(user)).toMatchObject([{ id: applicationId, title: "Platform Engineer", company: "Litware", url: LINK }]);
    // The same request again is the same job. The same key for a different name is a mistake.
    expect(await (await on(user, "POST", "/api/v2/applications", body, key)).json()).toEqual({ applicationId });
    expect((await on(user, "POST", "/api/v2/applications", { ...body, company: "Contoso" }, key)).status).toBe(409);
    expect((await on(user, "POST", "/api/v2/applications", { jdText: body.jdText, url: LINK }, key)).status).toBe(409);
    expect(await jobs(user)).toHaveLength(1);
    // The page's name isn't the person's own, so it doesn't count as one they set.
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT title, company, details_edited FROM applications`).toArray()).toEqual([{ title: "Platform Engineer", company: "Litware", details_edited: 0 }]);
    });
  });

  it("keeps a name to one line of a job's length, and a nameless request as it always was", async () => {
    const user = await signIn();
    for (const bad of [{ title: "x".repeat(161) }, { company: "Litware\nPayments" }, { title: 7 }])
      expect((await on(user, "POST", "/api/v2/applications", { ...body, ...bad }, crypto.randomUUID())).status, JSON.stringify(bad).slice(0, 40)).toBe(422);
    expect(await jobs(user)).toEqual([]);
    // Empty names are no names: the request is the one a job without a link's name has always been.
    const key = crypto.randomUUID();
    const plain = await on(user, "POST", "/api/v2/applications", { jdText: body.jdText, url: LINK, title: " ", company: "" }, key);
    expect(plain.status).toBe(201);
    expect(await (await user.fetch("/api/v2/applications", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ jdText: body.jdText, url: LINK }),
    })).json()).toEqual(await plain.json());
    expect(await jobs(user)).toMatchObject([{ title: null, company: null, url: LINK }]);
  });

  it("lets the posting's own reading rename it, but not unname it", async () => {
    const user = await signIn();
    const upload = await user.upload("synthetic.pdf", RESUME);
    await waitForSource(user, ((await upload.json()) as { sourceId: string }).sourceId);
    const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
    const { roles } = await user.json<{ roles: RoleView[] }>("/api/roles");
    expect((await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
    const tailor = async (applicationId: string) => {
      const started = await user.send("POST", `/api/applications/${applicationId}/resumes`);
      expect(started.status, await started.clone().text()).toBe(202);
      const resume = await waitForResume(user, ((await started.json()) as { resumeId: string }).resumeId);
      expect(resume.state).toBe("ready");
    };
    const save = async (posting: string) =>
      ((await (await on(user, "POST", "/api/v2/applications", { jdText: posting, url: LINK, title: "Platform Engineer", company: "Litware" }, crypto.randomUUID())).json()) as { applicationId: string }).applicationId;
    const named = async (id: string) => (await jobs(user)).find((job) => job.id === id)!;

    // The reading found neither: what the page called the job stays.
    setModels(() => fakeModels({ analysis: { ...ANALYSIS, company: null, title: null } }));
    const kept = await save(JOB_DESCRIPTION);
    await tailor(kept);
    expect(await named(kept)).toMatchObject({ title: "Platform Engineer", company: "Litware" });

    // The reading found both: they replace the page's, as they would any name the person didn't set.
    setModels(() => fakeModels());
    const renamed = await save(`${JOB_DESCRIPTION}\nApply by the end of the month.`);
    await tailor(renamed);
    expect(await named(renamed)).toMatchObject({ title: ANALYSIS.title, company: ANALYSIS.company });
  });
});
