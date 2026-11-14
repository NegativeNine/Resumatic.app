import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordProposals } from "../../src/shared/proposal-review";
import type { FactSplit, ConceptTag, Stamp } from "../../src/shared/record";
import { api, ApiError } from "../../src/web/api";
import { RecordProposalReview } from "../../src/web/components/RecordProposalReview";
import { fixtures } from "./fixtures";
import { renderWithSession } from "./render";
const stamp: Stamp = { proposedBy: "model", model: "test/judge", method: "test/1", taxonomyVersion: "test-taxonomy-1", confidence: 0.95, shadow: false };
const line = "Built the API and improved reliability";
const fact = { ...fixtures().facts[0]!, id: "fact-1", text: line, quote: line, revision: 5, span: null };
const split: FactSplit = { ...stamp, id: "split-1", factId: fact.id, state: "proposed", decidedBy: null, decidedAt: null, createdAt: 1,
  parts: [{ id: "part-1", kind: "clause", ranges: [[0,13]], text: "Built the API", resultOf: null }, { id: "part-2", kind: "clause", ranges: [[18,line.length]], text: "improved reliability", resultOf: null }] };
const tag: ConceptTag = { ...stamp, id: "tag-1", subject: { kind: "fact", id: fact.id }, taxonomyVersion: "test-taxonomy-1", conceptId: "onet:tool:python", conceptKind: "tool", label: "Python", relation: "uses", state: "proposed", decidedBy: null, decidedAt: null, createdAt: 1 };
const data = (): RecordProposals => ({ facts: [{ fact, split, rejectedSplits: [], tags: [tag], partTags: [] }], roles: [], offers: [] });
const files = new Map([[fact.sourceId!, "resume.pdf"]]);
afterEach(() => vi.restoreAllMocks());
function open() { return renderWithSession(<RecordProposalReview enabled filenames={files} />, fixtures().me); }
describe("owner review of existing parts and tags", () => {
  it("does not fetch or show anything when disabled", () => {
    const read = vi.spyOn(api, "recordProposals");
    const { container } = renderWithSession(<RecordProposalReview enabled={false} filenames={files} />, fixtures().me);
    expect(container).toBeEmptyDOMElement(); expect(read).not.toHaveBeenCalled();
  });
  it("shows the original line, its source and each part beside the taxonomy label", async () => {
    vi.spyOn(api, "recordProposals").mockResolvedValue(data()); open();
    await screen.findByRole("article", { name: `Suggestions for ${line}` });
    expect(screen.getByText("Built the API")).toBeInTheDocument(); expect(screen.getByText("improved reliability")).toBeInTheDocument();
    expect(screen.getByText("Python")).toBeInTheDocument(); expect(screen.getByText("From resume.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use these parts" })).toBeEnabled();
  });
  it("confirms against the displayed subject revision and decision generation, then refreshes", async () => {
    const first = data(); const next = data(); next.facts[0] = { ...next.facts[0]!, split: { ...split, state: "confirmed", decidedBy: "owner", decidedAt: 10 } };
    const read = vi.spyOn(api, "recordProposals").mockResolvedValueOnce(first).mockResolvedValue(next);
    const decide = vi.spyOn(api, "decideRecordProposal").mockResolvedValue(); open();
    await userEvent.click(await screen.findByRole("button", { name: "Use these parts" }));
    expect(decide).toHaveBeenCalledExactlyOnceWith("split", "split-1", { decision: "confirmed", expectedSubjectRevision: 5, expectedState: "proposed", expectedDecidedAt: null });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Use these parts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep line whole" })).toBeEnabled();
  });
  it("keeps rejected parts readable and explicitly restores them with their current decision generation", async () => {
    const history = data(); history.facts[0] = { ...history.facts[0]!, split: null, rejectedSplits: [{ ...split, state: "rejected", decidedBy: "owner", decidedAt: 10 }], tags: [] };
    const restored = data(); restored.facts[0] = { ...restored.facts[0]!, split: { ...split, state: "confirmed", decidedBy: "owner", decidedAt: 11 }, tags: [] };
    vi.spyOn(api, "recordProposals").mockResolvedValueOnce(data()).mockResolvedValueOnce(history).mockResolvedValue(restored);
    const save = vi.spyOn(api, "decideRecordProposal").mockResolvedValue(); open();
    await userEvent.click(await screen.findByRole("button", { name: "Keep line whole" }));
    const historyToggle = await screen.findByText("Previously rejected parts (1)"); await userEvent.click(historyToggle);
    expect(screen.getByText("Built the API")).toBeInTheDocument();
    expect(screen.getByText("Tags removed when it was rejected stay removed.", { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use these parts again" }));
    expect(save).toHaveBeenLastCalledWith("split", "split-1", { decision: "confirmed", expectedSubjectRevision: 5, expectedState: "rejected", expectedDecidedAt: 10 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Use these parts" })).toBeDisabled());
    expect(screen.queryByText("Previously rejected parts (1)")).not.toBeInTheDocument();
    expect(screen.getByText("From resume.pdf")).toBeInTheDocument();
  });
  it("keeps history available and reports a competing active division instead of replacing it", async () => {
    const current = data(); current.facts[0]!.rejectedSplits = [{ ...split, id: "older-split", state: "rejected", decidedBy: "owner", decidedAt: 10 }];
    vi.spyOn(api, "recordProposals").mockResolvedValue(current);
    vi.spyOn(api, "decideRecordProposal").mockRejectedValue(new ApiError(409, "conflict", "This line has been divided another way since."));
    open(); await userEvent.click(await screen.findByText("Previously rejected parts (1)"));
    await userEvent.click(screen.getByRole("button", { name: "Use these parts again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("divided another way");
    expect(screen.getByRole("button", { name: "Use these parts" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Use these parts again" })).toBeEnabled();
  });
  it("explains that rejecting parts removes their tags before the owner chooses", async () => {
    const tagged = data(); tagged.facts[0]!.partTags = [{ part: split.parts[0]!, tags: [{ ...tag, id: "part-tag", subject: { kind: "part", id: split.parts[0]!.id } }] }];
    vi.spyOn(api, "recordProposals").mockResolvedValue(tagged); open();
    expect(await screen.findByText("Keeping the line whole also removes the tags on these parts. Restoring the parts keeps those tags removed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep line whole" })).toBeEnabled();
  });
  it("rejects a tag without changing the line and keeps a failed save visible", async () => {
    vi.spyOn(api, "recordProposals").mockResolvedValue(data());
    const decide = vi.spyOn(api, "decideRecordProposal").mockRejectedValue(new ApiError(409, "conflict", "This proposal changed. Refresh the page, then review it again."));
    open(); await userEvent.click(await screen.findByRole("button", { name: "Reject tag" }));
    expect(decide).toHaveBeenCalledWith("tag", "tag-1", { decision: "rejected", expectedSubjectRevision: 5, expectedState: "proposed", expectedDecidedAt: null });
    expect(await screen.findByRole("alert")).toHaveTextContent("This proposal changed");
    expect(screen.getByRole("article", { name: `Suggestions for ${line}` })).toHaveTextContent(line);
  });
});
