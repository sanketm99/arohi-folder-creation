export interface Participant {
  name: string;
  title: string;
  affiliation: string;
}

export interface TranscriptSpeaker {
  label: string;
  paragraphs: string[];
}

export interface TranscriptSection {
  name: string;
  speakers: TranscriptSpeaker[];
}

export interface Transcript {
  title: string;
  date: string;
  participants: Participant[];
  sections: TranscriptSection[];
}

const ELEMENT_NODE = 1;

function localName(element: Element): string {
  return element.localName || element.nodeName.split(":").pop() || "";
}

function childElements(node: Node): Element[] {
  const result: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) result.push(child as Element);
  }
  return result;
}

/** All elements in document order, including the starting element. */
function* elementsFrom(start: Element): Generator<Element> {
  const stack: Element[] = [start];
  while (stack.length) {
    const element = stack.pop()!;
    yield element;
    const children = childElements(element);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…",
};

/** FactSet sometimes double-escapes entities; decode what is left after XML parsing. */
function unescapeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function normalize(value: string): string {
  return unescapeHtml(value).replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function textOf(element: Element): string {
  return normalize(element.textContent ?? "");
}

function attr(element: Element, name: string): string {
  return normalize(element.getAttribute(name) ?? "");
}

/**
 * Reads a FactSet transcript XML document, keeping the full transcript in source order.
 * Works with the browser DOMParser and with @xmldom/xmldom (tests).
 */
export function parseTranscriptXml(doc: Document, fallbackTitle = "FactSet Transcript"): Transcript {
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The transcript from FactSet could not be read (invalid XML).");
  }

  let title = "";
  let date = "";
  const participants = new Map<string, Participant>();
  let body: Element | undefined;

  for (const element of elementsFrom(root)) {
    switch (localName(element)) {
      case "title":
        if (!title) title = textOf(element);
        break;
      case "date":
        if (!date) date = textOf(element);
        break;
      case "participant": {
        const id = element.getAttribute("id") ?? "";
        participants.set(id, {
          name: textOf(element) || `Speaker ${id}`,
          title: attr(element, "title"),
          affiliation: attr(element, "affiliation"),
        });
        break;
      }
      case "body":
        body ??= element;
        break;
    }
  }

  if (!body) throw new Error("The FactSet transcript has no body.");

  const sections: TranscriptSection[] = [];
  for (const sectionEl of childElements(body)) {
    if (localName(sectionEl) !== "section") continue;
    const section: TranscriptSection = { name: attr(sectionEl, "name") || "Transcript", speakers: [] };

    for (const speakerEl of childElements(sectionEl)) {
      if (localName(speakerEl) !== "speaker") continue;
      const id = speakerEl.getAttribute("id") ?? "";
      const person = participants.get(id) ?? { name: `Speaker ${id}`, title: "", affiliation: "" };
      const role = [person.title, person.affiliation].filter(Boolean).join(", ");

      const paragraphs = [...elementsFrom(speakerEl)]
        .filter((el) => localName(el) === "p")
        .map(textOf)
        .filter(Boolean);
      if (paragraphs.length) {
        section.speakers.push({ label: role ? `${person.name} (${role})` : person.name, paragraphs });
      }
    }
    sections.push(section);
  }

  return {
    title: title || fallbackTitle,
    date,
    participants: [...participants.values()],
    sections,
  };
}
