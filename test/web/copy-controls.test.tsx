import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopyLinkView } from "../../src/shared/api";
import { api } from "../../src/web/api";
import { CopyControls, GroupIdenticalCopies } from "../../src/web/components/CopyControls";
import { renderWithSession } from "./render";
import { fixtures } from "./fixtures";
const link: CopyLinkView = { id: "link-1", from: "later", to: "first", fromRevision: 2, toRevision: 3, decisionVersion: 123 };
const files = new Map([["source-1", "first.pdf"], ["source-2", "second.pdf"]]);
const first = { id: "first", sourceId: "source-1", copyReview: { rootId: "first", links: [link], separations: [] } };
const later = { id: "later", sourceId: "source-2", copyReview: { rootId: "first", links: [link], separations: [] } };
afterEach(() => vi.restoreAllMocks());
describe("identical-copy controls", () => {
  it("groups only after the owner asks and refreshes the view", async () => {
    const group = vi.spyOn(api, "groupIdenticalCopies").mockResolvedValue();
    const reload = vi.fn().mockResolvedValue(undefined);
    renderWithSession(<GroupIdenticalCopies enabled reload={reload} />, fixtures().me);
    expect(group).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Group identical copies" }));
    expect(group).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
  it("separates a named copy once, carrying revisions, and reloads the review", async () => {
    const decide = vi.spyOn(api, "decideIdenticalCopy").mockResolvedValue();
    const reload = vi.fn().mockResolvedValue(undefined);
    renderWithSession(<CopyControls items={[first, later]} filenames={files} reload={reload} />, fixtures().me);
    const button = screen.getByRole("button", { name: "Keep the copy from second.pdf separate" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(button);
    expect(decide).toHaveBeenCalledExactlyOnceWith(link, "rejected");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
  it("offers an explicit way to show separated copies together again", async () => {
    const decide = vi.spyOn(api, "decideIdenticalCopy").mockResolvedValue();
    renderWithSession(<CopyControls items={[{ ...later, copyReview: { rootId: "later", links: [], separations: [link] } }]} filenames={files} reload={async () => {}} />, fixtures().me);
    await userEvent.click(screen.getByRole("button", { name: "Show these identical copies together again" }));
    expect(decide).toHaveBeenCalledExactlyOnceWith(link, "confirmed");
  });
  it("keeps errors visible and leaves the displayed copies alone when saving fails", async () => {
    vi.spyOn(api, "decideIdenticalCopy").mockRejectedValue(new Error("These copies changed. Refresh the page, then try again."));
    const reload = vi.fn();
    renderWithSession(<CopyControls items={[first, later]} filenames={files} reload={reload} />, fixtures().me);
    await userEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert");
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
  });
  it("shows no controls for old responses or shadow findings", () => {
    const { container } = renderWithSession(<CopyControls items={[{ id: "first", sourceId: "source-1" }]} filenames={files} reload={async () => {}} />, fixtures().me);
    expect(container).toBeEmptyDOMElement();
  });
});
