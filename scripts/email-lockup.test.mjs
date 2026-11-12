import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lockupSvg } from "./draw-email-lockup.mjs";

// The invite email's lockup is drawn from the app's own files (scripts/draw-email-lockup.mjs). These
// checks read the committed PNG's header and the files themselves, and never load sharp.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, "utf8");

test("the committed lockup is a PNG of 436 × 88, twice its display size", () => {
  const png = readFileSync(`${root}public/email/resumatic-lockup.png`);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 436);
  assert.equal(png.readUInt32BE(20), 88);
});

test("the lockup is drawn from Lockup.tsx's wordmark, the light brand and ink, and the favicon's check", () => {
  const svg = lockupSvg();
  const wordmark = read("src/web/components/Lockup.tsx").match(/const WORDMARK = "([^"]+)"/)[1];
  assert.ok(svg.includes(`d="${wordmark}"`));
  const light = read("src/web/styles/tokens.css").match(/:root, \[data-theme="light"\] \{([^}]*)\}/)[1];
  const token = (name) => light.match(new RegExp(`--${name}:\\s*([^;]+);`))[1].trim();
  assert.ok(svg.includes(`fill="${token("brand")}"`));
  assert.ok(svg.includes(`fill="${token("ink")}"`));
  const check = read("public/favicon.svg").match(/<path [^>]*d="([^"]+)"/)[1];
  assert.ok(svg.includes(`d="${check}"`));
  // A white ground of its own, so a mail client that darkens the message leaves it legible.
  assert.match(svg, /^<svg [^>]*width="436" height="88" viewBox="0 0 218 44"><rect width="218" height="44" fill="#ffffff"\/>/);
});

test("the connect sign-in page draws the same lockup inline, with attributes and no style", () => {
  const mcp = read("src/worker/mcp.ts");
  const inline = mcp.match(/const SIGN_IN_LOCKUP = `(<svg [^`]+<\/svg>)`;/)[1];
  // Everything but the white ground and the size it is written at is the email's drawing.
  const drawn = lockupSvg(1).replace(/^<svg [^>]*>/, "").replace(/^<rect width="218" height="44" fill="#ffffff"\/>/, "");
  assert.equal(inline.replace(/^<svg [^>]*>/, ""), drawn);
  assert.doesNotMatch(inline, /style|class=|<image|href=/);
});
