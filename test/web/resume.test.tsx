import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { placeNotes } from "../../src/web/components/margin-layout";
import { isWrittenAnswer } from "../../src/web/components/ResumeReport";
import { ResumePage } from "../../src/web/pages/ResumePage";
import { installFakeApi, type FakeApi } from "./api-fake";
import { fixtures, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

async function openResume(state: Fixtures = fixtures()): Promise<FakeApi> {
  const api = installFakeApi(state);
  renderWithSession(<ResumePage id="res-ready" />, state.me);
  await screen.findByRole("article", { name: "Resume preview" });
  return api;
}

const sheet = () => screen.getByRole("article", { name: "Resume preview" });

describe("the resume sheet", () => {
  it("prints the profile header, like the PDF", async () => {
    await openResume();
    expect(within(sheet()).getByRole("heading", { level: 1, name: "Sam Rivera" })).toBeInTheDocument();
    expect(within(sheet()).getByText("sam.rivera@example.com · Waterloo, ON · linkedin.com/in/samrivera")).toBeInTheDocument();
  });

  it("prints the contact details captured with the version, not today’s", async () => {
    const state = fixtures();
    state.resumes["res-ready"]!.profile = { ...state.me.profile, name: "Samantha Rivera", location: "Toronto, ON" };
    await openResume(state);
    expect(within(sheet()).getByRole("heading", { level: 1, name: "Samantha Rivera" })).toBeInTheDocument();
    expect(within(sheet()).getByText(/Toronto, ON/)).toBeInTheDocument();
  });

  it("orders sections as the template does, with every non-education role under Experience", async () => {
    await openResume();
    expect(within(sheet()).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Experience", "Education", "Skills"]);
    expect(within(sheet()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Senior Backend Engineer, Northwind Logistics",
      "Software Engineer, Contoso Health",
      "Volunteer data engineer, Fabrikam Transit Data",
      "BASc, Computer Engineering, University of Waterloo",
    ]);
    expect(within(sheet()).getByText("Mar 2021 – Present")).toBeInTheDocument();
    expect(within(sheet()).getByText("Python · Apache Airflow · Redis · PostgreSQL · Kubernetes")).toBeInTheDocument();
  });

  it("keeps marks and tools off the paper", async () => {
    await openResume();
    expect(sheet().querySelector("button, .rs-mark, [role='button']")).toBeNull();
  });
});

describe("the margin", () => {
  it("opens a line’s note from the sheet or its toggle, and says so", async () => {
    await openResume();
    const toggles = screen.getAllByRole("button", { name: /^\d+ facts?$|^Hide evidence$/ });
    expect(toggles.length).toBe(7);
    for (const toggle of toggles) expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(within(sheet()).getByText("Led the migration of 40 services from Heroku to Kubernetes."));
    expect(screen.getByRole("button", { name: "Hide evidence" })).toHaveAttribute("aria-expanded", "true");
  });

  it("says why a repaired or replaced line changed, in Resumatic’s own words", async () => {
    await openResume();
    const note = (lineId: string) => document.querySelector<HTMLElement>(`[data-note-for="${lineId}"]`)!;
    await userEvent.click(within(note("line-latency")).getByRole("button", { name: /^\d+ facts?$/ }));
    expect(within(note("line-latency")).getByText(
      "The draft said 85%. Your facts don’t include that number. Resumatic rewrote it once to match its facts.",
    )).toBeVisible();
    await userEvent.click(within(note("line-mentoring")).getByRole("button", { name: /^\d+ facts?$/ }));
    expect(within(note("line-mentoring")).getByText(
      "The draft said you led it, which is more than your facts show. This line uses your fact’s own words instead.",
    )).toBeVisible();
    // A kept line has nothing to explain.
    expect(note("line-migration").textContent).not.toMatch(/The draft/);
  });

  it("opens and closes every note with Show all evidence", async () => {
    await openResume();
    await userEvent.click(screen.getByRole("button", { name: "Show all evidence" }));
    expect(screen.getAllByRole("button", { name: "Hide evidence" })).toHaveLength(7);
    await userEvent.click(screen.getByRole("button", { name: "Hide all evidence" }));
    expect(screen.queryAllByRole("button", { name: "Hide evidence" })).toHaveLength(0);
  });

  it("shows what each mark means and how many lines took it", async () => {
    await openResume();
    const strip = screen.getByRole("region", { name: "How each line was checked" });
    expect(within(strip).getByText("Used your fact", { selector: "dt" })).toBeInTheDocument();
    expect(within(strip).getByRole("link", { name: "2 possible gaps noted when this draft was made" })).toHaveAttribute("href", "#gaps-heading");
  });
});

describe("closing a gap", () => {
  it("asks for the person’s own words, not a bare yes", async () => {
    const api = await openResume();
    await userEvent.click(screen.getByRole("button", { name: "Add a fact for Terraform" }));
    const answer = screen.getByLabelText("Terraform: describe what you did, in your own words");
    const add = screen.getByRole("button", { name: "Add fact" });
    await userEvent.type(answer, "Yes");
    expect(add).toBeDisabled();
    await userEvent.clear(answer);
    await userEvent.type(answer, "Wrote Terraform modules for our staging network.");
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(await screen.findByText("Fact added.")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/v2\/facts$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/v2\/facts$/)[0]!.body).toMatchObject({ text: "Wrote Terraform modules for our staging network.", roleId: null });
    const gap = screen.getByText("Fact added.").closest<HTMLElement>(".app-gap-answer")!;
    expect(within(gap).getByRole("button", { name: "Tailor a new version" })).toBeInTheDocument();
  });

  it("knows a written answer from a bare one", () => {
    expect(isWrittenAnswer("yes")).toBe(false);
    expect(isWrittenAnswer("Yep!")).toBe(false);
    expect(isWrittenAnswer("I did")).toBe(false);
    expect(isWrittenAnswer("Ran Kafka clusters")).toBe(true);
  });
});

describe("placeNotes", () => {
  it("keeps each note level with its line when there’s room", () => {
    expect(placeNotes([0, 100, 200], [40, 40, 40], 8)).toEqual([0, 100, 200]);
    expect(placeNotes([0, 100], [40, 40])).toEqual([0, 100]);
  });

  it("pushes a note down only as far as it must go to clear the one above", () => {
    expect(placeNotes([0, 20, 200], [40, 40, 40], 8)).toEqual([0, 48, 200]);
    expect(placeNotes([0, 10, 20], [30, 30, 30], 10)).toEqual([0, 40, 80]);
  });
});
