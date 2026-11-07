import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import { setPdfRenderer } from "../../src/render/pdf";
import { vault } from "../../src/shared/stubs";
import { JOB_DESCRIPTION, RESUME, fakeModels, signIn, waitForResume, waitForSource } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => {
  setModels(null);
  setPdfRenderer(null);
});

it("does not start a PDF cache write when the account closes during rendering", async () => {
    const user = await signIn();
    const upload = await user.upload("resume.pdf", RESUME);
    const { sourceId } = await upload.json() as { sourceId: string };
    await waitForSource(user, sourceId);
    const { facts } = await user.json("/api/facts");
    const { roles } = await user.json("/api/roles");
    const confirm = [...facts, ...roles].map((record: { id: string }) => record.id);
    expect((await user.send("POST", "/api/review", { confirm, reject: [] })).status).toBe(204);
    const application = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
    expect(application.status).toBe(201);
    const { applicationId } = await application.json() as { applicationId: string };
    const started = await user.send("POST", `/api/applications/${applicationId}/resumes`);
    expect(started.status).toBe(202);
    const { resumeId } = await started.json() as { resumeId: string };
    const resume = await waitForResume(user, resumeId);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const rendering = new Promise<void>((resolve) => { entered = resolve; });
    const within = async <T>(promise: Promise<T>, what: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    setPdfRenderer(async () => {
      entered();
      await waiting;
      return new TextEncoder().encode("%PDF-1.7 synthetic");
    });
    const put = vi.spyOn(env.FILES, "put");
    const abort = new AbortController();
    const request = user.fetch(`/api/resumes/${resume.id}/pdf`, { signal: abort.signal });
    try {
      await within(Promise.race([
        rendering,
        request.then((response) => { throw new Error(`PDF request ended before rendering: ${response.status}`); }),
      ]), "PDF rendering");
      const payload = JSON.parse(
        atob(user.cookie.slice("__Host-session=".length).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
      ) as { vid: string };
      // The Directory begins erasure by quiescing the vault. Do that step
      // directly so unrelated deletion alarms cannot interfere with this test.
      await within(vault(env, payload.vid).quiesce(), "vault closure");
      release();
      expect((await within(request, "PDF response")).status).toBe(410);
      expect(put).not.toHaveBeenCalled();
    } finally {
      release();
      abort.abort();
      await within(request, "PDF cleanup").catch(() => {});
      put.mockRestore();
    }
  }, 60_000);

