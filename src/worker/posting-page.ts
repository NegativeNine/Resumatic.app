import { MAX_JD_CHARS, MAX_JOB_NAME_CHARS } from "../shared/api";

// Reads a job posting out of a web page's structured data (schema.org JobPosting in JSON-LD, which
// job sites publish for search engines). Everything here is pure, and everything it returns is the
// site's text: untrusted, shown to the person to check, and treated as data wherever it goes next.

/** What a page says about one job. */
export interface FoundPosting {
  title: string | null;
  company: string | null;
  location: string | null;
  /** The posting's body as plain text. */
  description: string;
}

/** The most of one script block, or one HTML fragment, that is looked at. */
const MAX_BLOCK_CHARS = 400_000;
const MAX_BLOCKS = 20;
const MAX_DEPTH = 6;
const MAX_NODES = 2_000;

/** The script's own type attribute, not a data-type or similar. */
const TYPE = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// A page is whatever a site sends, so every scan below moves forward once and never backtracks
// over the page: a page built to make a pattern slow cannot make these slow.

/** Each `<tag …>…</tag>` block in turn: its attributes and what it holds. A tag that never closes ends the scan. */
function* blocks(html: string, tag: string): Generator<{ start: number; end: number; attributes: string; body: string }> {
  const open = new RegExp(`<${tag}\\b`, "gi");
  const close = new RegExp(`</${tag}\\s*>`, "gi");
  let at = 0;
  for (;;) {
    open.lastIndex = at;
    const start = open.exec(html);
    if (!start) return;
    const tagEnd = html.indexOf(">", start.index);
    if (tagEnd < 0) return;
    close.lastIndex = tagEnd;
    const end = close.exec(html);
    if (!end) {
      yield { start: start.index, end: html.length, attributes: "", body: "" };
      return;
    }
    at = end.index + end[0].length;
    yield { start: start.index, end: at, attributes: html.slice(start.index + tag.length + 1, tagEnd), body: html.slice(tagEnd + 1, end.index) };
  }
}

/** The JobPosting a page declares, or null when it declares none that can be read. */
export function extractJobPosting(html: string): FoundPosting | null {
  let seen = 0;
  for (const block of blocks(html, "script")) {
    const type = TYPE.exec(block.attributes.slice(0, 2_000));
    const value = (type?.[1] ?? type?.[2] ?? type?.[3] ?? "").trim().toLowerCase();
    if (!value.startsWith("application/ld+json")) continue;
    if (++seen > MAX_BLOCKS) break;
    if (block.body.length > MAX_BLOCK_CHARS) continue;
    const node = findPosting(parseLoose(block.body), 0, { nodes: MAX_NODES });
    const found = node && readPosting(node);
    if (found) return found;
  }
  return null;
}

/** JSON as sites write it: sometimes inside a comment or CDATA, sometimes with raw line breaks in strings. */
function parseLoose(source: string): unknown {
  const text = source
    .trim()
    .replace(/^(?:\/\/\s*)?<!\[CDATA\[/, "")
    .replace(/(?:\/\/\s*)?\]\]>$/, "")
    .replace(/^<!--/, "")
    .replace(/-->$/, "")
    .trim();
  for (const candidate of [text, text.replace(/[\u0000-\u001f]+/g, " ")]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next reading.
    }
  }
  return undefined;
}

const POSTING_TYPES = new Set(["JobPosting", "https://schema.org/JobPosting", "http://schema.org/JobPosting"]);
/** Where a posting sits when it isn't the top of the block. */
const CONTAINERS = ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"];

function findPosting(value: unknown, depth: number, budget: { nodes: number }): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || depth > MAX_DEPTH || budget.nodes-- <= 0) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPosting(item, depth + 1, budget);
      if (found) return found;
    }
    return null;
  }
  const node = value as Record<string, unknown>;
  const type = node["@type"];
  const types = typeof type === "string" ? [type] : Array.isArray(type) ? type : [];
  if (types.some((item) => typeof item === "string" && POSTING_TYPES.has(item))) return node;
  for (const key of CONTAINERS) {
    const found = findPosting(node[key], depth + 1, budget);
    if (found) return found;
  }
  return null;
}

function readPosting(node: Record<string, unknown>): FoundPosting | null {
  const body = text(node.description);
  // Some sites split the posting across these. Each is a text property of JobPosting.
  const parts = [
    body,
    section("Responsibilities", node.responsibilities, body),
    section("Qualifications", node.qualifications, body),
    section("Skills", node.skills, body),
  ].filter(Boolean);
  const description = parts.join("\n\n");
  if (!description) return null;
  const organization = node.hiringOrganization;
  return {
    title: name(node.title) ?? name(node.name),
    company: name(typeof organization === "object" && organization ? (organization as Record<string, unknown>).name : organization),
    location: location(node),
    description,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? htmlToText(value) : "";
}

/** A part of the posting under its own heading, unless the body already says it. */
function section(heading: string, value: unknown, body: string): string {
  const part = text(value);
  return part && !body.includes(part) ? `${heading}\n${part}` : "";
}

/** A title or a company: one line, no longer than a job's name can be. */
function name(value: unknown): string | null {
  const line = text(value).replace(/\s+/g, " ").trim().slice(0, MAX_JOB_NAME_CHARS).trim();
  return line || null;
}

function location(node: Record<string, unknown>): string | null {
  const places: string[] = [];
  const first = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
  const address = first && typeof first === "object" ? (first as Record<string, unknown>).address : first;
  if (typeof address === "string") places.push(address);
  else if (address && typeof address === "object") {
    const fields = address as Record<string, unknown>;
    for (const key of ["addressLocality", "addressRegion", "addressCountry"]) {
      const field = fields[key];
      const part = name(typeof field === "object" && field ? (field as Record<string, unknown>).name : field);
      if (part && !places.includes(part)) places.push(part);
    }
  }
  const place = name(places.join(", "));
  const kind = node.jobLocationType;
  const remote = (Array.isArray(kind) ? kind : [kind]).some((item) => typeof item === "string" && /^telecommute$/i.test(item.trim()));
  return [place, remote ? "Remote" : null].filter(Boolean).join(". ") || null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
  times: "×", frac12: "½", eacute: "é", egrave: "è", aacute: "á", agrave: "à", uuml: "ü", ouml: "ö", auml: "ä",
  ntilde: "ñ", ccedil: "ç", iacute: "í", oacute: "ó", uacute: "ú", szlig: "ß",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,10}));/g, (whole, decimal, hex, named) => {
    if (named !== undefined) return ENTITIES[named] ?? whole;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
    const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && !(code >= 0x7f && code <= 0x9f));
    return printable ? String.fromCodePoint(code) : " ";
  });
}

/** The text with every `<tag>…</tag>` block taken out, and with it anything after a tag that never closes. */
function dropBlocks(value: string, tag: string): string {
  let out = "";
  let at = 0;
  for (const block of blocks(value, tag)) {
    out += `${value.slice(at, block.start)} `;
    at = block.end;
  }
  return out + value.slice(at);
}

function dropComments(value: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const start = value.indexOf("<!--", at);
    if (start < 0) return out + value.slice(at);
    out += `${value.slice(at, start)} `;
    const end = value.indexOf("-->", start + 4);
    if (end < 0) return out;
    at = end + 3;
  }
}

/** Markup becomes line breaks and bullets. A "<" that doesn't open a tag is left as the text it is. */
function stripTags(value: string): string {
  let text = dropComments(value);
  for (const tag of ["script", "style", "noscript", "template"]) text = dropBlocks(text, tag);
  return text
    .replace(/<br\b[^<>]*>/gi, "\n")
    .replace(/<li\b[^<>]*>/gi, "\n- ")
    .replace(/<\/(?:li|tr|dt|dd)\s*>/gi, "\n")
    .replace(/<\/?(?:p|div|section|article|header|footer|h[1-6]|ul|ol|table|blockquote|pre|hr)\b[^<>]*>/gi, "\n\n")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, " ");
}

/** An HTML fragment as plain text. The fragment may itself be entity-encoded HTML, as many sites send it. */
export function htmlToText(input: string): string {
  let value = input.slice(0, MAX_BLOCK_CHARS);
  for (let round = 0; round < 2; round++) {
    value = stripTags(value);
    const decoded = decodeEntities(value);
    const revealedMarkup = decoded !== value && /<\/?[a-zA-Z]/.test(decoded);
    value = decoded;
    if (!revealedMarkup) break;
    if (round === 1) value = stripTags(value);
  }
  const lines = value
    .replace(/\r\n?/g, "\n")
    // Control and zero-width characters carry nothing a person reads. Nor do marks of direction,
    // which can show a posting in one order while it is read, and searched for skills, in another.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    // Every kind of space is one space.
    .replace(/[\t \u00a0\u2000-\u200a\u202f\u3000]+/g, " ")
    .split("\n")
    .map((line) => line.trim());
  return listLines(lines).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Bullets as a person would type them: each on one line with its text, and no gaps inside a list. */
function listLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // The next line with anything on it.
    let next = i + 1;
    while (next < lines.length && lines[next] === "") next++;
    if (line === "-") {
      // A bullet whose text began on a later line, or one with no text at all.
      if (next >= lines.length || lines[next]!.startsWith("-")) continue;
      line = `- ${lines[next]!}`;
      i = next;
      next = i + 1;
      while (next < lines.length && lines[next] === "") next++;
    }
    out.push(line);
    if (line.startsWith("- ") && next < lines.length && lines[next]!.startsWith("-")) i = next - 1;
  }
  return out;
}

/** The posting as the text a person would have pasted, cut to the longest a posting can be. */
export function composePosting(found: FoundPosting, max = MAX_JD_CHARS): { text: string; truncated: boolean } {
  const head = [[found.title, found.company].filter(Boolean).join(" at "), found.location ? `Location: ${found.location}` : ""]
    .filter(Boolean)
    .join("\n");
  const whole = [head, found.description].filter(Boolean).join("\n\n");
  if (whole.length <= max) return { text: whole, truncated: false };
  // End on a whole line when one ends near the limit.
  const cut = whole.slice(0, max);
  const lineEnd = cut.lastIndexOf("\n");
  return { text: (lineEnd > max * 0.8 ? cut.slice(0, lineEnd) : cut).trimEnd(), truncated: true };
}
