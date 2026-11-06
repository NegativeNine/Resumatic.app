import { describe, expect, it } from "vitest";
import { conversionQuality } from "../../src/pipeline/extract/quality";

describe("conversion quality page evidence", () => {
  it("does not invent a page count when the converter does not supply one", () => {
    const result = conversionQuality("x".repeat(350));
    expect(result.pageCount).toBeNull();
    expect(result.reasons).not.toContain("little-text");
    expect(conversionQuality("short").reasons).toContain("little-text");
  });
  it("uses a trusted image count and rejects invalid counts as unknown", () => {
    expect(conversionQuality("x".repeat(350), 2)).toMatchObject({
      pageCount: 2,
      reasons: ["little-text"],
    });
    expect(conversionQuality("x".repeat(350), 1)).toMatchObject({
      pageCount: 1,
      reasons: [],
    });
    for (const invalid of [0, -1, 1.5, NaN, Infinity])
      expect(conversionQuality("x".repeat(350), invalid).pageCount).toBeNull();
  });
});
