import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { JobsPage } from "../../src/web/pages/JobsPage";
import { installFakeApi, type FakeApi } from "./api-fake";
import { fixtures } from "./fixtures";
import { renderWithSession } from "./render";

const POSTING = "Staff Engineer, Wingtip Toys. Lead the payments platform team and own the ledger service end to end.";
const LINK = "https://jobs.example.com/wingtip/staff-engineer";

function start(reader = false): FakeApi {
  const state = fixtures();
  if (reader) state.me.capabilities = { ocr: false, connectedApps: false, ...state.me.capabilities, postingReader: true };
  const api = installFakeApi(state);
  renderWithSession(<JobsPage />, state.me);
  return api;
}

const added = (api: FakeApi) => api.callsTo("POST", /^\/api\/v2\/applications$/).map((c) => c.body);
const card = async (name: string) => (await screen.findByRole("heading", { name })).closest("li")!;

async function openWorkspace(name: string): Promise<HTMLElement> {
  const job = await card(name);
  await userEvent.click(within(job).getByRole("button", { name: "Track and prepare" }));
  return job;
}

describe("adding a job", () => {
  it("saves the posting with its link", async () => {
    const api = start();
    await userEvent.type(await screen.findByLabelText("Job description"), POSTING);
    await userEvent.type(screen.getByLabelText(/^Link to the posting/), LINK);
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText("Saved. Tailor a resume to it from the list below.");
    expect(added(api)).toEqual([{ jdText: POSTING, url: LINK }]);
    const job = await card(POSTING);
    expect(within(job).getByRole("link", { name: "Original posting" })).toHaveAttribute("href", LINK);
    // The form is ready for the next job.
    expect(screen.getByLabelText("Job description")).toHaveValue("");
    expect(screen.getByLabelText(/^Link to the posting/)).toHaveValue("");
  });

  it("won't save a link that isn't a web address, and says why", async () => {
    const api = start();
    await userEvent.type(await screen.findByLabelText("Job description"), POSTING);
    const link = screen.getByLabelText(/^Link to the posting/);
    await userEvent.type(link, "javascript:alert(1)");
    expect(link).toHaveAttribute("aria-invalid", "true");
    expect(link).toHaveAccessibleDescription("Enter a web address that starts with https://");
    expect(screen.getByRole("button", { name: "Save job" })).toBeDisabled();
    await userEvent.clear(link);
    expect(screen.getByRole("button", { name: "Save job" })).toBeEnabled();
    expect(added(api)).toEqual([]);
  });

  it("asks before saving a posting that's already saved, and names the job", async () => {
    const api = start();
    const existing = "We are looking for a Staff Engineer to lead our payments platform. You will own the ledger and…";
    await userEvent.type(await screen.findByLabelText("Job description"), `  ${existing}  `);
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    const warning = (await screen.findByText(/You’ve already saved this posting, on 3 Nov 2026\./)).closest("div")!;
    expect(added(api)).toEqual([]);
    await userEvent.click(within(warning).getByRole("button", { name: "Save it again" }));
    await screen.findByText("Saved. Tailor a resume to it from the list below.");
    expect(added(api)).toEqual([{ jdText: existing }]);
    expect(screen.queryByText(/already saved this posting/)).toBeNull();
  });

  it("names a duplicate by its title and company when it has them", async () => {
    start();
    await userEvent.type(await screen.findByLabelText("Job description"), "Platform Engineer, Litware. We're hiring a platform engineer to run our Kubernetes fleet and build the…");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    expect(await screen.findByText("You’ve already saved this posting as Platform Engineer at Litware, on 6 Nov 2026.")).toBeInTheDocument();
  });

  it("doesn't call a retry of the same save a second copy", async () => {
    const api = start();
    api.fail("POST", /^\/api\/v2\/applications$/, 503, "unavailable", "");
    await userEvent.type(await screen.findByLabelText("Job description"), POSTING);
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText("Saved. Tailor a resume to it from the list below.");
    // One check, before the first attempt. The retry went straight to saving.
    expect(api.callsTo("POST", /^\/api\/applications\/duplicates$/)).toHaveLength(1);
    expect(added(api)).toHaveLength(2);
  });
});

describe("reading a posting from its link", () => {
  const READ = "Staff Engineer at Wingtip Toys\n\nLead the payments platform team and own the ledger service end to end.";
  const found = { posting: { text: READ, title: "Staff Engineer", company: "Wingtip Toys", truncated: false, host: "jobs.example.com" } } as const;
  const button = () => screen.getByRole("button", { name: "Read the posting from this link" });

  it("isn't offered where the reader is switched off", async () => {
    start();
    await screen.findByLabelText("Job description");
    expect(screen.queryByRole("button", { name: "Read the posting from this link" })).toBeNull();
    expect(screen.getByText("Paste the whole posting, including the requirements.")).toBeInTheDocument();
  });

  it("fills the description from the page, for the person to check, and saves the job under the page’s name", async () => {
    const api = start(true);
    api.pages.set(LINK, found);
    const description = await screen.findByLabelText("Job description");
    expect(description).toHaveAccessibleDescription(/Or add its link below and read it from there\./);
    // Nothing to read until there is a link that could be a page.
    expect(button()).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Link to the posting/), "jobs.example.com");
    expect(button()).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/^Link to the posting/));
    await userEvent.type(screen.getByLabelText(/^Link to the posting/), LINK);
    await userEvent.click(button());
    await waitFor(() => expect(description).toHaveValue(READ));
    expect(api.callsTo("POST", /^\/api\/postings\/read$/).map((c) => c.body)).toEqual([{ url: LINK }]);
    expect(screen.getByRole("status")).toHaveTextContent("Read from jobs.example.com. Check the text above against the page before saving.");
    // Reading saves nothing. The person saves it, and may change the text first.
    expect(added(api)).toEqual([]);
    await userEvent.type(description, " Hybrid, Toronto.");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    expect(await screen.findByText("Saved. Tailor a resume to it from the list below.")).toBeInTheDocument();
    expect(added(api)).toEqual([{ jdText: `${READ} Hybrid, Toronto.`, url: LINK, title: "Staff Engineer", company: "Wingtip Toys" }]);
    expect(await screen.findByRole("heading", { name: "Staff Engineer at Wingtip Toys" })).toBeInTheDocument();
    expect(description).toHaveValue("");
    expect(screen.queryByText(/^Read from/)).toBeNull();
  });

  it("won’t replace text that is already there", async () => {
    const api = start(true);
    api.pages.set(LINK, found);
    await userEvent.type(await screen.findByLabelText("Job description"), POSTING);
    await userEvent.type(screen.getByLabelText(/^Link to the posting/), LINK);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAccessibleDescription("Clear the job description to read it from the link instead.");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText("Saved. Tailor a resume to it from the list below.");
    // The pasted text was never read from the page, so the page's name doesn't go with it.
    expect(added(api)).toEqual([{ jdText: POSTING, url: LINK }]);
    expect(api.callsTo("POST", /^\/api\/postings\/read$/)).toEqual([]);
  });

  it("leaves the page’s name behind when the link is changed after reading", async () => {
    const api = start(true);
    api.pages.set(LINK, found);
    const link = screen.getByLabelText(/^Link to the posting/);
    await userEvent.type(link, LINK);
    await userEvent.click(button());
    await waitFor(() => expect(screen.getByLabelText("Job description")).toHaveValue(READ));
    await userEvent.type(link, "?ref=board");
    expect(screen.queryByText(/^Read from/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText("Saved. Tailor a resume to it from the list below.");
    expect(added(api)).toEqual([{ jdText: READ, url: `${LINK}?ref=board` }]);
  });

  it("says why a page gave no posting, and what to do instead", async () => {
    const api = start(true);
    const link = await screen.findByLabelText(/^Link to the posting/);
    const cases = [
      [`${LINK}/a`, { posting: null, reason: "unreachable" }, "That page couldn’t be reached. Some job sites block automated reading. Paste the posting’s text instead."],
      [`${LINK}/b`, { posting: null, reason: "not_a_page" }, "That link isn’t a web page. Paste the posting’s text instead."],
      [`${LINK}/c`, { posting: null, reason: "no_posting" }, "No job posting was found on that page. Some sites only show the posting in a browser. Paste its text instead."],
    ] as const;
    for (const [url, result, message] of cases) {
      api.pages.set(url, result);
      await userEvent.clear(link);
      await userEvent.type(link, url);
      await userEvent.click(button());
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByLabelText("Job description")).toHaveValue("");
    }
    // The posting can still be pasted and saved with the link.
    await userEvent.type(screen.getByLabelText("Job description"), POSTING);
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText("Saved. Tailor a resume to it from the list below.");
    expect(added(api)).toEqual([{ jdText: POSTING, url: `${LINK}/c` }]);
  });

  it("explains an address it won’t read, a long posting it cut, and the reader being off", async () => {
    const api = start(true);
    const link = await screen.findByLabelText(/^Link to the posting/);
    await userEvent.type(link, "https://wiki.corp/jobs/1");
    api.fail("POST", /^\/api\/postings\/read$/, 422, "invalid", "use the posting's public web address, starting with https://");
    await userEvent.click(button());
    expect(await screen.findByText("Use the posting’s public web address, starting with https://.")).toBeInTheDocument();
    api.fail("POST", /^\/api\/postings\/read$/, 503, "unavailable", "reading a posting from a link is not enabled");
    await userEvent.click(button());
    expect(await screen.findByText("Reading a posting from a link isn’t available right now. Paste its text instead.")).toBeInTheDocument();
    api.pages.set(LINK, { posting: { ...found.posting, truncated: true } });
    await userEvent.clear(link);
    await userEvent.type(link, LINK);
    await userEvent.click(button());
    expect(await screen.findByText(/The posting was longer than Resumatic keeps, so the end is cut off\./)).toBeInTheDocument();
    expect((await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
  });
});

describe("a saved job's posting", () => {
  it("shows the whole posting only when asked", async () => {
    const api = start();
    const job = await openWorkspace("Platform Engineer at Litware");
    expect(api.callsTo("GET", /^\/api\/applications\/app-litware$/)).toHaveLength(0);
    await userEvent.click(within(job).getByRole("button", { name: "Read the posting" }));
    const text = await within(job).findByRole("group", { name: "The posting’s text" });
    expect(text).toHaveTextContent("We're hiring a platform engineer to run our Kubernetes fleet");
    await userEvent.click(within(job).getByRole("button", { name: "Hide the posting" }));
    expect(within(job).queryByRole("group", { name: "The posting’s text" })).toBeNull();
    // A job with resumes can only be closed.
    expect(within(job).queryByRole("button", { name: "Delete job" })).toBeNull();
    expect(within(job).getByText("A job with resumes can’t be deleted. Mark it Closed instead.")).toBeInTheDocument();
  });

  it("saves a title, company and link, then keeps tracking in step with the new revision", async () => {
    const api = start();
    const unnamed = "We are looking for a Staff Engineer to lead our payments platform. You will own the ledger and…";
    const job = await openWorkspace(unnamed);
    await userEvent.click(within(job).getByRole("button", { name: "Edit details" }));
    const form = await within(job).findByRole("form", { name: "Job details" });
    expect((await axe.run(form, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
    await userEvent.type(within(form).getByLabelText(/^Job title/), "Staff Engineer");
    await userEvent.type(within(form).getByLabelText(/^Company/), "Wingtip Toys");
    await userEvent.type(within(form).getByLabelText(/^Link to the posting/), LINK);
    await userEvent.click(within(form).getByRole("button", { name: "Save details" }));
    const renamed = await card("Staff Engineer at Wingtip Toys");
    expect(within(renamed).getByText("Saved.")).toBeInTheDocument();
    const patches = () => api.callsTo("PATCH", /^\/api\/applications\/app-unnamed$/).map((c) => c.body);
    // The posting's text didn't change, so it wasn't sent.
    expect(patches()).toEqual([{ title: "Staff Engineer", company: "Wingtip Toys", url: LINK }]);
    await userEvent.click(within(renamed).getByRole("button", { name: "Save tracking details" }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]).toMatchObject({ status: "saved" });
  });

  it("deletes a job with nothing attached, after asking", async () => {
    const api = start();
    const unnamed = "We are looking for a Staff Engineer to lead our payments platform. You will own the ledger and…";
    const job = await openWorkspace(unnamed);
    await userEvent.click(within(job).getByRole("button", { name: "Delete job" }));
    const confirm = within(job).getByRole("group", { name: "Delete this job" });
    expect(api.callsTo("DELETE", /^\/api\/applications\//)).toHaveLength(0);
    await userEvent.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(within(job).queryByRole("group", { name: "Delete this job" })).toBeNull();
    await userEvent.click(within(job).getByRole("button", { name: "Delete job" }));
    await userEvent.click(within(within(job).getByRole("group", { name: "Delete this job" })).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: unnamed })).toBeNull());
    expect(api.callsTo("DELETE", /^\/api\/applications\/app-unnamed$/)).toHaveLength(1);
  });
});

describe("checking fit", () => {
  it("is free to start, and lists each requirement with the facts that cover it", async () => {
    const api = start();
    const job = await openWorkspace("Platform Engineer at Litware");
    await userEvent.click(await within(job).findByRole("button", { name: "Check your fit" }));
    expect(api.callsTo("POST", /^\/api\/applications\/app-litware\/documents$/).map((c) => c.body)).toEqual([{ kind: "fit" }]);
    const preview = (await within(job).findByRole("heading", { name: "Fit preview" })).closest("li")!;
    await userEvent.click(within(preview).getByText("Read fit preview"));
    expect(within(preview).getByText("Your confirmed facts cover 1 of 2 requirements.")).toBeInTheDocument();
    const rows = within(preview).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Kubernetes in production");
    // The covering facts are the person's own, shown as they confirmed them.
    expect(rows[0]!.querySelectorAll(".app-fit__fact")).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("Terraform Not covered");
    expect(rows[1]!.querySelector(".rs-tick--proposed")).not.toBeNull();
    expect((await axe.run(preview, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
  });

  it("stays available when the month's outputs are used up", async () => {
    const state = fixtures();
    state.me.quota.used = state.me.quota.limit;
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    const job = await openWorkspace("Platform Engineer at Litware");
    expect(await within(job).findByRole("button", { name: "Check your fit" })).toBeEnabled();
    expect(within(job).getByRole("button", { name: "Create cover letter" })).toBeDisabled();
  });
});
