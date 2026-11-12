import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Read from disk: Vitest doesn't pass CSS through, even with ?raw.
// Vitest runs from the repository root.
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const tokensCss = read("src/web/styles/tokens.css");
const componentsCss = read("src/web/styles/components.css");
const typeCss = read("src/web/styles/type.css");

// The contrast the design system promises for each pair of tokens, checked in both themes, so a
// change to a color can't quietly make text unreadable. WCAG 2.2: 4.5:1 for text, 3:1 for control
// borders, glyphs and marks. The design system holds body text to 5.5:1 on every ground, and the
// focus ring to 11:1, so a ring never reads as a link or a state.

type Palette = Record<string, string>;

const LIGHT = ':root, [data-theme="light"] {';
const DARK = '[data-theme="dark"] {';

function block(selector: string): string {
  const start = tokensCss.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  return tokensCss.slice(start, tokensCss.indexOf("}", start));
}

/** The colors a theme's block sets, with `var(--x)` resolved to the color --x has in the same block. */
function palette(selector: string): Palette {
  const raw: Record<string, string> = Object.fromEntries(
    [...block(selector).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
  const resolveValue = (value: string, seen: Set<string>): string | undefined => {
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    const ref = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
    if (!ref || seen.has(ref) || raw[ref] === undefined) return undefined;
    return resolveValue(raw[ref], new Set([...seen, ref]));
  };
  const colors: Palette = {};
  for (const [name, value] of Object.entries(raw)) {
    const color = resolveValue(value, new Set([name]));
    if (color) colors[name] = color;
  }
  return colors;
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
  return (hi! + 0.05) / (lo! + 0.05);
}

const pairs = (fgs: string[], bgs: string[]) => fgs.flatMap((fg) => bgs.map((bg): [string, string] => [fg, bg]));

const BODY: [string, string][] = pairs(["ink", "ink-muted"], ["paper", "paper-sunken", "desk"]);

const TEXT: [string, string][] = [
  ...pairs(["ink", "ink-muted"], ["paper-hover"]),
  ["on-ink", "ink"],
  ["on-brand", "brand"],
  ["on-brand", "brand-hover"],
  ...pairs(["link"], ["paper", "desk", "paper-sunken", "paper-hover", "backed-soft"]),
  ...pairs(["backed"], ["paper", "backed-soft"]),
  ...pairs(["needs-you"], ["paper", "needs-you-soft"]),
  ...pairs(["ink"], ["needs-you-soft", "backed-soft"]),
  ["on-needs-you", "needs-you-strong"],
  ...pairs(["danger"], ["paper", "desk", "danger-soft"]),
  ["on-danger", "danger"],
  ["sheet-ink", "sheet"],
  ["sheet-ink-muted", "sheet"],
];

const NON_TEXT: [string, string][] = [
  ...pairs(["rule-strong", "needs-you"], ["paper", "paper-sunken", "desk"]),
  ...pairs(["brand"], ["paper", "desk"]),
  ["danger", "paper"],
];

/** The first identity's tokens. None of them may come back. */
const EARLIER = [
  "ink-hover",
  "pencil",
  "ballpoint",
  "ballpoint-soft",
  "highlight",
  "on-highlight",
  "ledger",
  "ledger-soft",
  "violet",
  "violet-soft",
  "font-quote",
];

describe.each([
  ["light", LIGHT],
  ["dark", DARK],
])("the %s theme", (_name, selector) => {
  const colors = palette(selector);

  it.each(BODY)("sets body text %s on %s at 5.5:1 or better", (fg, bg) => {
    expect(colors[fg], fg).toBeDefined();
    expect(colors[bg], bg).toBeDefined();
    expect(contrast(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(5.5);
  });

  it.each(TEXT)("sets %s text on %s at 4.5:1 or better", (fg, bg) => {
    expect(colors[fg], fg).toBeDefined();
    expect(colors[bg], bg).toBeDefined();
    expect(contrast(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT)("draws %s on %s at 3:1 or better", (fg, bg) => {
    expect(colors[fg], fg).toBeDefined();
    expect(colors[bg], bg).toBeDefined();
    expect(contrast(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(3);
  });

  it.each(["paper", "paper-sunken", "desk"])("rings focus at 11:1 or better on %s", (bg) => {
    expect(colors.focus, "focus").toBeDefined();
    expect(contrast(colors.focus!, colors[bg]!)).toBeGreaterThanOrEqual(11);
  });

  it("declares its color scheme, so form controls and scrollbars match", () => {
    expect(block(selector)).toMatch(/color-scheme: (light|dark);/);
  });
});

it("keeps the sheet’s colours the same in both themes, because they are the PDF’s", () => {
  const light = palette(LIGHT);
  const dark = palette(DARK);
  for (const name of ["sheet", "sheet-ink", "sheet-ink-muted", "sheet-rule"]) {
    expect(light[name], name).toBeDefined();
    expect(dark[name], name).toBe(light[name]);
  }
});

it("defines none of the earlier tokens", () => {
  const defined = [...tokensCss.matchAll(/--([\w-]+):/g)].map((m) => m[1]!);
  expect(defined.filter((name) => EARLIER.includes(name))).toEqual([]);
});

/** Every stylesheet under src/web. */
function stylesheets(dir = resolve(root, "src/web")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/**
 * Custom properties a stylesheet may read although no copied file defines them.
 * `--application-columns` is set inline by JobsPage (the board's column count), so it lives in markup.
 */
const ALLOWED_LOCAL = ["--application-columns"];

it("uses only custom properties that tokens.css or components.css define", () => {
  const defined = new Set([...`${tokensCss}\n${componentsCss}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  const offenders = stylesheets().flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/var\(\s*(--[\w-]+)/g)]
      .map((m) => m[1]!)
      .filter((name) => !defined.has(name) && !ALLOWED_LOCAL.includes(name))
      .map((name) => `${relative(root, path)}: ${name}`),
  );
  // Each offender is named with its file, so the failure says what to fix.
  expect([...new Set(offenders)]).toEqual([]);
});

it("the app's own stylesheets use no raw colour", () => {
  const own = [
    "src/web/styles/app.css",
    "src/web/styles/controls.css",
    ...readdirSync(resolve(root, "src/web/components"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `src/web/components/${name}`),
    // Each room's own rules, as styles/README.md puts them.
    ...readdirSync(resolve(root, "src/web/styles/rooms"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `src/web/styles/rooms/${name}`),
  ];
  const offenders = own.flatMap((path) =>
    [...read(path).matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g)].map((m) => `${path}: ${m[0]}`),
  );
  expect(offenders).toEqual([]);
});

it("sets quotes upright in the interface face", () => {
  for (const name of ["quote-lg", "quote", "quote-sm"]) {
    const rule = new RegExp(`^\\.${name} \\{([^}]*)\\}`, "m").exec(typeCss)?.[1];
    expect(rule, name).toBeDefined();
    expect(rule).toContain("font-family: var(--font-sans)");
    expect(rule).not.toMatch(/italic/);
  }
  const quote = /^\.rs-quote blockquote \{([^}]*)\}/m.exec(componentsCss)?.[1];
  expect(quote).toContain("font-family: var(--font-sans)");
  expect(quote).not.toMatch(/italic/);
  expect(tokensCss).toMatch(/--font-sans: "Atkinson Hyperlegible Next"/);
});
