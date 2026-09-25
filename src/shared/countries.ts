/** Countries shipped with the app. Users can add more at runtime; those always use the ROW drive. */
export const BUILTIN_COUNTRIES = [
  "Argentina", "Australia", "Bangladesh", "Brazil", "Canada", "China",
  "Europe", "India", "Indonesia", "Japan", "Korea", "Malaysia", "Mexico",
  "Misc", "Myanmar", "Pakistan", "Philippines", "Singapore", "Sri Lanka",
  "Taiwan", "Thailand", "United Arab Emirates", "United States", "Vietnam",
  "Hong Kong",
] as const;

export type BuiltinCountry = (typeof BUILTIN_COUNTRIES)[number];

/** A country name shown in the dropdown: one of the built-ins, or one added by a user. */
export type Country = string;

export const DEFAULT_COUNTRY: BuiltinCountry = "India";

/** Longest a user-added country name may be. */
export const MAX_COUNTRY_LENGTH = 60;

/**
 * SharePoint top-level folder for a country, where it differs from the name shown in the UI.
 * These must match the folders that already exist in SharePoint exactly, or a run would
 * create a second folder alongside the real one.
 */
const FOLDER_NAMES: Partial<Record<BuiltinCountry, string>> = {
  "China": "China_A_Shares",
  "Hong Kong": "HongKong",
  "Sri Lanka": "SriLanka",
  "United Arab Emirates": "UAE",
  "United States": "US",
};

export function isBuiltinCountry(value: unknown): value is BuiltinCountry {
  return typeof value === "string" && (BUILTIN_COUNTRIES as readonly string[]).includes(value);
}

export function countryFolder(country: Country): string {
  return (isBuiltinCountry(country) ? FOLDER_NAMES[country] : undefined) ?? country;
}

/** Countries on the India and China/Hong Kong drives; everything else uses ROW. */
export function isRestOfWorld(country: Country): boolean {
  return country !== "India" && country !== "China" && country !== "Hong Kong";
}

/**
 * Checks a user-supplied country name. Kept deliberately narrow: the value becomes a
 * top-level SharePoint folder name, so no slashes, dots or other path characters.
 */
export function normalizeNewCountry(value: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) return { ok: false, error: "Enter a country name." };
  if (name.length > MAX_COUNTRY_LENGTH) return { ok: false, error: `Country names can be at most ${MAX_COUNTRY_LENGTH} characters.` };
  if (!/^[A-Za-z][A-Za-z0-9 &()'-]*$/.test(name)) {
    return { ok: false, error: "Use letters, numbers, spaces and & ( ) ' - only, starting with a letter." };
  }
  return { ok: true, name };
}

export function sameCountry(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
