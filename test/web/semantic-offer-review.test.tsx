import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordProposals, SemanticOfferReview } from "../../src/shared/proposal-review";
import { api, ApiError } from "../../src/web/api";
import { RecordProposalReview } from "../../src/web/components/RecordProposalReview";
import { fixtures } from "./fixtures";
import { renderWithSession } from "./render";
const base = fixtures();
const role = { ...base.roles[0]!, revision: 4 };
const offer = (relation: "same" | "fuller" = "same"): SemanticOfferReview => ({
  from: { ...base.facts[0]!, id: "later", roleId: role.id, text: "Implemented the billing API", quote: "Implemented the billing API", sourceId: "later-source", span: null, revision: 2 },
  to: { ...base.facts[0]!, id: "earlier", roleId: role.id, text: "Built the billing API", quote: "Built the billing API", sourceId: "earlier-source", span: null, revision: 3 },
  fromRole: role, toRole: role,
  link: { id: "offer-1", kind: "fact", from: "later", to: "earlier", relation, holds: false, state: "proposed", proposedBy: "model", model: "test/judge", method: "entailment/3", taxonomyVersion: null, confidence: 0.95, shadow: false, createdAt: 1, decidedBy: null, decidedAt: null },
});
const data = (row = offer()): RecordProposals => ({ facts: [], roles: [], offers: [row] });
const files = new Map([["later-source", "later.pdf"], ["earlier-source", "earlier.pdf"]]);
function open() { return renderWithSession(<RecordProposalReview enabled filenames={files} />, base.me); }
afterEach(() => vi.restoreAllMocks());
describe("owner comparison of semantic offers", () => {
  it("shows both original lines, roles and source quotes beside one another", async () => {
    const row = offer(); vi.spyOn(api, "recordProposals").mockResolvedValue(data(row)); open();
    const first = await screen.findByRole("region", { name: "First line" }); const second = screen.getByRole("region", { name: "Second line" });
    expect(within(first).getAllByText(row.from.text)).toHaveLength(2); expect(within(first).getByText("From later.pdf")).toBeInTheDocument();
    expect(within(second).getAllByText(row.to.text)).toHaveLength(2); expect(within(second).getByText("From earlier.pdf")).toBeInTheDocument();
    expect(within(first).getByText(`Role: ${role.title} at ${role.org}`)).toBeInTheDocument();
    expect(within(second).getByText(`Role: ${role.title} at ${role.org}`)).toBeInTheDocument();
    expect(screen.getByText(/the second line stand for both/)).toBeInTheDocument();
  });
  it("sends both fact and role revisions and link generation only after an explicit confirmation", async () => {
    const row = offer(); const decided = { ...row, link: { ...row.link, state: "confirmed" as const, decidedBy: "owner" as const, decidedAt: 10 } };
    vi.spyOn(api, "recordProposals").mockResolvedValueOnce(data(row)).mockResolvedValue(data(decided));
    const save = vi.spyOn(api, "decideSemanticOffer").mockResolvedValue(); open();
    expect(save).not.toHaveBeenCalled(); await userEvent.click(await screen.findByRole("button", { name: "Treat as one fact" }));
    expect(save).toHaveBeenCalledExactlyOnceWith("offer-1", { decision: "confirmed", expectedFromRevision: 2, expectedToRevision: 3,
      expectedFromRoleRevision: 4, expectedToRoleRevision: 4, expectedState: "proposed", expectedDecidedAt: null });
    await screen.findByRole("button", { name: "Undo this merge" });
    await userEvent.click(screen.getByRole("button", { name: "Undo this merge" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith("offer-1", expect.objectContaining({ decision: "rejected", expectedState: "confirmed", expectedDecidedAt: 10 })));
  });
  it("explains that a fuller link keeps both facts and never automatically selects stronger wording", async () => {
    vi.spyOn(api, "recordProposals").mockResolvedValue(data(offer("fuller"))); const save = vi.spyOn(api, "decideSemanticOffer").mockResolvedValue(); open();
    expect(await screen.findByText(/Both facts stay separate, and neither is automatically chosen/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole("button", { name: "Link as fuller version" }));
    expect(save).toHaveBeenCalledWith("offer-1", expect.objectContaining({ decision: "confirmed" }));
    expect(screen.getByRole("region", { name: "First line" })).toHaveTextContent("Implemented the billing API");
    expect(screen.getByRole("region", { name: "Second line" })).toHaveTextContent("Built the billing API");
  });
  it("retains the comparison and reports a stale decision without assuming it saved", async () => {
    vi.spyOn(api, "recordProposals").mockResolvedValue(data());
    vi.spyOn(api, "decideSemanticOffer").mockRejectedValue(new ApiError(409, "conflict", "This offer or its facts changed. Refresh the page, then review it again."));
    open(); await userEvent.click(await screen.findByRole("button", { name: "Reject link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This offer or its facts changed");
    expect(screen.getByRole("button", { name: "Treat as one fact" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "First line" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Second line" })).toBeInTheDocument();
  });
});
