import {
  annualReportTitle,
  contentUrl,
  isTrueAnnualFiling,
  presentationTitle,
  transcriptFallbackTitle,
  type DocumentKind,
  type FactSetDocument,
} from "../shared/naming";
import { requireEnv, type Env } from "./env";
import { HttpError, upstreamStatus } from "./errors";

const FILINGS_URL = "https://api.factset.com/content/global-filings/v2/search";
const TRANSCRIPTS_URL = "https://api.factset.com/content/events/v2/transcripts";
const INVESTOR_SLIDES_URL = "https://api.factset.com/content/events/v2/transcripts/investor-slides";

const PAGE_SIZE = 100;
/** Keeps one listing request well inside the free plan's 50-subrequest limit. */
const MAX_PAGES = 40;

const PRESENTATION_LINK_KEYS = [
  "investorSlidesLink", "investorSlideLink", "slidesLink", "presentationLink", "downloadLink",
  "transcriptLink", "storyLink", "filingsLink", "link", "url",
];

export interface DocumentItem {
  id: string;
  title: string;
  url: string;
}

export interface DocumentList {
  items: DocumentItem[];
  /** Documents without a download link. */
  skipped: number;
  /** Annual-form documents that are not actually annual reports. */
  excluded: number;
}

function basicAuth(env: Env): string {
  return `Basic ${btoa(`${requireEnv(env, "FACTSET_USERNAME")}:${requireEnv(env, "FACTSET_API_KEY")}`)}`;
}

function factSetError(status: number, action: string): HttpError {
  const hint = status === 401 || status === 403 ? " Check the FactSet username and API key." : "";
  return new HttpError(upstreamStatus(status), `${action} failed (HTTP ${status}).${hint}`);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function findEntity(env: Env, company: string): Promise<{ id: string; name: string }> {
  const url = new URL(requireEnv(env, "AROHI_ENTITY_SEARCH_URL"));
  url.searchParams.set("q", company);
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: { accept: "application/json", "API-KEY": requireEnv(env, "AROHI_API_KEY") },
  });
  if (!response.ok) {
    throw new HttpError(upstreamStatus(response.status), `Company search failed (HTTP ${response.status}).`);
  }
  const data = await response.json<{ results?: { entity_id?: string; name?: string }[] }>();
  const match = data.results?.[0];
  if (!match?.entity_id) {
    throw new HttpError(404, `No FactSet company found for "${company}".`);
  }
  return { id: match.entity_id, name: match.name ?? company };
}

async function collectPages(
  label: string,
  fetchPage: (offset: number) => Promise<Response>,
): Promise<FactSetDocument[]> {
  const documents: FactSetDocument[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetchPage(page * PAGE_SIZE);
    if (!response.ok) throw factSetError(response.status, `Listing FactSet ${label}`);
    const payload = await response.json<{ data?: { documents?: FactSetDocument[] }[] }>();
    const pageDocs = (payload.data ?? []).flatMap((entity) => entity.documents ?? []);
    documents.push(...pageDocs);
    if (pageDocs.length < PAGE_SIZE) return documents;
  }
  throw new HttpError(422, `FactSet returned more than ${MAX_PAGES * PAGE_SIZE} ${label}; this is not supported yet.`);
}

function filings(env: Env, entityId: string, formTypes: string): Promise<FactSetDocument[]> {
  const endDate = todayUtc().replaceAll("-", "");
  return collectPages("filings", (offset) => {
    const url = new URL(FILINGS_URL);
    url.search = new URLSearchParams({
      ids: entityId,
      startDate: "20150101",
      endDate,
      _paginationLimit: String(PAGE_SIZE),
      _paginationOffset: String(offset),
      timeZone: "America/New_York",
      _sort: "-filingsDateTime",
      sources: "FFR",
      formTypes,
      primaryId: "false",
    }).toString();
    return fetch(url, { headers: { Authorization: basicAuth(env), accept: "application/json" } });
  });
}

function events(env: Env, endpoint: string, label: string, entityId: string, startDate: string) {
  return collectPages(label, (offset) =>
    fetch(endpoint, {
      method: "POST",
      headers: { Authorization: basicAuth(env), accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        data: { ids: [entityId], startDate, endDate: todayUtc(), timeZone: "America/New_York", dateType: "uploadDateTime" },
        meta: { pagination: { limit: PAGE_SIZE, offset }, sort: ["-storyDateTime"] },
      }),
    }),
  );
}

function idOf(doc: FactSetDocument, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = doc[key];
    if (value !== null && value !== undefined && String(value)) return String(value);
  }
  return fallback;
}

export async function listDocuments(env: Env, entityId: string, kind: DocumentKind): Promise<DocumentList> {
  const result: DocumentList = { items: [], skipped: 0, excluded: 0 };
  const add = (id: string, title: string, url: string) => {
    if (url) result.items.push({ id, title, url });
    else result.skipped++;
  };

  switch (kind) {
    case "annual": {
      for (const doc of await filings(env, entityId, "A")) {
        if (!isTrueAnnualFiling(doc)) {
          result.excluded++;
          continue;
        }
        add(idOf(doc, ["documentId"], "annual"), annualReportTitle(doc), contentUrl(doc, ["filingsLink"]));
      }
      break;
    }
    case "results": {
      for (const doc of await filings(env, entityId, "Q,P")) {
        const id = idOf(doc, ["documentId"], "result");
        add(id, id, contentUrl(doc, ["filingsLink"]));
      }
      break;
    }
    case "presentations": {
      const seen = new Set<string>();
      const docs = await events(env, INVESTOR_SLIDES_URL, "investor presentations", entityId, "2015-01-01");
      for (const [index, doc] of docs.entries()) {
        const id = idOf(doc, ["reportId", "eventId", "documentId"], `presentation-${index}`);
        if (seen.has(id)) continue;
        seen.add(id);
        add(id, presentationTitle(doc, id), contentUrl(doc, PRESENTATION_LINK_KEYS));
      }
      break;
    }
    case "transcripts": {
      // One transcript per event, preferring the "Corrected" version over "Raw".
      const byEvent = new Map<string, FactSetDocument>();
      for (const doc of await events(env, TRANSCRIPTS_URL, "transcripts", entityId, "2020-01-01")) {
        const key = idOf(doc, ["eventId", "reportId"], "");
        const existing = byEvent.get(key);
        if (!existing || (doc.transcriptType === "Corrected" && existing.transcriptType !== "Corrected")) {
          byEvent.set(key, doc);
        }
      }
      for (const doc of byEvent.values()) {
        add(idOf(doc, ["reportId", "eventId"], "transcript"), transcriptFallbackTitle(doc), contentUrl(doc, ["transcriptsUrl"]));
      }
      break;
    }
  }
  return result;
}

function isFactSetHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "factset.com" || host.endsWith(".factset.com");
}

/** Only FactSet https URLs may be requested, so FactSet credentials never go anywhere else. */
export function parseFactSetUrl(value: unknown): URL {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && isFactSetHost(url.hostname)) return url;
    } catch {
      // Fall through.
    }
  }
  throw new HttpError(400, "The document link is not a FactSet link.");
}

/**
 * Downloads FactSet content. Redirects are followed manually so the FactSet credentials are
 * only ever sent to FactSet hosts (e.g. not to a pre-signed storage URL it redirects to).
 */
export async function fetchFactSetContent(env: Env, url: URL): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const headers = new Headers();
    if (isFactSetHost(current.hostname)) headers.set("Authorization", basicAuth(env));
    const response = await fetch(current, { headers, redirect: "manual" });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const next = location ? new URL(location, current) : null;
      if (!next || next.protocol !== "https:") {
        throw new HttpError(424, "FactSet returned an invalid redirect for this document.");
      }
      current = next;
      continue;
    }
    if (!response.ok) throw factSetError(response.status, "Downloading from FactSet");
    return response;
  }
  throw new HttpError(424, "FactSet redirected too many times for this document.");
}
