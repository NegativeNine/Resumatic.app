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

function start(): FakeApi {
  const state = fixtures();
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
