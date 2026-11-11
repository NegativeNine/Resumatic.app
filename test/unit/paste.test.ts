import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_CHARS } from "../../src/pipeline/extract/types";
import {
  MAX_PASTE_BYTES,
  MAX_PASTE_CHARS,
  PASTE_FILENAME,
  cleanPasteTitle,
  hasLoneSurrogate,
  normalizePastedText,
  pasteFilename,
  readPastedText,
} from "../../src/shared/paste";

// Characters are written by code point: most of these are invisible in source.
const ch = (...points: number[]) => String.fromCodePoint(...points);
const hex = (point: number) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
const bytes = (text: string) => new TextEncoder().encode(text).slice().buffer;

describe("pasted text", () => {
  it("counts 60,000 characters, the extractor's own limit", () => {
    expect(MAX_PASTE_CHARS).toBe(MAX_MARKDOWN_CHARS);
    expect(MAX_PASTE_CHARS).toBe(60_000);
    expect(MAX_PASTE_BYTES).toBe(180_000);
  });

  it("makes every line ending a newline", () => {
    expect(normalizePastedText(`one\r\ntwo\rthree${ch(0x85)}four${ch(0x2028)}five${ch(0x2029)}six\nseven`)).toBe(
      "one\ntwo\nthreefour\nfive\nsix\nseven",
    );
    // A Windows line ending is one newline, not two.
    expect(normalizePastedText("a\r\n\r\nb")).toBe("a\n\nb");
  });

  it.each([0x0000, 0x0008, 0x000b, 0x007f, 0x0085, 0x200b, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c])(
    "removes NUL, controls, zero-width characters and every mark of direction, and keeps tabs and newlines (%s)",
    (point) => {
      expect(normalizePastedText(`Led${ch(point)} the\tlaunch\n${ch(point)}of rates`), hex(point)).toBe("Led the\tlaunch\nof rates");
    },
  );

  it.each([0x00ad, 0x180e, 0x2061, 0x2064, 0x206a, 0x206f, 0xfe0f, 0x3164, 0xe0041, 0xe007f])(
    "removes characters Unicode marks as not shown (%s)",
    (point) => {
      expect(normalizePastedText(`Kuber${ch(point)}netes`), hex(point)).toBe("Kubernetes");
    },
  );

  it("keeps right-to-left writing and accented letters", () => {
    const text = "Hebrew: שלום; Arabic: مرحبا; café — naïve; 日本語; emoji 🚀";
    expect(normalizePastedText(text)).toBe(text);
  });

  it("keeps whitespace inside the text as pasted, and trims only its ends", () => {
    expect(normalizePastedText("  \n  Led  the   launch\n\n\n\t- Mentored  \n ")).toBe("Led  the   launch\n\n\n\t- Mentored");
  });

  it("finds a lone surrogate and not a pair", () => {
    expect(hasLoneSurrogate("🚀 launched")).toBe(false);
    expect(hasLoneSurrogate("plain")).toBe(false);
    expect(hasLoneSurrogate(`a${String.fromCharCode(0xd83d)}b`)).toBe(true);
    expect(hasLoneSurrogate(`a${String.fromCharCode(0xde80)}b`)).toBe(true);
    expect(hasLoneSurrogate(String.fromCharCode(0xd83d))).toBe(true);
    expect(hasLoneSurrogate(String.fromCharCode(0xde80, 0xd83d))).toBe(true);
  });

  it("names a source from its title", () => {
    expect(pasteFilename("Q3 review")).toBe("Q3 review.txt");
    expect(pasteFilename("notes.TXT")).toBe("notes.txt");
    expect(pasteFilename("a.txt.txt")).toBe("a.txt.txt");
    for (const empty of ["", null, undefined, "   ", ch(0x200b, 0x00ad), ".txt", " .TXT "])
      expect(pasteFilename(empty), JSON.stringify(empty)).toBe(PASTE_FILENAME);
    expect(pasteFilename("a\n\tb")).toBe("a b.txt");
    expect(pasteFilename(`  Q3${ch(0x202e)}  review${ch(0xe0041)} `)).toBe("Q3 review.txt");
    expect(cleanPasteTitle(`one\r\ntwo${ch(0x2028)}three`)).toBe("one two three");
    expect(pasteFilename("x".repeat(120))).toBe(`${"x".repeat(120)}.txt`);
    expect(pasteFilename(`${"x".repeat(116)}.txt`)).toBe(`${"x".repeat(116)}.txt`);
    // The limit is on the title once cleaned: hidden characters don't count.
    expect(pasteFilename(`${"x".repeat(120)}${ch(0x200b)}`)).toBe(`${"x".repeat(120)}.txt`);
    expect(pasteFilename("x".repeat(121))).toBeNull();
  });

  it("reads stored text back only if it is valid UTF-8, has no BOM and is already clean", () => {
    expect(readPastedText(bytes("Led the launch.\n\tMentored two."))).toBe("Led the launch.\n\tMentored two.");
    expect(readPastedText(bytes("Hebrew: שלום 🚀"))).toBe("Hebrew: שלום 🚀");
    // Not UTF-8.
    expect(readPastedText(new Uint8Array([0x4c, 0xff, 0x65]).buffer)).toBeNull();
    expect(readPastedText(new Uint8Array([0xed, 0xa0, 0x80]).buffer)).toBeNull();
    // A byte-order mark is kept by the reader, then refused as not clean.
    expect(readPastedText(new Uint8Array([0xef, 0xbb, 0xbf, 0x4c]).buffer)).toBeNull();
    // Not as the Worker stores it.
    expect(readPastedText(bytes("a\r\nb"))).toBeNull();
    expect(readPastedText(bytes(` padded `))).toBeNull();
    expect(readPastedText(bytes(`a${ch(0x200b)}b`))).toBeNull();
    expect(readPastedText(bytes(`a${ch(0)}b`))).toBeNull();
    // Empty, or longer than a paste may be.
    expect(readPastedText(new ArrayBuffer(0))).toBeNull();
    expect(readPastedText(bytes("a".repeat(MAX_PASTE_CHARS)))).toHaveLength(MAX_PASTE_CHARS);
    expect(readPastedText(bytes("a".repeat(MAX_PASTE_CHARS + 1)))).toBeNull();
  });
});
