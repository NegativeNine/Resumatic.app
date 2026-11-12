// Draws the invite email's lockup, public/email/resumatic-lockup.png: the green tile with its check,
// then the name in ink, on a white ground of its own so it stays legible when a mail client darkens
// the message. Everything comes from files in the repository: the wordmark from
// src/web/components/Lockup.tsx, the tile and its check from public/favicon.svg, and the colours
// from the light theme in src/web/styles/tokens.css. It is drawn at 218 × 44, its display size, and
// written at twice that. Run it with `node scripts/draw-email-lockup.mjs` after any of them changes.
//
// Importing this module only reads files. sharp, which renders the PNG, is loaded only when the
// script is run directly; it comes with miniflare as a dev dependency.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, "utf8");

/** The display size, in CSS pixels. The PNG is twice this. */
export const WIDTH = 218;
export const HEIGHT = 44;

/** The outlined wordmark, as Lockup.tsx draws it. */
export function wordmarkPath() {
  const found = read("src/web/components/Lockup.tsx").match(/const WORDMARK = "([^"]+)"/);
  if (!found) throw new Error("Lockup.tsx has no WORDMARK");
  return found[1];
}

/** A custom property's value in the light theme of tokens.css. */
export function lightToken(name) {
  const css = read("src/web/styles/tokens.css");
  const light = css.match(/:root, \[data-theme="light"\] \{([^}]*)\}/);
  const value = light?.[1].match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!value) throw new Error(`tokens.css has no light --${name}`);
  return value[1].trim();
}

/** The check on the favicon's tile, and the tile's corner radius, at the favicon's 24 × 24. */
export function faviconCheck() {
  const svg = read("public/favicon.svg");
  const rect = svg.match(/<rect [^>]*rx="([\d.]+)"/);
  const path = svg.match(/<path [^>]*stroke-width="([\d.]+)"[^>]*d="([^"]+)"/);
  if (!rect || !path) throw new Error("favicon.svg has no tile and check");
  return { rx: Number(rect[1]), strokeWidth: Number(path[1]), d: path[2] };
}

/**
 * The lockup as SVG, at the display size: a white ground, the 32 px tile at (10, 6), its check
 * scaled 4/3 from the favicon, and the wordmark scaled to 0.3187 at (54.31, 9.69). `scale` sets the
 * size it is written at; the drawing itself is always laid out at 218 × 44.
 */
export function lockupSvg(scale = 2) {
  const tile = 32;
  const check = faviconCheck();
  const factor = tile / 24;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH * scale}" height="${HEIGHT * scale}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
    `<rect x="10" y="6" width="${tile}" height="${tile}" rx="${+(check.rx * factor).toFixed(2)}" fill="${lightToken("brand")}"/>`,
    `<path transform="translate(10 6) scale(${+factor.toFixed(4)})" fill="none" stroke="${lightToken("on-brand")}" stroke-width="${check.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" d="${check.d}"/>`,
    `<path transform="translate(54.31 9.69) scale(0.3187) translate(-5.56 9.16)" fill="${lightToken("ink")}" d="${wordmarkPath()}"/>`,
    `</svg>`,
  ].join("");
}

/** Renders the lockup to the PNG the email links to. */
export async function drawLockup(out = `${root}public/email/resumatic-lockup.png`) {
  const { default: sharp } = await import("sharp");
  const png = await sharp(Buffer.from(lockupSvg(2)))
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(out, png);
  return png;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const png = await drawLockup();
  console.log(`public/email/resumatic-lockup.png: ${png.length} bytes, ${WIDTH * 2} × ${HEIGHT * 2}`);
}
