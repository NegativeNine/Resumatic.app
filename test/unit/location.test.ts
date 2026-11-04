import { describe, expect, it } from "vitest";
import { hintFor, isLocationHint } from "../../src/shared/location";

describe("hintFor", () => {
  it.each([
    [{ continent: "NA", longitude: "-122.4" }, "wnam"],
    [{ continent: "NA", longitude: "-74.0" }, "enam"],
    [{ continent: "NA" }, "enam"],
    [{ continent: "SA", longitude: "-46.6" }, "sam"],
    [{ continent: "EU", longitude: "-0.1" }, "weur"],
    [{ continent: "EU", longitude: "21.0" }, "eeur"],
    [{ continent: "EU" }, "weur"],
    [{ continent: "AS", country: "JP" }, "apac"],
    [{ continent: "AS", country: "AE" }, "me"],
    [{ continent: "OC", country: "AU" }, "oc"],
    [{ continent: "AF", country: "NG" }, "afr"],
  ] as const)("maps %o to %s", (cf, hint) => {
    expect(hintFor(cf)).toBe(hint);
  });

  it("falls back to enam when request.cf is missing", () => {
    expect(hintFor(undefined)).toBe("enam");
    expect(hintFor({ continent: "AN" })).toBe("enam");
  });
});

describe("isLocationHint", () => {
  it("accepts only real hints", () => {
    expect(isLocationHint("weur")).toBe(true);
    expect(isLocationHint("mars")).toBe(false);
    expect(isLocationHint(undefined)).toBe(false);
  });
});
