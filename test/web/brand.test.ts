import { render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { expect, it } from "vitest";
import { Lockup } from "../../src/web/components/Lockup";

// The plain identity's face, icon and lockup. Read from disk: Vitest doesn't pass CSS through.
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

it("loads only Atkinson Hyperlegible Next, from the app's own files, with its licence beside it", () => {
  const fonts = read("src/web/styles/fonts.css");
  const faces = [...fonts.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  expect(faces).toHaveLength(2);
  const sources = faces.map((face) => {
    expect(face).toMatch(/font-family: "Atkinson Hyperlegible Next";/);
    expect(face).toMatch(/font-style: normal;/);
    expect(face).toMatch(/font-weight: 200 800;/);
    expect(face).toMatch(/font-display: swap;/);
    expect(face).toMatch(/unicode-range: U\+/);
    return /src: url\("([^"]+)"\) format\("woff2"\);/.exec(face)?.[1];
  });
  // Relative to the stylesheet, so Vite fingerprints the files and they load under font-src 'self'.
  expect(sources).toEqual([
    "../fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2",
    "../fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2",
  ]);
  expect(fonts).not.toMatch(/https?:|italic/);

  const files = readdirSync(resolve(root, "src/web/fonts")).sort();
  expect(files).toEqual([
    "OFL-AtkinsonHyperlegibleNext.txt",
    "README.md",
    "atkinson-hyperlegible-next-latin-ext-wght-normal.woff2",
    "atkinson-hyperlegible-next-latin-wght-normal.woff2",
  ]);
  expect(read("src/web/fonts/OFL-AtkinsonHyperlegibleNext.txt")).toContain("SIL Open Font License, Version 1.1");

  // No stylesheet names another face: the sheet keeps --font-paper, which loads nothing.
  const tokens = read("src/web/styles/tokens.css");
  expect(tokens).toMatch(/--font-sans: "Atkinson Hyperlegible Next", /);
  expect(tokens).toMatch(/--font-paper: "Helvetica Neue", Helvetica, Arial, sans-serif;/);
  for (const path of ["src/web/styles/app.css", "src/web/styles/controls.css", "src/web/styles/components.css"]) {
    expect(read(path), path).not.toMatch(/Schibsted|Newsreader|font-quote/);
  }
});

it("draws the app icon as the tile at full bleed with the on-brand check", () => {
  const icon = read("public/favicon.svg");
  const light = /:root, \[data-theme="light"\] \{([^}]*)\}/.exec(read("src/web/styles/tokens.css"))?.[1] ?? "";
  const brand = /--brand: (#[0-9a-f]{6});/.exec(light)?.[1];
  const onBrand = /--on-brand: (#[0-9a-f]{6});/.exec(light)?.[1];
  expect(brand).toBeDefined();
  expect(onBrand).toBeDefined();

  expect(icon).toMatch(/viewBox="0 0 24 24"/);
  expect(icon).toMatch(/<title>Resumatic<\/title>/);
  // Full bleed: the tile covers the whole box.
  expect(icon).toMatch(new RegExp(`<rect width="24" height="24" rx="[\\d.]+" fill="${brand}"/>`));
  expect(icon).toMatch(new RegExp(`stroke="${onBrand}"`));

  // The check is the same path the lockup's tile masks with.
  const mask = decodeURIComponent(/--rs-mark-check: url\("data:image\/svg\+xml,([^"]+)"\)/.exec(read("src/web/styles/components.css"))?.[1] ?? "");
  const maskPath = / d='([^']+)'/.exec(mask)?.[1];
  expect(maskPath).toBeDefined();
  expect(/ d="([^"]+)"/.exec(icon)?.[1]).toBe(maskPath);
});

it("builds the lockup from the tile and the outlined wordmark", () => {
  const { container } = render(createElement("a", { className: "rs-brand", href: "#/facts" }, createElement(Lockup)));
  const brand = container.querySelector(".rs-brand")!;
  const [tile, svg] = [...brand.children];
  expect(tile).toHaveClass("rs-brand__tile");
  expect(tile).toHaveAttribute("aria-hidden", "true");
  expect(tile).toBeEmptyDOMElement();

  expect(svg!.tagName.toLowerCase()).toBe("svg");
  expect(svg).toHaveAttribute("viewBox", "0 0 481.72 77.26");
  expect(svg).toHaveAttribute("role", "img");
  expect(svg).toHaveAttribute("aria-label", "Resumatic");
  expect(svg).toHaveAttribute("fill", "currentColor");
  const paths = svg!.querySelectorAll("path");
  expect(paths).toHaveLength(1);
  expect(paths[0]).toHaveAttribute("transform", "translate(-5.56 9.16)");
  expect(paths[0]!.getAttribute("d")).toHaveLength(4423);
  expect(paths[0]!.getAttribute("d")!.startsWith("M5.56 66.8V0H36.28")).toBe(true);
});
