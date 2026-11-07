import { readFile } from "node:fs/promises";

/** JSONC lexer: unlike regex stripping, this preserves https:// URLs and escaped quotes. */
export function parseJsonc(source) {
  let output = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      output += c;
      if (c === "\\") output += source[++i] ?? "";
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      output += c;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      output += "\n";
    } else if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      if (i >= source.length) throw new Error("unterminated JSONC comment");
      i++;
      output += " ";
    } else if (c === "," && /^[\s]*[}\]]/.test(source.slice(i + 1))) {
      /* trailing comma */
    } else output += c;
  }
  // Comments may have appeared between the last comma and closing delimiter.
  let clean = "";
  quoted = false;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (quoted) {
      clean += c;
      if (c === "\\") clean += output[++i] ?? "";
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      clean += c;
    } else if (c === "," && /^\s*[}\]]/.test(output.slice(i + 1))) {
      /* trailing comma */
    } else clean += c;
  }
  return JSON.parse(clean);
}

export async function readConfig(environment, path = "wrangler.jsonc") {
  if (!["staging", "production"].includes(environment))
    throw new Error("environment must be staging or production");
  const root = parseJsonc(await readFile(path, "utf8"));
  // Production is the top-level configuration. Never synthesize --env production.
  const config = environment === "production" ? root : root.env?.staging;
  if (!config) throw new Error("staging configuration is missing");
  return {
    root,
    config,
    name:
      environment === "production"
        ? root.name
        : (config.name ?? `${root.name}-staging`),
  };
}

export function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
