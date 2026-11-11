import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { placeNotes } from "../../src/web/components/margin-layout";
import { isWrittenAnswer } from "../../src/web/components/ResumeReport";
import { ResumeSheet } from "../../src/web/components/ResumeSheet";
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

describe("a version that uses a fact marked sensitive", () => {
  const NOTICE =
    "This version uses a fact you’ve marked sensitive, or was checked against the line of an upload one was read from, so it can’t be downloaded or shared, and connected apps can’t read it.";
  const note = (lineId: string) => document.querySelector<HTMLElement>(`[data-note-for="${lineId}"]`)!;
  /** The fixture resume as the server sends it once one cited fact and one printed skill are marked. */
  function marked(): Fixtures {
    const state = fixtures();
    state.resumes["res-ready"]!.sensitiveUse = { lineIds: ["line-migration"], skills: ["Redis"] };
    return state;
  }

  it("offers its downloads as usual while nothing it uses is marked", async () => {
    await openResume();
    for (const name of ["Download PDF", "Download Word", "Print preview"]) expect(screen.getByRole("link", { name })).toBeInTheDocument();
    expect(screen.queryByText(/marked sensitive/)).toBeNull();
    expect(screen.queryByText("Sensitive fact")).toBeNull();
  });

  it("says why it can’t be downloaded or shared and what to do, and offers no download", async () => {
    await openResume(marked());
    const notice = screen.getByText(new RegExp(`^${NOTICE.replace(/[.’]/g, (c) => (c === "." ? "\\." : c))}`));
    expect(notice).toHaveTextContent(
      `${NOTICE} Remove the lines and skills marked ‘Sensitive fact’, or tailor a new version. Your text is still here.`,
    );
    expect(notice).toHaveAttribute("role", "status");
    for (const name of ["Download PDF", "Download Word", "Print preview"]) expect(screen.queryByRole("link", { name })).toBeNull();
    // The text is still on the sheet, and a new version can still be tailored.
    expect(within(sheet()).getByText("Led the migration of 40 services from Heroku to Kubernetes.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Tailor a new version" }).length).toBeGreaterThan(0);
    // It is not the notice for wording without evidence, and no line-by-line review is offered.
    expect(screen.queryByText(/without verified evidence/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
  });

  it("opens the notes of the lines that use it, marks them, and lets them be removed but not reworded", async () => {
    const state = marked();
    const api = await openResume(state);
    const flagged = note("line-migration");
    expect(within(flagged).getByText("Sensitive fact")).toHaveClass("rs-mark--dropped");
    // Its note is open without being asked, with its evidence and its one tool.
    expect(within(flagged).getByRole("button", { name: "Hide evidence" })).toHaveAttribute("aria-expanded", "true");
    expect(within(flagged).getByText("Led migration of 40 services from Heroku to Kubernetes")).toBeVisible();
    expect(within(flagged).queryByRole("button", { name: "Edit line" })).toBeNull();
    expect(within(flagged).getByRole("button", { name: "Remove line (keeps earlier versions)" })).toBeVisible();
    // Every other line is as it always is: closed, unmarked, and editable once opened.
    const other = note("line-latency");
    expect(within(other).queryByText("Sensitive fact")).toBeNull();
    expect(within(other).getByRole("button", { name: /^\d+ facts?$/ })).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(within(other).getByRole("button", { name: /^\d+ facts?$/ }));
    expect(within(other).getByRole("button", { name: "Edit line" })).toBeVisible();
    expect(screen.getAllByText("Sensitive fact", { selector: ".app-notes .rs-mark" })).toHaveLength(1);

    // Removing the line is the existing request, for this line and this version.
    await userEvent.click(within(flagged).getByRole("button", { name: "Remove line (keeps earlier versions)" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/resumes\/res-ready\/remove-line$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/resumes\/res-ready\/remove-line$/)[0]!.body).toEqual({ lineId: "line-migration", expectedVersion: 2 });
    // The new version has no such line, and a marked skill still holds it back.
    await waitFor(() => expect(note("line-migration")).toBeNull());
    expect(screen.getByText(/marked sensitive, or was checked against/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull();
    // With the skill removed as well, nothing does, and the downloads are back.
    await userEvent.click(screen.getByRole("button", { name: "Remove skill Redis" }));
    expect(await screen.findByRole("link", { name: "Download PDF" })).toHaveAttribute("href", "/api/resumes/res-ready/pdf?version=4");
    expect(screen.queryByText(/marked sensitive/)).toBeNull();
    expect(screen.queryByText("Sensitive fact")).toBeNull();
    expect(api.callsTo("POST", /^\/api\/resumes\/res-ready\/remove-skill$/)[0]!.body).toEqual({ skillIndex: 2, expectedVersion: 3 });
  });

  it("marks the printed skills only marked facts stand behind, under Change this version", async () => {
    await openResume(marked());
    const tools = screen.getByRole("region", { name: "Change this version" });
    const skill = (name: string) => within(tools).getByRole("button", { name: `Remove skill ${name}` }).closest("li")!;
    expect(within(skill("Redis")).getByText("Sensitive fact")).toHaveClass("rs-mark--dropped");
    for (const name of ["Python", "Apache Airflow", "PostgreSQL", "Kubernetes"]) expect(within(skill(name)).queryByText("Sensitive fact")).toBeNull();
    expect(within(skill("Redis")).getByRole("button", { name: "Remove skill Redis" })).toBeEnabled();
  });

  it("tells the reader of a saved version to go to Latest to change it", async () => {
    const state = marked();
    installFakeApi(state);
    const resume = state.resumes["res-ready"]!;
    renderWithSession(<ResumeSheet resume={resume} body={resume.body!} reload={async () => undefined} readOnly />, state.me);
    const notice = screen.getByText(new RegExp(`^${NOTICE.replace(/[.’]/g, (c) => (c === "." ? "\\." : c))}`));
    expect(notice).toHaveTextContent(`${NOTICE} Your text is still here. Select Latest to change it.`);
    expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull();
    // A saved version is read, not changed: its marked line shows its mark and offers no tool.
    const flagged = note("line-migration");
    expect(within(flagged).getByText("Sensitive fact")).toBeInTheDocument();
    expect(within(flagged).queryByRole("button", { name: /Edit line|Remove line/ })).toBeNull();
  });

  it("keeps Review line on a line of an older version under review", async () => {
    const state = marked();
    const resume = state.resumes["res-ready"]!;
    resume.provenance = "legacy";
    resume.legacyReview = { verifiedLineIds: [], totalLines: 7, headersReady: true, skillsReady: true };
    await openResume(state);
    const flagged = note("line-migration");
    expect(within(flagged).getByText("Sensitive fact")).toBeInTheDocument();
    expect(within(flagged).getByRole("button", { name: "Review line" })).toBeVisible();
    expect(within(flagged).getByRole("button", { name: "Remove line (keeps earlier versions)" })).toBeVisible();
  });

  it("doesn’t offer a marked fact as evidence for a line", async () => {
    const state = fixtures();
    // An older version under review: each line is checked against facts the person chooses.
    const resume = state.resumes["res-ready"]!;
    resume.provenance = "legacy";
    resume.legacyReview = { verifiedLineIds: [], totalLines: 7, headersReady: true, skillsReady: true };
    state.facts.find((fact) => fact.id === "fact-audit")!.sensitive = true;
    await openResume(state);
    const line = note("line-pipeline");
    await userEvent.click(within(line).getByRole("button", { name: "Review note" }));
    await userEvent.click(within(line).getByRole("button", { name: "Review line" }));
    const choices = await within(line).findByRole("group", { name: "Supporting facts for this role" });
    // The role has two confirmed facts. Only the one that isn't marked can be chosen.
    await within(choices).findByRole("checkbox", { name: /Built the claims-intake pipeline/ });
    expect(within(choices).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(choices).queryByText(/audit logging/)).toBeNull();
  });

  it("is structurally accessible with its notice, marks and open note", async () => {
    await openResume(marked());
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
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
