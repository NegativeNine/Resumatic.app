import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignedOut } from "../../src/web/pages/SignedOut";
import { permissions } from "../../src/web/components/ConnectedApps";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { sharedView } from "./fixtures";

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
