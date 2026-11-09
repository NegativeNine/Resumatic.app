import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Read from disk: Vitest doesn't pass CSS through, even with ?raw.
// Vitest runs from the repository root.
const tokensCss = readFileSync(resolve(process.cwd(), "src/web/styles/tokens.css"), "utf8");

// The contrast the design system promises for each pair of tokens, checked in both themes, so a
// change to a color can't quietly make text unreadable. WCAG 2.2: 4.5:1 for text, 3:1 for control
// borders, glyphs and the focus ring.

type Palette = Record<string, string>;

function palette(selector: string): Palette {
  const start = tokensCss.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  const block = tokensCss.slice(start, tokensCss.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT: [string, string][] = [
  ...["ink", "ink-muted"].flatMap((fg) => ["paper", "paper-sunken", "paper-hover", "desk"].map((bg): [string, string] => [fg, bg])),
  ["on-ink", "ink"],
  ["on-ink", "ink-hover"],
  ["ballpoint", "paper"],
  ["ballpoint", "desk"],
  ["ballpoint", "ballpoint-soft"],
  ["ink", "ballpoint-soft"],
  ["on-highlight", "highlight"],
  ["danger", "paper"],
  ["danger", "danger-soft"],
  ["on-danger", "danger"],
  ["ledger", "paper"],
  ["ledger", "ledger-soft"],
  ["violet", "violet-soft"],
  ["sheet-ink", "sheet"],
  ["sheet-ink-muted", "sheet"],
];

const NON_TEXT: [string, string][] = [
  ["ballpoint", "paper"],
  ["ballpoint", "desk"],
  ["rule-strong", "paper"],
  ["rule-strong", "desk"],
  ["pencil", "paper"],
  ["pencil", "paper-sunken"],
];

describe.each([
  ["light", ':root, [data-theme="light"] {'],
  ["dark", '[data-theme="dark"] {'],
])("the %s theme", (_name, selector) => {
  const colors = palette(selector);

  it.each(TEXT)("sets %s text on %s at 4.5:1 or better", (fg, bg) => {
    expect(colors[fg], fg).toBeDefined();
    expect(colors[bg], bg).toBeDefined();
    expect(contrast(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT)("draws %s marks on %s at 3:1 or better", (fg, bg) => {
    expect(contrast(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(3);
  });

  it("declares its color scheme, so form controls and scrollbars match", () => {
    const start = tokensCss.indexOf(selector);
    expect(tokensCss.slice(start, tokensCss.indexOf("}", start))).toMatch(/color-scheme: (light|dark);/);
  });
});

it("keeps the resume sheet’s colors the same in both themes, because they are the PDF’s", () => {
  const light = palette(':root, [data-theme="light"] {');
  const dark = palette('[data-theme="dark"] {');
  for (const name of ["sheet", "sheet-ink", "sheet-ink-muted", "sheet-rule"]) expect(dark[name], name).toBe(light[name]);
});
