import { describe, expect, it } from "vitest";
import {
  FileNameRegistry,
  annualReportTitle,
  contentUrl,
  isTrueAnnualFiling,
  presentationTitle,
  sanitizeFilename,
} from "../src/shared/naming";

describe("sanitizeFilename", () => {
  it("removes characters SharePoint does not allow", () => {
    expect(sanitizeFilename('A<b>:c"d/e\\f|g?h*i')).toBe("A b c d e f g h i");
  });

  it("collapses whitespace and strips trailing dots", () => {
    expect(sanitizeFilename("  Annual   Report...  ")).toBe("Annual Report");
  });

  it("falls back to Untitled", () => {
    expect(sanitizeFilename(" / ")).toBe("Untitled");
  });

  it("prevents path traversal in company names", () => {
    expect(sanitizeFilename("../../Other/Company")).toBe(".. .. Other Company");
  });

  it("truncates to the maximum length", () => {
    expect(sanitizeFilename("x".repeat(300)).length).toBe(180);
  });
});

describe("annual reports", () => {
  it("only accepts headlines saying Annual Report", () => {
    expect(isTrueAnnualFiling({ headline: "Annual  Report 2024" })).toBe(true);
    expect(isTrueAnnualFiling({ headline: "Annual General Meeting notice" })).toBe(false);
  });

  it("uses the fiscal period end date first", () => {
    expect(annualReportTitle({ headline: "Annual Report 2023", fiscalPeriodEndDate: "2024-03-31" })).toBe("Annual Report FY2024");
  });

  it("falls back to the period end in the headline", () => {
    expect(annualReportTitle({ headline: "Annual Report for period end 31-Mar-2022" })).toBe("Annual Report FY2022");
  });

  it("keeps split parts", () => {
    expect(annualReportTitle({ headline: "Annual Report 2021 - 2/3" })).toBe("Annual Report FY2021_Part_2");
  });

  it("handles a missing year", () => {
    expect(annualReportTitle({ headline: "Annual Report" })).toBe("Annual Report FY Unknown");
  });
});

describe("presentations and links", () => {
  it("picks the first available title", () => {
    expect(presentationTitle({ headline: "Q1 Investor Deck" }, "r1")).toBe("Q1 Investor Deck");
    expect(presentationTitle({}, "r1")).toBe("Investor Presentation r1");
  });

  it("picks the first http link", () => {
    expect(contentUrl({ a: "not a link", b: "https://api.factset.com/x" }, ["a", "b"])).toBe("https://api.factset.com/x");
    expect(contentUrl({}, ["a"])).toBe("");
  });
});

describe("FileNameRegistry", () => {
  it("adds the document id for duplicate titles, case-insensitively", () => {
    const names = new FileNameRegistry();
    expect(names.claim("Annual Report FY2024", "D1")).toBe("Annual Report FY2024.pdf");
    expect(names.claim("annual report fy2024", "D2")).toBe("annual report fy2024 - D2.pdf");
    expect(names.claim("Annual Report FY2024", "D2")).toBe("Annual Report FY2024 - D2 (2).pdf");
  });

  it("uses the identifier when there is no title", () => {
    expect(new FileNameRegistry().claim("  ", "DOC-9")).toBe("DOC-9.pdf");
  });
});
