import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { JobsPage } from "../../src/web/pages/JobsPage";
import { SignedOut } from "../../src/web/pages/SignedOut";
import { THEME_KEY } from "../../src/web/theme";
import { installFakeApi } from "./api-fake";
import { permissions } from "../../src/web/components/ConnectedApps";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { formatDateTime } from "../../src/web/format";
import { fixtures, fullVault, sharedView } from "./fixtures";
import { renderWithSession } from "./render";

describe("Jobs", () => {
  it("marks only the newest resume of a job as Latest", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    const job = (await screen.findByRole("heading", { name: "Platform Engineer at Litware" })).closest("li")!;
    const rows = within(job).getAllByRole("link", { name: /^Resume tailored/ }).map((a) => a.closest("li")!);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Latest")).toBeInTheDocument();
    expect(within(rows[1]!).queryByText("Latest")).toBeNull();
  });

  it("explains a used-up quota at the top, and keeps every Tailor button working", async () => {
    const state = fixtures();
    state.me.quota.used = state.me.quota.limit;
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    await screen.findByRole("heading", { name: "Platform Engineer at Litware" });
    expect(screen.getByText(/You’ve used all 20/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Tailor a resume" })) expect(button).toBeEnabled();
  });

  it("shows which view is on, and switches between List and Board", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    const list = await screen.findByRole("button", { name: "List" });
    const board = screen.getByRole("button", { name: "Board" });
    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(board).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(board);
    expect(board).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Jobs by status" })).toBeInTheDocument();
  });

  it("joins a job’s meta without middle dots", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    await screen.findByText(/it’s read from the posting when a resume is tailored/);
    for (const meta of document.querySelectorAll(".app-job-meta")) expect(meta.textContent).not.toContain("·");
  });
});

describe("signing in", () => {
  it("puts notes and errors above the button", () => {
    render(<SignedOut note="You’ve signed out." error="Sign-in was cancelled. You can try again whenever you’re ready." />);
    const button = screen.getByRole("link", { name: "Sign in with Google" });
    expect(button.textContent).toBe("Sign in with Google");
    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    expect(status.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tailored resumes, built only from what you’ve done.");
  });
});

describe("Account", () => {
  it("switches the theme at once and keeps the choice in this browser", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows the device when the choice is Match system", async () => {
    const dark = vi.fn((query: string) => ({ matches: query.includes("dark"), media: query, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("matchMedia", dark);
    const state = fixtures();
    installFakeApi(state);
    window.localStorage.setItem(THEME_KEY, "light");
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("radio", { name: "Match system" }));
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });

  it("keeps Delete my account disabled until the phrase is typed", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const remove = await screen.findByRole("button", { name: "Delete my account" });
    expect(remove).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/to confirm/), "delete my account");
    expect(remove).toBeEnabled();
  });
});

describe("account tools", () => {
  it("counts what a share link holds in plain words, and marks its state", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    // A link with a label goes by it, and says what it holds underneath.
    const active = (await screen.findByText("Dana Okafor")).closest("li")!;
    expect(within(active).getByText("Active")).toBeInTheDocument();
    expect(within(active).getByRole("button", { name: "Revoke link" })).toBeEnabled();
    const shares = state.shares!;
    const opened = shares[0]!.lastReadAt!;
    expect(active.querySelector(".rs-setting__text > span")!.textContent).toMatch(
      new RegExp(`^6 facts, 1 resume version and 1 document\\. Created .+\\. Expires .+\\. Last opened ${formatDateTime(opened)}\\.$`),
    );
    // A copy with no resumes doesn't mention them.
    const expired = screen.getByText("3 facts").closest("li")!;
    expect(within(expired).getByText("Expired")).toBeInTheDocument();
    expect(within(expired).queryByRole("button")).toBeNull();
    expect(expired.querySelector(".rs-setting__text > span")!.textContent).toMatch(/^Created .+\. Expired .+\. Never opened\.$/);
    const revoked = screen.getByText("12 facts and 2 resume versions").closest("li")!;
    expect(within(revoked).getByText("Revoked")).toBeInTheDocument();
    expect(revoked.textContent).toContain(`Last opened ${formatDateTime(shares[2]!.lastReadAt!)}.`);
  });

  it("says a link hasn’t been opened only when the server keeps that reading", async () => {
    const state = fullVault();
    const [first, second, third] = state.shares!;
    first!.lastReadAt = null;
    delete second!.lastReadAt;
    delete third!.lastReadAt;
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const active = (await screen.findByText("Dana Okafor")).closest("li")!;
    expect(active.textContent).toContain("Not opened yet.");
    for (const text of ["3 facts", "12 facts and 2 resume versions"]) {
      const row = screen.getByText(text).closest("li")!;
      expect(row.textContent).not.toMatch(/opened/i);
    }
  });

  it("asks who a link is for and what the copy should say, and sends exactly that", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const facts = await screen.findByRole("group", { name: /Confirmed facts/ });
    const name = screen.getByRole("checkbox", { name: "Put my name at the top of the copy" });
    const jobs = screen.getByRole("checkbox", { name: "Say which job each resume and document is for" });
    // The name is offered; where someone is applying is theirs to add, and only a resume has a job.
    expect(name).toBeChecked();
    expect(jobs).not.toBeChecked();
    expect(jobs).toBeDisabled();
    expect(jobs).toHaveAccessibleDescription(/Choose a resume or a document first/);
    const fact = within(facts).getAllByRole("checkbox")[0]!;
    await userEvent.click(fact);
    const label = screen.getByRole("textbox", { name: /^Who it’s for/ });
    expect(label).toHaveAttribute("maxlength", "80");
    expect(label).toHaveAccessibleDescription(/The reader doesn’t see it/);
    await userEvent.type(label, "  Dana Okafor ");
    await userEvent.click(name);
    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    expect(await screen.findByLabelText("Your share link")).toHaveValue("https://resumatic.test/share#synthetic-share-new-1");
    const sent = api.callsTo("POST", /^\/api\/shares$/)[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ resumes: [], label: "Dana Okafor", showName: false, showJobs: false });
    expect(sent.factIds).toHaveLength(1);
    // The new link heads the list under its label, not opened yet.
    const row = (await screen.findAllByText("Dana Okafor"))[0]!.closest("li")!;
    expect(row.textContent).toContain("1 fact. Created");
    expect(row.textContent).toContain("Not opened yet.");
  });

  it("offers finished cover letters and interview preparation, and sends the ones chosen", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const group = await screen.findByRole("group", { name: /^Cover letters and interview preparation \(0 selected, up to 20\)/ });
    // Finished letters and preparation only: not gap questions, nor one that failed or is still running.
    expect(within(group).getAllByRole("checkbox")).toHaveLength(2);
    const letter = within(group).getByRole("checkbox", { name: /^Cover letter for Platform Engineer at Litware, / });
    expect(within(group).getByRole("checkbox", { name: /^Interview preparation for Platform Engineer at Litware, / })).toBeEnabled();
    const jobs = screen.getByRole("checkbox", { name: "Say which job each resume and document is for" });
    expect(jobs).toBeDisabled();
    expect(jobs).toHaveAccessibleDescription(/Choose a resume or a document first/);
    const create = screen.getByRole("button", { name: "Create share link" });
    expect(create).toBeDisabled();
    await userEvent.click(letter);
    expect(screen.getByRole("group", { name: /\(1 selected, up to 20\)/ })).toBe(group);
    // A document was written for a job too, so it can say which.
    expect(jobs).toBeEnabled();
    await userEvent.click(jobs);
    await userEvent.click(create);
    await screen.findByLabelText("Your share link");
    expect(api.callsTo("POST", /^\/api\/shares$/)[0]!.body).toMatchObject({
      factIds: [], resumes: [], documents: [{ id: "doc-letter", version: 1 }], showName: true, showJobs: true,
    });
    expect((await screen.findByText("1 document")).closest("li")!.textContent).toContain("Not opened yet.");
  });

  it("won’t offer a document whose sentences can’t be checked again, and says what to do", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    api.unshareable.add("doc-prep");
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const group = await screen.findByRole("group", { name: /^Cover letters and interview preparation/ });
    const preparation = within(group).getByRole("checkbox", { name: /^Interview preparation for Platform Engineer at Litware, / });
    expect(preparation).toBeDisabled();
    expect(preparation.closest("li")!.textContent).toContain("Written before documents could be shared. Write a new one to share it.");
    expect(within(group).getByRole("checkbox", { name: /^Cover letter for/ })).toBeEnabled();
  });

  it("doesn’t offer a fact marked sensitive for sharing, and says that some aren’t listed", async () => {
    const state = fullVault();
    const marked = state.facts.find((fact) => fact.id === "fact-pipeline")!;
    marked.sensitive = true;
    const api = installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const facts = await screen.findByRole("group", { name: /^Confirmed facts/ });
    expect(within(facts).getByText("Facts you’ve marked sensitive aren’t listed.")).toBeInTheDocument();
    expect(within(facts).queryByRole("checkbox", { name: marked.text })).toBeNull();
    // The other confirmed facts are all there to choose, and only they can be sent.
    const offered = within(facts).getAllByRole("checkbox");
    expect(offered).toHaveLength(state.facts.filter((fact) => fact.state === "confirmed" && !fact.sensitive).length);
    for (const box of offered) await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await screen.findByLabelText("Your share link");
    const sent = api.callsTo("POST", /^\/api\/shares$/)[0]!.body as { factIds: string[] };
    expect(sent.factIds).toHaveLength(offered.length);
    expect(sent.factIds).not.toContain(marked.id);
  });

  it("says nothing about sensitive facts in the form when none is marked", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    await screen.findByRole("group", { name: /^Confirmed facts/ });
    expect(screen.queryByText(/marked sensitive/)).toBeNull();
  });

  it("won’t offer a document that uses a fact marked sensitive, and says to create a new one", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    api.usesSensitive.add("doc-letter");
    api.unshareable.add("doc-prep");
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const group = await screen.findByRole("group", { name: /^Cover letters and interview preparation/ });
    const letter = within(group).getByRole("checkbox", { name: /^Cover letter for Platform Engineer at Litware, / });
    expect(letter).toBeDisabled();
    expect(letter.closest("li")!.textContent).toMatch(/\. Uses a fact you’ve marked sensitive\. Create a new one to share it\.$/);
    // Each document gives its own reason: the other was written before documents could be shared.
    const preparation = within(group).getByRole("checkbox", { name: /^Interview preparation for/ });
    expect(preparation.closest("li")!.textContent).toMatch(/\. Written before documents could be shared\. Write a new one to share it\.$/);
    expect(preparation.closest("li")!.textContent).not.toContain("marked sensitive");
  });

  it("says a closed link stays closed while a fact it holds is marked sensitive", async () => {
    const state = fullVault();
    state.shares![0]!.available = false;
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const closed = (await screen.findByText("Dana Okafor")).closest("li")!;
    expect(within(closed).getByRole("status")).toHaveTextContent(
      "This link is currently unavailable. If it includes a resume, review that version before creating a new link. If it holds a fact you’ve marked sensitive, it stays closed while the fact is marked. You can still revoke this one.",
    );
    expect(within(closed).queryByText("Active")).toBeNull();
    expect(within(closed).getByRole("button", { name: "Revoke link" })).toBeEnabled();
  });

  it("has no documents to offer against a server without the list, and says so when the list fails", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    api.fail("GET", /^\/api\/documents$/, 404, "not_found", "no such route");
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const group = await screen.findByRole("group", { name: /^Cover letters and interview preparation/ });
    expect(within(group).getByText("You have no finished cover letters or interview preparation yet.")).toBeInTheDocument();
    // The rest of the form is there to use.
    expect(within(screen.getByRole("group", { name: /^Confirmed facts/ })).getAllByRole("checkbox").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Close selection" }));
    api.fail("GET", /^\/api\/documents$/, 503, "unavailable", "busy");
    await userEvent.click(screen.getByRole("button", { name: "Choose what to share" }));
    expect(await screen.findByText("Resumatic is busy right now. Try again in a minute.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /^Cover letters/ })).toBeNull();
  });

  it("offers the job names once a resume is chosen, and leaves the label out when it’s empty", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const resumes = await screen.findByRole("group", { name: /Saved resume versions/ });
    await userEvent.click(within(resumes).getAllByRole("checkbox")[0]!);
    const jobs = screen.getByRole("checkbox", { name: "Say which job each resume and document is for" });
    await waitFor(() => expect(jobs).toBeEnabled());
    expect(jobs).not.toBeChecked();
    expect(jobs).toHaveAccessibleDescription(/Leave it off to keep where you’re applying to yourself/);
    await userEvent.click(jobs);
    await userEvent.type(screen.getByRole("textbox", { name: /^Who it’s for/ }), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await screen.findByLabelText("Your share link");
    const sent = api.callsTo("POST", /^\/api\/shares$/)[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ factIds: [], showName: true, showJobs: true });
    expect(sent.resumes).toHaveLength(1);
    expect(sent).not.toHaveProperty("label");
  });

  it("names plans as words and connected apps by what they may do", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const plans = await screen.findByRole("combobox", { name: "Choose a plan" });
    expect(within(plans).getByRole("option", { name: "Plus, 60 outputs each billing period" })).toBeInTheDocument();
    const app = (await screen.findByText("Claude")).closest("li")!;
    expect(within(app).getByText("Connected")).toBeInTheDocument();
    expect(within(app).getByText(/Can read your facts and create documents\./)).toBeInTheDocument();
    expect(within(screen.getByText("Old Tool").closest("li")!).getByRole("button", { name: "Remove credentials" })).toBeEnabled();
  });
});

describe("what a connected app may do", () => {
  it("is one sentence for each combination of permissions", () => {
    expect(permissions(["vault:read"])).toBe("Can read your facts.");
    expect(permissions(["vault:read", "offline_access"])).toBe("Can read your facts.");
    expect(permissions(["vault:read", "vault:generate"])).toBe("Can read your facts and create documents.");
    expect(permissions(["vault:read", "vault:jobs"])).toBe("Can read your facts and saved jobs, and add jobs.");
    expect(permissions(["vault:read", "vault:generate", "vault:jobs"])).toBe("Can read your facts and saved jobs, add jobs, check your fit and create documents.");
    // Only an app with both can check fit, so only its sentence says so.
    for (const scopes of [["vault:read"], ["vault:read", "vault:generate"], ["vault:read", "vault:jobs"]]) expect(permissions(scopes)).not.toContain("fit");
  });
});

describe("the shared copy", () => {
  it("shows each fact with its role on a line of its own, and the resume on the sheet", () => {
    render(<ShareSnapshotContent view={sharedView()} />);
    const fact = screen.getByText("Led the migration of 40 services from Heroku to Kubernetes.").closest("li")!;
    expect(within(fact).getByText("Senior Backend Engineer, Northwind Logistics")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(".,");
    expect(document.querySelector(".rs-sheet h1")?.textContent).toBe("Sam Rivera");
    expect(screen.getByText(/A fixed copy, chosen by its owner on 6 Nov 2026\. This link works until 13 Nov 2026\./)).toBeInTheDocument();
  });

  it("says whose copy it is and which job each resume is for, when the copy carries them", () => {
    const view = sharedView();
    view.snapshot.schemaVersion = 2;
    view.snapshot.owner = { name: "Sam Rivera" };
    view.snapshot.resumes[0]!.job = { title: "Platform Engineer", company: "Litware" };
    render(<ShareSnapshotContent view={view} />);
    expect(document.querySelector(".rs-lede")!.textContent).toBe(
      "From Sam Rivera. A fixed copy, chosen on 6 Nov 2026. This link works until 13 Nov 2026.",
    );
    // A reader is told what opening the copy shows its owner, and where the rest is written down.
    const notice = screen.getByText(/^Sam Rivera can see when this copy was last opened, but not who opened it\./);
    // From the site's root: a bare "#/privacy" on this page would be taken for a share link.
    expect(within(notice).getByRole("link", { name: "Privacy notice" })).toHaveAttribute("href", "/#/privacy");
    const resume = screen.getByRole("region", { name: "Sam Rivera, version 2, tailored for Platform Engineer at Litware" });
    expect(within(resume).getByText("Tailored for Platform Engineer at Litware")).toBeInTheDocument();
    expect(within(resume).getByRole("heading", { level: 2, name: "Sam Rivera, version 2" })).toBeInTheDocument();
  });

  it("leaves the name and the job out of a copy that doesn’t carry them", () => {
    const view = sharedView();
    const first = render(<ShareSnapshotContent view={view} />);
    expect(screen.getByText(/^Its owner can see when this copy was last opened, but not who opened it\./)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sam Rivera, version 2" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Tailored for");
    first.unmount();
    // A copy that names nobody and an unnamed job say nothing; half a name says the half there is.
    view.snapshot.schemaVersion = 2;
    view.snapshot.owner = null;
    view.snapshot.resumes[0]!.job = { title: null, company: null };
    const second = render(<ShareSnapshotContent view={view} />);
    expect(document.querySelector(".rs-lede")!.textContent).toMatch(/^A fixed copy, chosen by its owner on /);
    expect(document.body.textContent).not.toContain("Tailored for");
    second.unmount();
    view.snapshot.resumes[0]!.job = { title: null, company: "Litware" };
    render(<ShareSnapshotContent view={view} />);
    expect(screen.getByText("Tailored for Litware")).toBeInTheDocument();
  });

  it("prints a cover letter as its paragraphs and interview preparation as questions with their points", () => {
    const view = sharedView();
    view.snapshot.schemaVersion = 3;
    view.snapshot.owner = null;
    view.snapshot.documents = [
      { id: "doc-letter", version: 1, kind: "letter", paragraphs: ["Led the migration of 40 services from Heroku to Kubernetes.", "Mentored two junior engineers."], questions: [], job: { title: "Platform Engineer", company: "Litware" } },
      {
        id: "doc-prep", version: 1, kind: "prep", paragraphs: [], job: null,
        questions: [
          { question: "How would you discuss your experience relevant to Kubernetes in production?", points: ["Led the migration of 40 services from Heroku to Kubernetes."] },
          { question: "How would you discuss your experience relevant to Terraform?", points: [] },
        ],
      },
    ];
    render(<ShareSnapshotContent view={view} />);
    const letter = screen.getByRole("region", { name: "Cover letter, for Platform Engineer at Litware" });
    expect(within(letter).getByRole("heading", { level: 2, name: "Cover letter" })).toBeInTheDocument();
    expect(within(letter).getByText("For Platform Engineer at Litware")).toBeInTheDocument();
    expect(within(letter).getByText("Every sentence checked against confirmed facts")).toBeInTheDocument();
    expect([...letter.querySelectorAll("article > p")].map((p) => p.textContent)).toEqual([
      "Led the migration of 40 services from Heroku to Kubernetes.",
      "Mentored two junior engineers.",
    ]);
    const preparation = screen.getByRole("region", { name: "Interview preparation" });
    expect(within(preparation).queryByText(/^For /)).toBeNull();
    const questions = within(preparation).getAllByRole("heading", { level: 3 });
    expect(questions.map((heading) => heading.textContent)).toEqual([
      "How would you discuss your experience relevant to Kubernetes in production?",
      "How would you discuss your experience relevant to Terraform?",
    ]);
    expect(within(questions[0]!.parentElement!).getByRole("listitem")).toHaveTextContent("Led the migration of 40 services from Heroku to Kubernetes.");
    // A question the vault has nothing for says so, instead of sitting empty.
    expect(within(questions[1]!.parentElement!).getByText("Nothing prepared for this question.")).toBeInTheDocument();
  });

  it("numbers several documents of a kind, and shows none for a copy without them", () => {
    const view = sharedView();
    const empty = render(<ShareSnapshotContent view={view} />);
    expect(screen.queryByRole("region", { name: /Cover letter|Interview preparation/ })).toBeNull();
    empty.unmount();
    view.snapshot.schemaVersion = 3;
    const letter = (id: string, text: string) => ({ id, version: 1, kind: "letter" as const, paragraphs: [text], questions: [], job: null });
    view.snapshot.documents = [letter("a", "First letter."), { id: "p", version: 1, kind: "prep", paragraphs: [], questions: [{ question: "Why this role?", points: [] }], job: null }, letter("b", "Second letter.")];
    render(<ShareSnapshotContent view={view} />);
    expect(within(screen.getByRole("region", { name: "Cover letter 1" })).getByText("First letter.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Cover letter 2" })).getByText("Second letter.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Interview preparation" })).toBeInTheDocument();
  });

  it("prints education under its own heading, with links and bullets as the PDF has them", () => {
    const view = sharedView();
    const resume = view.snapshot.resumes[0]!;
    resume.sections.push({
      id: "role-waterloo", kind: "education", org: "University of Waterloo", title: "BASc, Computer Engineering",
      startDate: "2014-09", endDate: "2018-04", lines: [{ id: "e1", text: "• Graduated with distinction", verification: "verified" }],
    });
    render(<ShareSnapshotContent view={view} />);
    const sheet = document.querySelector(".rs-sheet")!;
    const headings = [...sheet.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Experience", "Education", "Skills"]);
    const education = [...sheet.querySelectorAll("section")].find((el) => el.querySelector("h2")?.textContent === "Education")!;
    expect(within(education as HTMLElement).getByText("BASc, Computer Engineering, University of Waterloo")).toBeInTheDocument();
    expect(within(education as HTMLElement).getByText("Graduated with distinction")).toBeInTheDocument();
    expect(sheet.querySelector(".rs-sheet__contact")?.textContent).toContain("linkedin.com/in/samrivera");
  });
});
