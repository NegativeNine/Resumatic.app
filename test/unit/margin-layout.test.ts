import { describe, expect, it } from "vitest";
import { marginOrder, placeNotes, type MarginItem } from "../../src/web/components/margin-order";

// The margin beside a resume's page: each mark level with its line, and the one open card placed
// as one more item after its line's mark, so the marks below move down to clear it and nothing
// overlaps or hides a mark.

const markFor = (line: string): MarginItem & { name: string } => ({ name: `mark:${line}`, dataset: { noteFor: line } });
const cardFor = (line: string): MarginItem & { name: string } => ({ name: `card:${line}`, dataset: { cardFor: line } });

describe("placeNotes", () => {
  it("keeps each note level with its line when there’s room", () => {
    expect(placeNotes([0, 100, 200], [40, 40, 40], 8)).toEqual([0, 100, 200]);
    expect(placeNotes([0, 100], [40, 40])).toEqual([0, 100]);
  });

  it("pushes a note down only as far as it must go to clear the one above", () => {
    expect(placeNotes([0, 20, 200], [40, 40, 40], 8)).toEqual([0, 48, 200]);
    expect(placeNotes([0, 10, 20], [30, 30, 30], 10)).toEqual([0, 40, 80]);
  });

  it("placeNotes pushes later marks below the card", () => {
    // Marks for lines at 0, 30 and 60; the card for the first line, level with it and 200 tall.
    const order = marginOrder([markFor("a"), markFor("b"), markFor("c")], cardFor("a"));
    const tops = { "mark:a": 0, "card:a": 0, "mark:b": 30, "mark:c": 60 } as Record<string, number>;
    const heights = { "mark:a": 24, "card:a": 200, "mark:b": 24, "mark:c": 24 } as Record<string, number>;
    const placed = placeNotes(order.map((item) => tops[item.name]!), order.map((item) => heights[item.name]!), 6);
    expect(Object.fromEntries(order.map((item, i) => [item.name, placed[i]]))).toEqual({ "mark:a": 0, "card:a": 30, "mark:b": 236, "mark:c": 266 });
    // Nothing overlaps: each item starts below the one before it ends.
    for (let i = 1; i < order.length; i++) expect(placed[i]!).toBeGreaterThanOrEqual(placed[i - 1]! + heights[order[i - 1]!.name]!);
    // Closed, the marks return level with their lines.
    expect(placeNotes([0, 30, 60], [24, 24, 24], 6)).toEqual([0, 30, 60]);
  });
});

describe("marginOrder", () => {
  it("marginOrder puts the card after its line’s mark", () => {
    const marks = [markFor("a"), markFor("b"), markFor("c")];
    expect(marginOrder(marks, cardFor("b")).map((item) => item.name)).toEqual(["mark:a", "mark:b", "card:b", "mark:c"]);
    expect(marginOrder(marks, cardFor("c")).map((item) => item.name)).toEqual(["mark:a", "mark:b", "mark:c", "card:c"]);
    // No card, or a card whose line has no mark: the marks alone, in their order.
    expect(marginOrder(marks, null).map((item) => item.name)).toEqual(["mark:a", "mark:b", "mark:c"]);
    expect(marginOrder(marks, cardFor("gone")).map((item) => item.name)).toEqual(["mark:a", "mark:b", "mark:c"]);
    // The marks given are not changed.
    expect(marks.map((item) => item.name)).toEqual(["mark:a", "mark:b", "mark:c"]);
  });
});
