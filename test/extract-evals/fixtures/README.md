# Synthetic source fixtures

These files are reproducibly generated, synthetic source documents. They are **not** model-conversion recordings and must not be used to claim extractor promotion or conversion quality. Each of the 20 synthetic reference cases has a DOCX and an untagged PDF. Four PDFs use two columns; a separate five-page PDF is an unlabeled stress input. The PDF generator uses standard fonts and explicitly transliterates its text to ASCII; the DOCX preserves the Unicode source text.

The references include several occupations, English, Spanish and German text, some education sections, varied ownership levels, explicit current and ended dates, a seasonal date, multiple instruction traps, and individually labeled skills. A seasonal date can expose a recall limitation in the current verifier; the harness should report that rather than treating its own oracle input as model-quality evidence. These are still short, generated examples rather than a representative or independently labeled corpus; the five-page stress input has no gold labels.

Regenerate with Node 22:

```sh
node --experimental-strip-types test/extract-evals/fixture-files.mjs
```

`manifest.json` records hashes, the source layout, and `conversionStatus: "not-run"`. The existing gold spans index the synthetic reference Markdown, **not** a conversion of these files. To evaluate real conversion, convert each source through the chosen staging service, freeze the actual result separately, and label offsets against that result. Do not place consented real résumés or their converted text in Git. Human entailment audits, representative consented cases and all promotion gates are still required.
