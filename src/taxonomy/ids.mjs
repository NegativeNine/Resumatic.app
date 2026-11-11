// Concept IDs in the combined taxonomy. One grammar for both sources, shared by the builder (Node)
// and the Worker. An ID names its source first, so a stored tag always says whose concept it is:
//
//   esco:skill:<uuid>            an ESCO skill or knowledge concept
//   esco:skill:S1.2.3            an ESCO skill group
//   esco:isced-f:0611            an ESCO knowledge group
//   esco:occupation:<uuid>       an ESCO occupation
//   esco:isco:C2512              an ISCO-08 group, as ESCO publishes it
//   onet:occ:15-1252.00          an O*NET-SOC occupation
//   onet:activity:<element id>   a general, intermediate or detailed work activity
//   onet:task:<task id>          a task statement
//   onet:tool:<slug>             a software example; it has no ID of its own, so its name is its ID
//   onet:toolcat:<element id>    a software category
//
// An ESCO ID is its URI with the fixed prefix removed, so the URI can always be given back.

export const ESCO_URI_PREFIX = "http://data.europa.eu/esco/";

const ID = /^(?:esco|onet):[a-z][a-z-]{0,23}:[A-Za-z0-9][A-Za-z0-9._+#-]{0,119}$/;
const ESCO_PATH = /^[a-z][a-z-]{0,23}\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ONET_SOC = /^\d{2}-\d{4}\.\d{2}$/;
const ELEMENT = /^[A-Za-z0-9][A-Za-z0-9.]{0,39}$/;

/** True for a well-formed concept ID. It says nothing about whether the concept exists. */
export function validConceptId(value) {
  return typeof value === "string" && ID.test(value);
}

/** The ID of an ESCO concept from its URI, or null when the URI isn't one of ESCO's. */
export function escoId(uri) {
  if (typeof uri !== "string") return null;
  const trimmed = uri.trim();
  if (!trimmed.startsWith(ESCO_URI_PREFIX)) return null;
  const path = trimmed.slice(ESCO_URI_PREFIX.length);
  if (!ESCO_PATH.test(path)) return null;
  return `esco:${path.replace("/", ":")}`;
}

/** The URI ESCO publishes a concept under, from its ID. Null for an ID that isn't ESCO's. */
export function escoUri(id) {
  if (!validConceptId(id) || !id.startsWith("esco:")) return null;
  const rest = id.slice(5);
  const at = rest.indexOf(":");
  return `${ESCO_URI_PREFIX}${rest.slice(0, at)}/${rest.slice(at + 1)}`;
}

/** True for an O*NET-SOC code as the database writes it: 15-1252.00. */
export function validOnetSoc(code) {
  return typeof code === "string" && ONET_SOC.test(code);
}

export function onetOccupationId(code) {
  return validOnetSoc(code) ? `onet:occ:${code}` : null;
}

/** An element of O*NET's content model, such as a work activity or a software category. */
export function onetElementId(kind, element) {
  if ((kind !== "activity" && kind !== "toolcat") || typeof element !== "string") return null;
  const trimmed = element.trim();
  return ELEMENT.test(trimmed) ? `onet:${kind}:${trimmed}` : null;
}

export function onetTaskId(task) {
  const text = typeof task === "number" ? String(task) : typeof task === "string" ? task.trim() : "";
  return /^[1-9]\d{0,8}$/.test(text) ? `onet:task:${text}` : null;
}

/**
 * The ID of a software example, made from its name in comparison form. Two examples that compare
 * equal are one tool. Null when the name leaves nothing to make an ID from.
 */
export function onetToolId(norm) {
  if (typeof norm !== "string") return null;
  const slug = norm
    .replace(/[^a-z0-9.+#]+/g, "-")
    .replace(/^[-.+#]+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return slug ? `onet:tool:${slug}` : null;
}

/** The source a concept comes from: "esco" or "onet". Null for a malformed ID. */
export function schemeOf(id) {
  return validConceptId(id) ? id.slice(0, id.indexOf(":")) : null;
}
