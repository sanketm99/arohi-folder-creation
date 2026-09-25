import {
  BUILTIN_COUNTRIES,
  DEFAULT_COUNTRY,
  isBuiltinCountry,
  normalizeNewCountry,
  sameCountry,
  countryFolder,
  type Country,
} from "../shared/countries";
import { isDocumentKind, sanitizeFilename, type DocumentKind } from "../shared/naming";
import { completeLogin, currentUser, logout, requireUser, startLogin } from "./auth";
import { appMode, type Env } from "./env";
import { HttpError } from "./errors";
import { fetchFactSetContent, findEntity, listDocuments, parseFactSetUrl } from "./factset";
import {
  MAX_SIMPLE_UPLOAD_BYTES,
  createCountryFolder,
  isExcludedFolder,
  listExtraCountries,
  prepareCompanyFolder,
  uploadFile,
} from "./graph";

const APP_VERSION = "2026.09.17-factset-cloudflare";
const MAX_JSON_BODY_CHARS = 16_000;
const MAX_TRANSCRIPT_PDF_BYTES = 50 * 1024 * 1024;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/auth/")) {
        rejectCrossSite(request, url);
        return await authRoute(request, env, url);
      }
      if (!url.pathname.startsWith("/api/")) {
        return await page(request, env, url);
      }

      rejectCrossSite(request, url);
      await requireUser(request, env);
      return await route(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status >= 500) console.error(`${request.method} ${url.pathname}: ${error.message}`);
        return json({ error: error.message }, error.status);
      }
      console.error(`${request.method} ${url.pathname}: unhandled error`, error);
      return json({ error: "Unexpected server error. Please try again." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** Sign-in routes. These are the only ones reachable without a session. */
async function authRoute(request: Request, env: Env, url: URL): Promise<Response> {
  switch (`${request.method} ${url.pathname}`) {
    case "GET /auth/login":
      return startLogin(env, url);
    case "GET /auth/callback":
      return completeLogin(request, env, url);
    case "POST /auth/logout":
      return logout(url);
    default:
      throw new HttpError(404, "Not found.");
  }
}

/**
 * Pages and assets. The app itself is only served to a signed-in user; everyone else
 * gets the sign-in page. Stylesheets and scripts carry no data, so they are served
 * either way — the sign-in page needs them too.
 */
async function page(request: Request, env: Env, url: URL): Promise<Response> {
  const isAppPage = url.pathname === "/" || url.pathname === "/index.html";
  // The raw pages are only ever served through this gate.
  if (url.pathname === "/login" || url.pathname === "/login.html") {
    return Response.redirect(new URL("/", url.origin).toString(), 302);
  }
  if (isAppPage && !(await currentUser(request, env))) {
    // Cloudflare serves "login.html" at "/login" (and redirects the .html form),
    // so ask for "/login" and follow one redirect to be safe in either setup.
    let login = await env.ASSETS.fetch(new Request(new URL("/login", url.origin), { method: "GET" }));
    const location = login.status >= 300 && login.status < 400 ? login.headers.get("location") : null;
    if (location) login = await env.ASSETS.fetch(new Request(new URL(location, url.origin), { method: "GET" }));
    if (!login.ok) throw new HttpError(500, "The sign-in page is missing from this deployment.");
    return new Response(login.body, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return env.ASSETS.fetch(request);
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  switch (`${request.method} ${url.pathname}`) {
    case "GET /api/config":
      return json({
        mode: appMode(env),
        version: APP_VERSION,
        countries: await allCountries(env),
        defaultCountry: DEFAULT_COUNTRY,
        user: await requireUser(request, env),
      });
    case "POST /api/countries":
      return handleAddCountry(request, env);
    case "POST /api/prepare":
      return handlePrepare(request, env);
    case "POST /api/documents":
      return handleDocuments(request, env);
    case "POST /api/transfer":
      return handleTransfer(request, env);
    case "POST /api/factset/transcript":
      return handleTranscriptXml(request, env);
    case "PUT /api/upload":
      return handleUpload(request, env, url);
    default:
      throw new HttpError(404, "Not found.");
  }
}

/**
 * The dropdown list: built-in countries plus the other country folders that already exist
 * in the Rest of World library. Nothing is stored — the folders are the list.
 */
async function allCountries(env: Env): Promise<string[]> {
  const extra = await listExtraCountries(env);
  return [...new Set([...BUILTIN_COUNTRIES, ...extra])].sort((a, b) => a.localeCompare(b));
}

/** Adds a country by creating its folder on the ROW drive. */
async function handleAddCountry(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const result = normalizeNewCountry(body.name);
  if (!result.ok) throw new HttpError(400, result.error);
  const name = result.name;

  const existing = await allCountries(env);
  if (existing.some((country) => sameCountry(country, name))) {
    throw new HttpError(409, `"${name}" is already in the list.`);
  }
  // Guard against a new name that would collide with an existing country's folder,
  // e.g. adding "US" when "United States" already writes to the US folder.
  const clash = existing.find((country) => sameCountry(countryFolder(country), name));
  if (clash) {
    throw new HttpError(409, `"${name}" is the SharePoint folder already used by "${clash}".`);
  }

  // Folders hidden from the dropdown (EXCLUDED_COUNTRY_FOLDERS, or names starting with "_")
  // would otherwise be "added" and then never appear.
  if (isExcludedFolder(env, name)) {
    throw new HttpError(409, `"${name}" is a Rest of World folder that is not treated as a country.`);
  }
  if (!(await createCountryFolder(env, name))) {
    throw new HttpError(409, `A folder named "${name}" already exists in the Rest of World library.`);
  }
  return json({ name, countries: await allCountries(env) });
}

/** Step 1: find the FactSet entity, then create the SharePoint folder structure. */
async function handlePrepare(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const rawCompany = requiredString(body.company, "Company name", 200);
  const company = companyFolderName(rawCompany);
  const country = await countryName(env, body.country);
  const allowExisting = appMode(env) !== "production" && body.allowExisting === true;

  // Look up FactSet first so a typo doesn't leave an empty folder behind in SharePoint.
  const entity = await findEntity(env, rawCompany);
  const folder = await prepareCompanyFolder(env, country, company, allowExisting);
  return json({ entity, company, country, ...folder });
}

/** Step 2: list one kind of FactSet document. */
async function handleDocuments(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const entityId = requiredString(body.entityId, "FactSet entity id", 40);
  if (!/^[A-Za-z0-9_-]+$/.test(entityId)) throw new HttpError(400, "Invalid FactSet entity id.");
  const kind = documentKind(body.kind);
  return json(await listDocuments(env, entityId, kind));
}

/** Step 3a: stream one FactSet PDF straight into SharePoint (annual reports, results, presentations). */
async function handleTransfer(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const company = companyFolderName(requiredString(body.company, "Company name", 200));
  const country = await countryName(env, body.country);
  const kind = documentKind(body.kind);
  if (kind === "transcripts") throw new HttpError(400, "Transcripts are converted in the browser and sent to /api/upload.");
  const fileName = pdfFileName(body.fileName);
  const source = parseFactSetUrl(body.url);

  const download = await fetchFactSetContent(env, source);
  const lengthHeader = download.headers.get("content-length");
  const encoding = download.headers.get("content-encoding");
  let payload: ReadableStream | ArrayBuffer;
  let length: number;

  if (download.body && lengthHeader && (!encoding || encoding === "identity")) {
    // Known size: stream without buffering. FixedLengthStream gives Graph a Content-Length.
    length = Number(lengthHeader);
    checkUploadSize(length);
    const { readable, writable } = new FixedLengthStream(length);
    download.body.pipeTo(writable).catch(() => undefined);
    payload = readable;
  } else {
    payload = await download.arrayBuffer();
    length = payload.byteLength;
    checkUploadSize(length);
  }

  return json(await uploadFile(env, country, company, kind, fileName, payload));
}

/** Step 3b: pass a FactSet transcript XML to the browser, which turns it into a PDF. */
async function handleTranscriptXml(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const download = await fetchFactSetContent(env, parseFactSetUrl(body.url));
  return new Response(download.body, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Step 3c: store a transcript PDF generated in the browser. */
async function handleUpload(request: Request, env: Env, url: URL): Promise<Response> {
  const company = companyFolderName(requiredString(url.searchParams.get("company"), "Company name", 200));
  const country = await countryName(env, url.searchParams.get("country"));
  const kind = documentKind(url.searchParams.get("kind"));
  if (kind !== "transcripts") throw new HttpError(400, "Only transcript PDFs can be uploaded directly.");
  const fileName = pdfFileName(url.searchParams.get("fileName"));

  const declared = Number(request.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0) throw new HttpError(411, "Upload size is required.");
  if (declared > MAX_TRANSCRIPT_PDF_BYTES) throw new HttpError(413, "The transcript PDF is too large.");

  const bytes = await request.arrayBuffer();
  if (!isPdf(bytes)) throw new HttpError(400, "The uploaded file is not a PDF.");
  return json(await uploadFile(env, country, company, kind, fileName, bytes));
}

// --- Validation helpers ---------------------------------------------------------------

/** Blocks cross-site form posts riding on the user's session cookie. */
function rejectCrossSite(request: Request, url: URL): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "Cross-site requests are not allowed.");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Cross-site requests are not allowed.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Expected a JSON request.");
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_CHARS) throw new HttpError(413, "Request is too large.");
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Fall through.
  }
  throw new HttpError(400, "Invalid JSON request.");
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, `${label} is required.`);
  if (text.length > maxLength) throw new HttpError(400, `${label} is too long.`);
  return text;
}

function companyFolderName(company: string): string {
  return sanitizeFilename(company, 120);
}

/** Accepts a built-in country, or one whose folder already exists in the ROW library. */
async function countryName(env: Env, value: unknown): Promise<Country> {
  if (isBuiltinCountry(value)) return value;
  if (typeof value === "string" && value) {
    const extra = await listExtraCountries(env);
    const match = extra.find((country) => sameCountry(country, value));
    if (match) return match;
  }
  throw new HttpError(400, "Choose a country from the list.");
}

function documentKind(value: unknown): DocumentKind {
  if (!isDocumentKind(value)) throw new HttpError(400, "Unknown document type.");
  return value;
}

function pdfFileName(value: unknown): string {
  const raw = requiredString(value, "File name", 300);
  return `${sanitizeFilename(raw.replace(/\.pdf$/i, ""))}.pdf`;
}

function checkUploadSize(length: number): void {
  if (!Number.isFinite(length) || length <= 0) throw new HttpError(424, "FactSet returned an empty file.");
  if (length > MAX_SIMPLE_UPLOAD_BYTES) throw new HttpError(413, "The document is larger than 250 MB and cannot be uploaded.");
}

function isPdf(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength));
  return String.fromCharCode(...head) === "%PDF-";
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
