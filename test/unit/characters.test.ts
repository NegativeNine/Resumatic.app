import { describe, expect, it } from "vitest";
import { withoutHiddenControls } from "../../src/shared/characters";

/** The ranges the posting reader removed before the helper was shared, written out again here. */
const POSTING_SET: [number, number][] = [
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x009f],
  [0x200b, 0x200d], [0x2060, 0x2060], [0xfeff, 0xfeff],
  [0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069],
];

describe("hidden characters", () => {
  it("withoutHiddenControls removes exactly the posting reader's set", () => {
    const expected = new Set(POSTING_SET.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i)));
    const removed: number[] = [];
    for (let point = 0; point <= 0xffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      if (withoutHiddenControls(`a${String.fromCharCode(point)}b`) === "ab") removed.push(point);
    }
    expect(removed).toEqual([...expected].sort((a, b) => a - b));
    // Tab and newline are text; so are a soft hyphen and the characters a paste also loses.
    const softHyphen = String.fromCharCode(0xad);
    expect(withoutHiddenControls(`a\tb\nc${softHyphen}`)).toBe(`a\tb\nc${softHyphen}`);
    expect(withoutHiddenControls(`x${String.fromCodePoint(0xe0041)}y`)).toBe(`x${String.fromCodePoint(0xe0041)}y`);
  });
});
