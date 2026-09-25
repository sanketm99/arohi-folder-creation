import { describe, expect, it } from "vitest";
import {
  BUILTIN_COUNTRIES,
  countryFolder,
  isBuiltinCountry,
  isRestOfWorld,
  normalizeNewCountry,
} from "../src/shared/countries";

/**
 * Folder names must match the folders that already exist in SharePoint. A mismatch
 * would silently create a second country folder next to the real one.
 */
describe("countryFolder", () => {
  it("uses the existing SharePoint spellings", () => {
    expect(countryFolder("Sri Lanka")).toBe("SriLanka");
    expect(countryFolder("United Arab Emirates")).toBe("UAE");
    expect(countryFolder("United States")).toBe("US");
    expect(countryFolder("China")).toBe("China_A_Shares");
    expect(countryFolder("Hong Kong")).toBe("HongKong");
  });

  it("uses the country name itself where SharePoint already matches", () => {
    for (const country of ["Japan", "Singapore", "Europe", "Misc", "India"] as const) {
      expect(countryFolder(country)).toBe(country);
    }
  });

  it("never produces a folder name with characters SharePoint rejects", () => {
    for (const country of BUILTIN_COUNTRIES) {
      expect(countryFolder(country)).toMatch(/^[A-Za-z][A-Za-z0-9 _]*$/);
    }
  });

  it("uses the name itself for a country a user added", () => {
    expect(countryFolder("Saudi Arabia")).toBe("Saudi Arabia");
  });
});

describe("isBuiltinCountry", () => {
  it("accepts listed countries only", () => {
    expect(isBuiltinCountry("India")).toBe(true);
    expect(isBuiltinCountry("Mars")).toBe(false);
    expect(isBuiltinCountry("india")).toBe(false);
  });
});

describe("isRestOfWorld", () => {
  it("sends everything except India, China and Hong Kong to the ROW drive", () => {
    expect(isRestOfWorld("Saudi Arabia")).toBe(true);
    expect(isRestOfWorld("Japan")).toBe(true);
    expect(isRestOfWorld("India")).toBe(false);
    expect(isRestOfWorld("China")).toBe(false);
    expect(isRestOfWorld("Hong Kong")).toBe(false);
  });
});

describe("normalizeNewCountry", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeNewCountry("  Saudi   Arabia ")).toEqual({ ok: true, name: "Saudi Arabia" });
  });

  it("allows punctuation that appears in real country names", () => {
    expect(normalizeNewCountry("Cote d'Ivoire").ok).toBe(true);
    expect(normalizeNewCountry("Korea (North)").ok).toBe(true);
  });

  it("rejects empty, over-long and unsafe names", () => {
    expect(normalizeNewCountry("   ").ok).toBe(false);
    expect(normalizeNewCountry("x".repeat(61)).ok).toBe(false);
    for (const bad of ["../Other", "Nowhere/Land", "C:\\temp", "<script>", ".hidden", "9Lives"]) {
      expect(normalizeNewCountry(bad).ok, bad).toBe(false);
    }
  });
});
