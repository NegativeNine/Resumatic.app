import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
const card = async (name: string) => (await screen.findByRole("link", { name })).closest("li")!;
const SAVED = /^Saved\. Open the job$/;

describe("adding a job", () => {
  it("saves the job description with its link", async () => {
    const api = start();
    await userEvent.type(await screen.findByLabelText("Job description"), POSTING);
    await userEvent.type(screen.getByLabelText(/^Link to the job/), LINK);
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText(/^Saved\./);
    expect(added(api)).toEqual([{ jdText: POSTING, url: LINK }]);
    // The new job is a row that opens its page.
    expect(await card(POSTING)).toBeInTheDocument();
    // The form is ready for the next job.
    expect(screen.getByLabelText("Job description")).toHaveValue("");
    expect(screen.getByLabelText(/^Link to the job/)).toHaveValue("");
  });

  it("offers the saved job’s page after saving, and keeps focus in the description", async () => {
    start();
    const description = await screen.findByLabelText("Job description");
    await userEvent.type(description, POSTING);
    // A save that doesn't take focus from the description, as a keyboard shortcut or a script would.
    description.focus();
    fireEvent.click(screen.getByRole("button", { name: "Save job" }));
    expect(description).toHaveAttribute("readonly");
    const saved = await screen.findByText(/^Saved\./);
    expect(saved).toHaveTextContent(SAVED);
    expect(within(saved).getByRole("link", { name: "Open the job" })).toHaveAttribute("href", "#/jobs/app-new-1/fit");
    expect(document.activeElement).toBe(description);
    expect(description).toHaveValue("");
  });

  it("links the job already saved when a duplicate is found", async () => {
    const api = start();
    await userEvent.type(await screen.findByLabelText("Job description"), "Platform Engineer, Litware. We're hiring a platform engineer to run our Kubernetes fleet and build the…");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    const warning = (await screen.findByText(/^You’ve already saved this job as Platform Engineer at Litware, on 6 Nov 2026\./)).closest("div")!;
    expect(within(warning).getByRole("link", { name: "Open it" })).toHaveAttribute("href", "#/jobs/app-litware/fit");
    expect(within(warning).getByRole("button", { name: "Save it again" })).toBeEnabled();
    expect(added(api)).toEqual([]);
  });

  it("won't save a link that isn't a web address, and says why", async () => {
    const api = start();
    await userEvent.type(await screen.findByLabelText("Job description"), POSTING);
    const link = screen.getByLabelText(/^Link to the job/);
    await userEvent.type(link, "javascript:alert(1)");
    expect(link).toHaveAttribute("aria-invalid", "true");
    expect(link).toHaveAccessibleDescription("Enter a web address that starts with https://");
    expect(screen.getByRole("button", { name: "Save job" })).toBeDisabled();
    await userEvent.clear(link);
    expect(screen.getByRole("button", { name: "Save job" })).toBeEnabled();
    expect(added(api)).toEqual([]);
  });

  it("asks before saving a job description that's already saved", async () => {
    const api = start();
    const existing = "We are looking for a Staff Engineer to lead our payments platform. You will own the ledger and…";
    await userEvent.type(await screen.findByLabelText("Job description"), `  ${existing}  `);
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    const warning = (await screen.findByText(/You’ve already saved this job, on 3 Nov 2026\./)).closest("div")!;
    expect(added(api)).toEqual([]);
    await userEvent.click(within(warning).getByRole("button", { name: "Save it again" }));
    await screen.findByText(/^Saved\./);
    expect(added(api)).toEqual([{ jdText: existing }]);
    expect(screen.queryByText(/already saved this job/)).toBeNull();
  });

  it("names a duplicate by its title and company when it has them", async () => {
    start();
    await userEvent.type(await screen.findByLabelText("Job description"), "Platform Engineer, Litware. We're hiring a platform engineer to run our Kubernetes fleet and build the…");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    expect(await screen.findByText(/^You’ve already saved this job as Platform Engineer at Litware, on 6 Nov 2026\./)).toBeInTheDocument();
  });

  it("doesn't call a retry of the same save a second copy", async () => {
    const api = start();
    api.fail("POST", /^\/api\/v2\/applications$/, 503, "unavailable", "");
    await userEvent.type(await screen.findByLabelText("Job description"), POSTING);
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText(/^Saved\./);
    // One check, before the first attempt. The retry went straight to saving.
    expect(api.callsTo("POST", /^\/api\/applications\/duplicates$/)).toHaveLength(1);
    expect(added(api)).toHaveLength(2);
  });
});

describe("reading a job from its link", () => {
  const READ = "Staff Engineer at Wingtip Toys\n\nLead the payments platform team and own the ledger service end to end.";
  const found = { posting: { text: READ, title: "Staff Engineer", company: "Wingtip Toys", truncated: false, host: "jobs.example.com" } } as const;
  const button = () => screen.getByRole("button", { name: "Read the job from this link" });

  it("isn't offered where the reader is switched off", async () => {
    start();
    await screen.findByLabelText("Job description");
    expect(screen.queryByRole("button", { name: "Read the job from this link" })).toBeNull();
    expect(screen.getByText("Paste the whole job description, including what it asks for.")).toBeInTheDocument();
  });

  it("fills the description from the page, for the person to check, and saves the job under the page’s name", async () => {
    const api = start(true);
    api.pages.set(LINK, found);
    const description = await screen.findByLabelText("Job description");
    expect(description).toHaveAccessibleDescription(/Or add its link below and read it from there\./);
    // Nothing to read until there is a link that could be a page.
    expect(button()).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Link to the job/), "jobs.example.com");
    expect(button()).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/^Link to the job/));
    await userEvent.type(screen.getByLabelText(/^Link to the job/), LINK);
    await userEvent.click(button());
    await waitFor(() => expect(description).toHaveValue(READ));
    expect(api.callsTo("POST", /^\/api\/postings\/read$/).map((c) => c.body)).toEqual([{ url: LINK }]);
    expect(screen.getByRole("status")).toHaveTextContent("Read from jobs.example.com. Check the text above against the page before saving.");
    // Reading saves nothing. The person saves it, and may change the text first.
    expect(added(api)).toEqual([]);
    await userEvent.type(description, " Hybrid, Toronto.");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();
    expect(added(api)).toEqual([{ jdText: `${READ} Hybrid, Toronto.`, url: LINK, title: "Staff Engineer", company: "Wingtip Toys" }]);
    const job = await card("Staff Engineer");
    expect(within(job).getByText("Wingtip Toys")).toBeInTheDocument();
    expect(description).toHaveValue("");
    expect(screen.queryByText(/^Read from/)).toBeNull();
  });

  it("won’t replace text that is already there", async () => {
    const api = start(true);
    api.pages.set(LINK, found);
    await userEvent.type(await screen.findByLabelText("Job description"), POSTING);
    await userEvent.type(screen.getByLabelText(/^Link to the job/), LINK);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAccessibleDescription("Clear the job description to read it from the link instead.");
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText(/^Saved\./);
    // The pasted text was never read from the page, so the page's name doesn't go with it.
    expect(added(api)).toEqual([{ jdText: POSTING, url: LINK }]);
    expect(api.callsTo("POST", /^\/api\/postings\/read$/)).toEqual([]);
  });

  it("leaves the page’s name behind when the link is changed after reading", async () => {
    const api = start(true);
    api.pages.set(LINK, found);
    const link = screen.getByLabelText(/^Link to the job/);
    await userEvent.type(link, LINK);
    await userEvent.click(button());
    await waitFor(() => expect(screen.getByLabelText("Job description")).toHaveValue(READ));
    await userEvent.type(link, "?ref=board");
    expect(screen.queryByText(/^Read from/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText(/^Saved\./);
    expect(added(api)).toEqual([{ jdText: READ, url: `${LINK}?ref=board` }]);
  });

  it("says why a page gave no job description, and what to do instead", async () => {
    const api = start(true);
    const link = await screen.findByLabelText(/^Link to the job/);
    const cases = [
      [`${LINK}/a`, { posting: null, reason: "unreachable" }, "That page couldn’t be reached. Some job sites block automated reading. Paste the job description instead."],
      [`${LINK}/b`, { posting: null, reason: "not_a_page" }, "That link isn’t a web page. Paste the job description instead."],
      [`${LINK}/c`, { posting: null, reason: "no_posting" }, "No job description was found on that page. Some sites only show it in a browser. Paste its text instead."],
    ] as const;
    for (const [url, result, message] of cases) {
      api.pages.set(url, result);
      await userEvent.clear(link);
      await userEvent.type(link, url);
      await userEvent.click(button());
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByLabelText("Job description")).toHaveValue("");
    }
    // The job description can still be pasted and saved with the link.
    await userEvent.type(screen.getByLabelText("Job description"), POSTING);
    await userEvent.click(screen.getByRole("button", { name: "Save job" }));
    await screen.findByText(/^Saved\./);
    expect(added(api)).toEqual([{ jdText: POSTING, url: `${LINK}/c` }]);
  });

  it("explains an address it won’t read, a long job description it cut, and the reader being off", async () => {
    const api = start(true);
    const link = await screen.findByLabelText(/^Link to the job/);
    await userEvent.type(link, "https://wiki.corp/jobs/1");
    api.fail("POST", /^\/api\/postings\/read$/, 422, "invalid", "use the posting's public web address, starting with https://");
    await userEvent.click(button());
    expect(await screen.findByText("Use the job’s public web address, starting with https://.")).toBeInTheDocument();
    api.fail("POST", /^\/api\/postings\/read$/, 503, "unavailable", "reading a posting from a link is not enabled");
    await userEvent.click(button());
    expect(await screen.findByText("Reading a job from its link isn’t available right now. Paste the job description instead.")).toBeInTheDocument();
    api.pages.set(LINK, { posting: { ...found.posting, truncated: true } });
    await userEvent.clear(link);
    await userEvent.type(link, LINK);
    await userEvent.click(button());
    expect(await screen.findByText(/The job description was longer than Resumatic keeps, so the end is cut off\./)).toBeInTheDocument();
    expect((await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
  });
});
