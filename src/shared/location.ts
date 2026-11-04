/** Durable Object location hints. Hints are best effort, and only the first get() of an object honours one. */
export type LocationHint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";

const HINTS: readonly string[] = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"];

const MIDDLE_EAST = new Set(["AE", "BH", "IL", "IQ", "IR", "JO", "KW", "LB", "OM", "PS", "QA", "SA", "SY", "YE"]);

/** The parts of request.cf this module reads. */
export type CfLocation = {
  continent?: string | null;
  country?: string | null;
  longitude?: string | number | null;
};

export function isLocationHint(value: unknown): value is LocationHint {
  return typeof value === "string" && HINTS.includes(value);
}

/** Picks the location hint nearest the user, so a new vault is created close to them. */
export function hintFor(cf?: CfLocation): LocationHint {
  if (cf?.country && MIDDLE_EAST.has(cf.country)) return "me";
  const lon = cf?.longitude == null || cf.longitude === "" ? Number.NaN : Number(cf.longitude);
  switch (cf?.continent) {
    case "NA":
      return lon < -100 ? "wnam" : "enam";
    case "SA":
      return "sam";
    case "EU":
      return lon >= 20 ? "eeur" : "weur";
    case "AS":
      return "apac";
    case "OC":
      return "oc";
    case "AF":
      return "afr";
    default:
      return "enam";
  }
}
