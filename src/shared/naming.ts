export type DocumentKind = "annual" | "results" | "presentations" | "transcripts";

export const DOCUMENT_KINDS: readonly DocumentKind[] = ["annual", "results", "presentations", "transcripts"];

/**
 * Sources collected on a run.
 *
 * "presentations" is disabled: FactSet returns 403 "User Authorization Failed" for
 * /content/events/v2/transcripts/investor-slides with our API key, while filings and
 * transcripts work. Re-enable by uncommenting once FactSet grants access.
 */
export const ENABLED_DOCUMENT_KINDS: readonly DocumentKind[] = [
  "annual",
  "results",
  // "presentations",
  "transcripts",
];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  annual: "Annual reports",
  results: "Results filings",
  presentations: "Investor presentations",
  transcripts: "Earnings-call transcripts",
};

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export type FactSetDocument = Record<string, unknown>;

function field(doc: FactSetDocument, key: string): string {
  const value = doc[key];
  return value === null || value === undefined ? "" : String(value);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Makes a string safe to use as a SharePoint file or folder name. */
export function sanitizeFilename(value: string, maxLength = 180): string {
  const cleaned = collapse(value.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")).replace(/\.+$/, "");
  return (cleaned || "Untitled").slice(0, maxLength).replace(/[\s.]+$/, "") || "Untitled";
}

/** Keeps only FactSet documents explicitly labelled "Annual Report" in the headline. */
export function isTrueAnnualFiling(doc: FactSetDocument): boolean {
  return /\bannual\s+report\b/i.test(collapse(field(doc, "headline")));
}

/** Clean annual-report names such as "Annual Report FY2024" or "Annual Report FY2024_Part_2". */
export function annualReportTitle(doc: FactSetDocument): string {
  const headline = collapse(field(doc, "headline"));
  const fiscalDate = field(doc, "fiscalPeriodEndDate");

  let year = fiscalDate.match(/\b(19|20)\d{2}\b/)?.[0];
  if (!year) {
    const period = headline.match(/period\s+end\s+\d{1,2}[-/][A-Za-z]{3}[-/](19|20)\d{2}/i);
    if (period) year = period[0].match(/(19|20)\d{2}/)?.[0];
  }
  if (!year) year = headline.match(/\b(19|20)\d{2}\b/)?.[0];

  const fiscalLabel = year ? `FY${year}` : "FY Unknown";
  const part = headline.match(/-\s*(\d+)\s*\/\s*(\d+)\s*$/);
  return part ? `Annual Report ${fiscalLabel}_Part_${Number.parseInt(part[1], 10)}` : `Annual Report ${fiscalLabel}`;
}

export function presentationTitle(doc: FactSetDocument, identifier: string): string {
  for (const key of ["title", "headline", "storyTitle", "eventName"]) {
    const value = collapse(field(doc, key));
    if (value) return value;
  }
  return `Investor Presentation ${identifier}`;
}

export function transcriptFallbackTitle(doc: FactSetDocument): string {
  for (const key of ["headline", "title", "eventName"]) {
    const value = collapse(field(doc, key));
    if (value) return value;
  }
  return "FactSet Transcript";
}

/** First http(s) link FactSet provides for a document. */
export function contentUrl(doc: FactSetDocument, keys: readonly string[]): string {
  for (const key of keys) {
    const value = doc[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  }
  return "";
}

/**
 * Hands out unique PDF file names within one SharePoint folder. SharePoint names are
 * case-insensitive, so comparisons are too. Mirrors the original behaviour of appending
 * " - <document id>" when a title is already taken.
 */
export class FileNameRegistry {
  private readonly used = new Set<string>();

  claim(preferredTitle: string, identifier: string): string {
    const base = preferredTitle.trim() ? sanitizeFilename(preferredTitle) : sanitizeFilename(identifier || "document");
    const suffix = sanitizeFilename(identifier || "duplicate", 60);
    const first = this.take(base) ?? this.take(`${base} - ${suffix}`);
    if (first) return first;
    for (let n = 2; ; n++) {
      const next = this.take(`${base} - ${suffix} (${n})`);
      if (next) return next;
    }
  }

  private take(name: string): string | undefined {
    const fileName = `${name}.pdf`;
    const key = fileName.toLowerCase();
    if (this.used.has(key)) return undefined;
    this.used.add(key);
    return fileName;
  }
}
