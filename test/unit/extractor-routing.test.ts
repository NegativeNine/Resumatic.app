import { describe, expect, it } from "vitest";
import {
  experimentBucket,
  extractorFor,
  sourceFormat,
} from "../../src/pipeline/extract";

describe("extractor format routing", () => {
  it("classifies supported uploads case-insensitively and keeps OCR distinct", () => {
    expect(sourceFormat("upload", "RESUME.PDF")).toBe("pdf");
    expect(sourceFormat(undefined, "Resume.DocX")).toBe("docx");
    expect(sourceFormat("upload", "LinkedIn.ZIP")).toBe("linkedin");
    expect(sourceFormat("ocr", "derived.pdf")).toBe("ocr");
    expect(sourceFormat("upload", "resume.txt")).toBeUndefined();
    expect(sourceFormat("other" as never, "resume.pdf")).toBeUndefined();
  });

  it("gives pasted text no format, so it uses EXTRACTOR", () => {
    expect(sourceFormat("paste", "cv.pdf.txt")).toBeUndefined();
    expect(sourceFormat("paste", "export.zip")).toBeUndefined();
    const routes = '{"pdf":"clairic","docx":"clairic","linkedin":"clairic","ocr":"clairic"}';
    expect(extractorFor({ EXTRACTOR: "llm:default", EXTRACTOR_BY_FORMAT: routes }, "vault", sourceFormat("paste", "cv.pdf.txt")).id).toBe("llm:default");
  });

  it("keeps the existing default and explicit global fallback when routing is absent", () => {
    expect(extractorFor({}, "vault", "pdf").id).toBe("llm:default");
    expect(extractorFor({ EXTRACTOR: "clairic" }, "vault", "docx").id).toBe(
      "clairic",
    );
    expect(
      extractorFor({ EXTRACTOR_BY_FORMAT: '{"pdf":"clairic"}' }, "vault").id,
    ).toBe("llm:default");
  });

  it("selects each configured format and falls back for unconfigured formats", () => {
    const env = {
      EXTRACTOR: "llm:default",
      EXTRACTOR_BY_FORMAT: JSON.stringify({
        pdf: "clairic",
        docx: "segment:@cf/openai/gpt-oss-20b",
        linkedin: "judge:llm:default",
        ocr: "llm:@cf/openai/gpt-oss-120b",
      }),
    };
    expect(extractorFor(env, "vault", "pdf").id).toBe("clairic");
    expect(extractorFor(env, "vault", "docx").id).toBe(
      "segment:@cf/openai/gpt-oss-20b",
    );
    expect(extractorFor(env, "vault", "linkedin").id).toBe("judge:llm:default");
    expect(extractorFor(env, "vault", "ocr").id).toBe(
      "llm:@cf/openai/gpt-oss-120b",
    );
    expect(
      extractorFor(
        { EXTRACTOR: "clairic", EXTRACTOR_BY_FORMAT: '{"pdf":"llm:default"}' },
        "vault",
        "docx",
      ).id,
    ).toBe("clairic");
  });

  it("assigns the same challenger cohort across formats, with format-specific controls", () => {
    const route = {
      EXTRACTOR_BY_FORMAT: '{"pdf":"clairic","docx":"llm:default"}',
    };
    expect(
      extractorFor(
        {
          ...route,
          EXTRACTOR_EXPERIMENT: '{"strategy":"judge:clairic","percent":0}',
        },
        "vault",
        "pdf",
      ).id,
    ).toBe("clairic");
    expect(
      extractorFor(
        {
          ...route,
          EXTRACTOR_EXPERIMENT: '{"strategy":"judge:clairic","percent":100}',
        },
        "vault",
        "docx",
      ).id,
    ).toBe("judge:clairic");
    for (const id of ["one", "two", "three", "four"]) {
      const e = {
        ...route,
        EXTRACTOR_EXPERIMENT: '{"strategy":"judge:clairic","percent":50}',
      };
      const expectedChallenger = experimentBucket(id) < 5000;
      expect(extractorFor(e, id, "pdf").id === "judge:clairic").toBe(
        expectedChallenger,
      );
      expect(extractorFor(e, id, "docx").id === "judge:clairic").toBe(
        expectedChallenger,
      );
    }
  });

  it.each([
    "not json",
    "null",
    "[]",
    '"pdf"',
    '{"rtf":"clairic"}',
    '{"pdf":null}',
    '{"pdf":"unknown"}',
    '{"pdf":"clairic","docx":"unknown"}',
    '{"__proto__":"clairic"}',
    '{"pdf":"__proto__"}',
    '{"pdf":"constructor"}',
  ])("fails closed for invalid format routing %s", (json) => {
    expect(() =>
      extractorFor({ EXTRACTOR_BY_FORMAT: json }, "vault", "pdf"),
    ).toThrow("extractor_format_routes_invalid");
  });

  it("rejects an unrecognized runtime format and still validates global/experiment configuration", () => {
    expect(() => extractorFor({}, "vault", "unknown" as never)).toThrow(
      "extractor_format_invalid",
    );
    expect(() =>
      extractorFor(
        { EXTRACTOR: "unknown", EXTRACTOR_BY_FORMAT: '{"pdf":"clairic"}' },
        "vault",
        "pdf",
      ),
    ).toThrow("extractor_unknown");
    expect(() =>
      extractorFor(
        {
          EXTRACTOR_BY_FORMAT: '{"pdf":"clairic"}',
          EXTRACTOR_EXPERIMENT: '{"strategy":"unknown","percent":100}',
        },
        "vault",
        "pdf",
      ),
    ).toThrow("extractor_unknown");
  });
});
