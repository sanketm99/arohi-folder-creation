import { DOMParser } from "@xmldom/xmldom";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildTranscriptPdf } from "../src/client/transcriptPdf";
import { parseTranscriptXml } from "../src/client/transcriptXml";

const longParagraph = "Revenue grew strongly this quarter, driven by insurance distribution and lending. ".repeat(25);

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<transcript xmlns="http://www.factset.com/callstreet/xmllayout/v0.1">
  <meta>
    <title>PB Fintech Ltd., Q1 2027 Earnings Call, Jul 30, 2026</title>
    <date>2026-07-30</date>
    <participants>
      <participant id="1" type="corprep" affiliation="PB Fintech Ltd." title="Chief Executive Officer">Yashish Dahiya</participant>
      <participant id="2" type="analyst" affiliation="Kotak &amp;amp; Co.">Analyst One</participant>
    </participants>
  </meta>
  <body>
    <section name="MANAGEMENT DISCUSSION SECTION">
      <speaker id="1"><plist><p>Good evening &#8212; thank you for joining. Revenue was ₹1,000 crore.</p><p>${longParagraph}</p></plist></speaker>
    </section>
    <section name="Q&amp;A">
      <speaker id="2"><plist><p>Could you talk about margins? 你好</p></plist></speaker>
      <speaker id="9"><plist><p>Unknown speaker line.</p></plist></speaker>
      <speaker id="1"><plist><p>   </p></plist></speaker>
    </section>
  </body>
</transcript>`;

function parse(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return parseTranscriptXml(doc as unknown as Document);
}

describe("parseTranscriptXml", () => {
  it("reads title, date, participants and sections in order", () => {
    const transcript = parse(SAMPLE);
    expect(transcript.title).toBe("PB Fintech Ltd., Q1 2027 Earnings Call, Jul 30, 2026");
    expect(transcript.date).toBe("2026-07-30");
    expect(transcript.participants).toEqual([
      { name: "Yashish Dahiya", title: "Chief Executive Officer", affiliation: "PB Fintech Ltd." },
      { name: "Analyst One", title: "", affiliation: "Kotak & Co." },
    ]);
    expect(transcript.sections.map((s) => s.name)).toEqual(["MANAGEMENT DISCUSSION SECTION", "Q&A"]);
    expect(transcript.sections[0].speakers[0].label).toBe("Yashish Dahiya (Chief Executive Officer, PB Fintech Ltd.)");
    expect(transcript.sections[0].speakers[0].paragraphs).toHaveLength(2);
    expect(transcript.sections[1].speakers.map((s) => s.label)).toEqual(["Analyst One (Kotak & Co.)", "Speaker 9"]);
  });

  it("rejects XML without a body", () => {
    expect(() => parse("<transcript><meta/></transcript>")).toThrow(/no body/);
  });
});

describe("buildTranscriptPdf", () => {
  it("produces a multi-page PDF and copes with characters Helvetica cannot draw", async () => {
    const transcript = parse(SAMPLE);
    transcript.sections[0].speakers[0].paragraphs.push(...Array(40).fill(longParagraph));

    const bytes = await buildTranscriptPdf(transcript);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(3);
    expect(pdf.getTitle()).toBe(transcript.title);
  });
});
