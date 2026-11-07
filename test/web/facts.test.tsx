import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SourcesPage } from "../../src/web/pages/SourcesPage";
import { installFakeApi, type FakeApi } from "./api-fake";
import { emptyVault, fixtures, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

async function openFacts(state: Fixtures = fixtures()): Promise<FakeApi> {
  const api = installFakeApi(state);
  renderWithSession(<SourcesPage />, state.me);
  await screen.findByRole("heading", { name: "Northwind Logistics" });
  return api;
}

const reviewCalls = (api: FakeApi) => api.callsTo("POST", /^\/api\/review$/).map((c) => c.body);
const factItem = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-queue-item]")!;

describe("the Facts page", () => {
  it("puts the sources in a rail beside the review queue", async () => {
    await openFacts();
    const rail = screen.getByRole("complementary", { name: "Your sources" });
    expect(within(rail).getByText("sam-rivera-2024.pdf")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review roles and facts" })).toBeInTheDocument();
  });

  it("orders the review buttons as the copy does: Confirm, Edit, Reject", async () => {
    await openFacts();
    const fact = factItem("Led the migration of 40 services from Heroku to Kubernetes.");
    expect(within(fact).getAllByRole("button").map((b) => b.textContent)).toEqual(["Confirm", "Edit", "Reject"]);
  });

  it("joins meta with space and rules, never middle dots", async () => {
    await openFacts();
    for (const meta of document.querySelectorAll(".rs-fact__meta, .rs-role__detail, .rs-source__meta")) {
      expect(meta.textContent).not.toContain("·");
    }
    expect(screen.getByText("Senior Backend Engineer").tagName).toBe("SPAN");
  });

  it("opens on one big dropzone before the first upload", async () => {
    const state = emptyVault();
    installFakeApi(state);
    renderWithSession(<SourcesPage />, state.me);
    expect(await screen.findByRole("heading", { name: "What happens next" })).toBeInTheDocument();
    expect(document.querySelector(".app-drop--first-run")).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "Your sources" })).toBeNull();
  });
});

describe("the keyboard queue", () => {
  it("moves between items with J and K", async () => {
    await openFacts();
    const role = screen.getByRole("heading", { name: "Northwind Logistics" }).closest<HTMLElement>("[data-queue-item]")!;
    role.focus();
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(factItem("Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis."));
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(factItem("Led the migration of 40 services from Heroku to Kubernetes."));
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(factItem("Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis."));
    expect(document.activeElement).toHaveClass("is-active");
  });

  it("confirms the active fact with C", async () => {
    const api = await openFacts();
    factItem("Led the migration of 40 services from Heroku to Kubernetes.").focus();
    await userEvent.keyboard("c");
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: ["fact-migration"], reject: [] });
    await waitFor(() => expect(screen.queryByText("Led the migration of 40 services from Heroku to Kubernetes.")).toBeNull());
  });

  it("edits with E, and Escape cancels the edit and returns focus to the fact", async () => {
    await openFacts();
    const fact = factItem("Mentored four engineers through their first on-call rotations.");
    fact.focus();
    await userEvent.keyboard("e");
    // ByLabelText rather than ByRole: computing every accessible name is slow on a page this size.
    const editor = await screen.findByLabelText("Fact", { selector: "textarea" }, { timeout: 4000 });
    expect(editor).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Fact", { selector: "textarea" })).toBeNull();
    expect(document.activeElement).toBe(factItem("Mentored four engineers through their first on-call rotations."));
  });

  it("asks before R rejects a role with proposed facts under it", async () => {
    const api = await openFacts();
    const role = screen.getByRole("heading", { name: "Northwind Logistics" }).closest<HTMLElement>("[data-queue-item]")!;
    role.focus();
    await userEvent.keyboard("r");
    const well = screen.getByRole("group", { name: "Reject Northwind Logistics" });
    expect(well).toHaveTextContent("Reject Northwind Logistics and its 3 proposed facts? Rejected items are kept here and never used.");
    expect(reviewCalls(api)).toHaveLength(0);
    const yes = within(well).getByRole("button", { name: "Yes, reject 4" });
    expect(yes).toHaveFocus();
    await userEvent.click(yes);
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: [], reject: ["role-northwind"] });
  });

  it("returns focus to Reject role when the question is cancelled", async () => {
    await openFacts();
    await userEvent.click(screen.getByRole("button", { name: "Reject role" }));
    expect(screen.getByRole("button", { name: "Reject role" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Reject Northwind Logistics" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject role" })).toHaveFocus();
  });

  it("leaves keys alone while someone types, or holds a modifier", async () => {
    const api = await openFacts();
    await userEvent.click(screen.getByRole("button", { name: "Add a fact yourself" }));
    const text = screen.getByLabelText("Fact", { selector: "textarea" });
    await userEvent.type(text, "crjk");
    expect(text).toHaveValue("crjk");
    factItem("Led the migration of 40 services from Heroku to Kubernetes.").focus();
    await userEvent.keyboard("{Control>}c{/Control}{Meta>}r{/Meta}");
    expect(reviewCalls(api)).toHaveLength(0);
  });

  it("names each button's key for assistive technology", async () => {
    await openFacts();
    const fact = factItem("Led the migration of 40 services from Heroku to Kubernetes.");
    expect(within(fact).getByRole("button", { name: "Confirm" })).toHaveAttribute("aria-keyshortcuts", "C");
    expect(within(fact).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-keyshortcuts", "E");
    expect(within(fact).getByRole("button", { name: "Reject" })).toHaveAttribute("aria-keyshortcuts", "R");
  });
});
