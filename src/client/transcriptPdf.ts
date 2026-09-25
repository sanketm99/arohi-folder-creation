import { PDFDocument, StandardFonts, rgb, type Color, type PDFFont, type PDFPage } from "pdf-lib";
import type { Transcript } from "./transcriptXml";

const MM = 72 / 25.4;
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 18 * MM;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

function hex(value: string): Color {
  const n = Number.parseInt(value.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

interface TextStyle {
  bold?: boolean;
  size: number;
  leading: number;
  color: Color;
  spaceBefore: number;
  spaceAfter: number;
  center?: boolean;
}

const STYLES = {
  title: { bold: true, size: 20, leading: 24, color: hex("#17212B"), spaceBefore: 0, spaceAfter: 8, center: true },
  date: { size: 10, leading: 13, color: hex("#555555"), spaceBefore: 0, spaceAfter: 14, center: true },
  section: { bold: true, size: 14, leading: 18, color: hex("#1F3A5F"), spaceBefore: 12, spaceAfter: 8 },
  speaker: { bold: true, size: 10.5, leading: 14, color: hex("#222222"), spaceBefore: 8, spaceAfter: 3 },
  body: { size: 9.5, leading: 14, color: hex("#17212B"), spaceBefore: 0, spaceAfter: 7 },
  participant: { size: 9, leading: 12, color: hex("#17212B"), spaceBefore: 0, spaceAfter: 0 },
} satisfies Record<string, TextStyle>;

/** Characters outside the standard PDF fonts' WinAnsi set that have a sensible substitute. */
const SUBSTITUTES: Record<string, string> = {
  "₹": "Rs.", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  "​": "", "﻿": "", "−": "-", "‐": "-", "‑": "-", "‒": "-", "―": "-",
  "′": "'", "″": '"', "­": "",
};

class PdfWriter {
  private page!: PDFPage;
  private y = 0;
  private atTop = true;
  private readonly supported: Set<number>;

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.supported = new Set(regular.getCharacterSet());
    this.addPage();
  }

  addPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
    this.atTop = true;
  }

  /** Replaces characters the built-in Helvetica font cannot draw. */
  clean(text: string): string {
    let out = "";
    for (const char of text.replace(/\t/g, " ")) {
      const code = char.codePointAt(0)!;
      if (this.supported.has(code)) out += char;
      else if (char in SUBSTITUTES) out += SUBSTITUTES[char];
      else {
        const stripped = char.normalize("NFKD").replace(/\p{M}/gu, "");
        out += [...stripped].every((c) => this.supported.has(c.codePointAt(0)!)) && stripped ? stripped : "?";
      }
    }
    return out;
  }

  private font(style: TextStyle): PDFFont {
    return style.bold ? this.bold : this.regular;
  }

  wrap(text: string, style: TextStyle, width = CONTENT_WIDTH): string[] {
    const font = this.font(style);
    const measure = (value: string) => font.widthOfTextAtSize(value, style.size);
    const lines: string[] = [];
    let line = "";

    for (const word of this.clean(text).split(" ").filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      if (measure(word) <= width) {
        line = word;
        continue;
      }
      // A single word wider than the line: break it by characters.
      for (const char of word) {
        if (line && measure(line + char) > width) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  private remaining(): number {
    return this.y - MARGIN;
  }

  /** Height a paragraph's first `lineCount` lines need, including space before it. */
  heightOf(style: TextStyle, lineCount: number): number {
    return style.spaceBefore + lineCount * style.leading;
  }

  /**
   * Draws a paragraph, splitting across pages line by line. `keepWithNext` is the extra
   * height that must fit on the same page as the first line (used for headings).
   */
  paragraph(text: string, style: TextStyle, keepWithNext = 0): void {
    const lines = this.wrap(text, style);
    let before = this.atTop ? 0 : style.spaceBefore;
    if (!this.atTop && before + style.leading + keepWithNext > this.remaining()) {
      this.addPage();
      before = 0;
    }
    this.y -= before;

    const font = this.font(style);
    for (const line of lines) {
      if (style.leading > this.remaining()) this.addPage();
      const width = font.widthOfTextAtSize(line, style.size);
      const x = style.center ? MARGIN + (CONTENT_WIDTH - width) / 2 : MARGIN;
      const baseline = this.y - style.leading + (style.leading - style.size) / 2 + style.size * 0.22;
      this.page.drawText(line, { x, y: baseline, size: style.size, font, color: style.color });
      this.y -= style.leading;
      this.atTop = false;
    }
    this.y -= style.spaceAfter;
  }

  /** Participant list as a shaded, bordered table. */
  participantTable(rows: string[]): void {
    const style = STYLES.participant;
    const padX = 8;
    const padY = 5;
    for (const row of rows) {
      const lines = this.wrap(row, style, CONTENT_WIDTH - 2 * padX);
      const height = lines.length * style.leading + 2 * padY;
      if (height > this.remaining() && !this.atTop) this.addPage();

      this.page.drawRectangle({
        x: MARGIN, y: this.y - height, width: CONTENT_WIDTH, height,
        color: hex("#F7F8FA"), borderColor: hex("#D8DCE2"), borderWidth: 0.5,
      });
      let y = this.y - padY;
      for (const line of lines) {
        const baseline = y - style.leading + (style.leading - style.size) / 2 + style.size * 0.22;
        this.page.drawText(line, { x: MARGIN + padX, y: baseline, size: style.size, font: this.regular, color: style.color });
        y -= style.leading;
      }
      this.y -= height;
      this.atTop = false;
    }
  }

  drawFooters(): void {
    const size = 8;
    const color = hex("#666666");
    this.doc.getPages().forEach((page, index) => {
      page.drawLine({
        start: { x: MARGIN, y: 13 * MM }, end: { x: PAGE_WIDTH - MARGIN, y: 13 * MM },
        thickness: 0.5, color: hex("#D0D0D0"),
      });
      page.drawText("FactSet transcript", { x: MARGIN, y: 8 * MM, size, font: this.regular, color });
      const label = `Page ${index + 1}`;
      const width = this.regular.widthOfTextAtSize(label, size);
      page.drawText(label, { x: PAGE_WIDTH - MARGIN - width, y: 8 * MM, size, font: this.regular, color });
    });
  }
}

/** Renders a full FactSet transcript as a readable A4 PDF (same layout as the original tool). */
export async function buildTranscriptPdf(transcript: Transcript): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const writer = new PdfWriter(doc, regular, bold);

  doc.setTitle(writer.clean(transcript.title));
  doc.setAuthor("Company Research");
  doc.setCreator("Company Research");

  writer.paragraph(transcript.title, STYLES.title);
  if (transcript.date) writer.paragraph(transcript.date, STYLES.date);

  if (transcript.participants.length) {
    writer.paragraph("Participants", STYLES.section, STYLES.participant.leading * 2);
    writer.participantTable(
      transcript.participants.map((p) => {
        const role = [p.title, p.affiliation].filter(Boolean).join(", ");
        return role ? `${p.name} - ${role}` : p.name;
      }),
    );
    writer.addPage();
  }

  for (const section of transcript.sections) {
    writer.paragraph(section.name, STYLES.section, writer.heightOf(STYLES.speaker, 1) + STYLES.body.leading * 2);
    for (const speaker of section.speakers) {
      // Keep the speaker name with the start of what they said (up to 6 lines).
      const firstLines = Math.min(writer.wrap(speaker.paragraphs[0], STYLES.body).length, 6);
      writer.paragraph(speaker.label, STYLES.speaker, STYLES.speaker.spaceAfter + firstLines * STYLES.body.leading);
      for (const text of speaker.paragraphs) writer.paragraph(text, STYLES.body);
    }
  }

  writer.drawFooters();
  return doc.save();
}
