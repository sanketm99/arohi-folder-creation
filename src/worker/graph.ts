import { BUILTIN_COUNTRIES, countryFolder, isRestOfWorld, type Country } from "../shared/countries";
import type { DocumentKind } from "../shared/naming";
import { requireEnv, type Env } from "./env";
import { HttpError, upstreamStatus } from "./errors";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

/** Microsoft Graph's single-request upload limit. */
export const MAX_SIMPLE_UPLOAD_BYTES = 250 * 1024 * 1024;

/** Standard folder layout created under every company folder, parents before children. */
const COMPANY_SUBFOLDERS = [
  "Analysis",
  "Analysis/Factset Model - Company Primer",
  "Company Reports",
  "Company Reports/Annual Filings",
  "Company Reports/Presentations",
  "Company Reports/Quarterly Filings",
  "Company Reports/Quarterly Filings/Results",
  "Company Reports/Quarterly Filings/Transcript",
  "Industry",
  "Industry/Kavi",
  "Industry/Third Bridge",
  "Meeting Notes",
  "Result Notes",
  "Sell Side Reports",
];

const UPLOAD_FOLDERS: Record<DocumentKind, string> = {
  annual: "Company Reports/Annual Filings",
  results: "Company Reports/Quarterly Filings/Results",
  presentations: "Company Reports/Presentations",
  transcripts: "Company Reports/Quarterly Filings/Transcript",
};

interface DriveItem {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
}

let tokenCache: { key: string; value: string; expiresAt: number } | undefined;

async function accessToken(env: Env): Promise<string> {
  const tenantId = requireEnv(env, "MS_TENANT_ID");
  const clientId = requireEnv(env, "MS_CLIENT_ID");
  const clientSecret = requireEnv(env, "MS_CLIENT_SECRET");

  const key = `${tenantId}:${clientId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.value;
  }

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  if (!response.ok) {
    throw new HttpError(
      upstreamStatus(response.status),
      `Microsoft sign-in failed (HTTP ${response.status}). Check the SharePoint app credentials.`,
    );
  }
  const data = await response.json<{ access_token: string; expires_in: number }>();
  tokenCache = { key, value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function graphFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await accessToken(env)}`);
  return fetch(url, { ...init, headers });
}

async function graphError(response: Response, action: string): Promise<HttpError> {
  let detail = "";
  try {
    const body = await response.json<{ error?: { message?: string } }>();
    detail = body.error?.message ?? "";
  } catch {
    // Non-JSON error body.
  }
  return new HttpError(
    upstreamStatus(response.status),
    `${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
  );
}

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function resolveDrive(env: Env, country: Country): { driveId: string; countryFolder: string } {
  const folder = countryFolder(country);
  if (country === "India") return { driveId: requireEnv(env, "INDIA_DRIVE_ID"), countryFolder: folder };
  if (country === "China" || country === "Hong Kong") {
    return { driveId: requireEnv(env, "CHINAHK_DRIVE_ID"), countryFolder: folder };
  }
  return { driveId: requireEnv(env, "ROW_DRIVE_ID"), countryFolder: folder };
}

/**
 * Extra countries are not stored anywhere: the folders in the Rest of World library are
 * the list. Folders that are not countries are filtered out — names starting with "_",
 * the folders of built-in countries, and the names in EXCLUDED_COUNTRY_FOLDERS.
 */
const DEFAULT_EXCLUDED_FOLDERS = ["AI Trackers", "Li Auto", "Memory"];
const ROW_FOLDERS_TTL_MS = 60_000;
const MAX_ROW_FOLDER_PAGES = 5;

let rowFoldersCache: { value: string[]; expiresAt: number } | undefined;

function excludedFolders(env: Env): Set<string> {
  const configured = (env.EXCLUDED_COUNTRY_FOLDERS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const builtinFolders = BUILTIN_COUNTRIES.map((country) => countryFolder(country));
  return new Set(
    [...DEFAULT_EXCLUDED_FOLDERS, ...configured, ...builtinFolders].map((name) => name.toLowerCase()),
  );
}

/** Country folders in the ROW library that are not already built-in countries. */
export async function listExtraCountries(env: Env): Promise<string[]> {
  if (rowFoldersCache && rowFoldersCache.expiresAt > Date.now()) return rowFoldersCache.value;

  const driveId = requireEnv(env, "ROW_DRIVE_ID");
  const skip = excludedFolders(env);
  const found: string[] = [];
  let url: string | undefined =
    `${GRAPH_ROOT}/drives/${driveId}/root/children?$top=200&$select=name,folder`;

  for (let page = 0; url && page < MAX_ROW_FOLDER_PAGES; page++) {
    const response = await graphFetch(env, url);
    if (!response.ok) throw await graphError(response, "Listing the SharePoint country folders");
    const payload = await response.json<{
      value?: { name?: string; folder?: unknown }[];
      "@odata.nextLink"?: string;
    }>();
    for (const item of payload.value ?? []) {
      const name = item.name ?? "";
      if (!item.folder || !name || name.startsWith("_") || skip.has(name.toLowerCase())) continue;
      found.push(name);
    }
    url = payload["@odata.nextLink"];
  }

  const value = found.sort((a, b) => a.localeCompare(b));
  rowFoldersCache = { value, expiresAt: Date.now() + ROW_FOLDERS_TTL_MS };
  return value;
}

/** True when a folder of this name is deliberately kept out of the country dropdown. */
export function isExcludedFolder(env: Env, name: string): boolean {
  return excludedFolders(env).has(name.toLowerCase()) || name.startsWith("_");
}

/**
 * Creates the top-level folder for a newly added country (always on the ROW drive).
 * Returns false when a folder of that name already exists, so the caller can report it
 * rather than silently doing nothing.
 */
export async function createCountryFolder(env: Env, country: Country): Promise<boolean> {
  if (!isRestOfWorld(country)) throw new HttpError(400, "That country already has its own SharePoint library.");
  const created = await createFolder(env, requireEnv(env, "ROW_DRIVE_ID"), "", countryFolder(country));
  rowFoldersCache = undefined;
  return created !== null;
}

/** Creates a folder. Returns the new item, or null when a folder with that name already exists. */
async function createFolder(env: Env, driveId: string, parentPath: string, name: string): Promise<DriveItem | null> {
  const url = parentPath
    ? `${GRAPH_ROOT}/drives/${driveId}/root:/${encodePath(parentPath)}:/children`
    : `${GRAPH_ROOT}/drives/${driveId}/root/children`;
  const response = await graphFetch(env, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  });
  if (response.status === 409) return null;
  if (!response.ok) throw await graphError(response, `Creating SharePoint folder "${name}"`);
  return response.json<DriveItem>();
}

async function getItem(env: Env, driveId: string, path: string): Promise<DriveItem | null> {
  const response = await graphFetch(env, `${GRAPH_ROOT}/drives/${driveId}/root:/${encodePath(path)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await graphError(response, "Reading SharePoint folder");
  return response.json<DriveItem>();
}

export interface PreparedFolder {
  folderPath: string;
  existed: boolean;
}

/**
 * Creates <Country>/<Company> and the standard sub-folders. Refuses to continue when the
 * company folder already exists unless allowExisting is set (testing only).
 * Uses at most ~18 Graph requests, within the Workers free-plan subrequest limit.
 */
export async function prepareCompanyFolder(
  env: Env,
  country: Country,
  company: string,
  allowExisting: boolean,
): Promise<PreparedFolder> {
  const { driveId, countryFolder } = resolveDrive(env, country);
  const companyPath = `${countryFolder}/${company}`;

  await createFolder(env, driveId, "", countryFolder);
  let companyItem = await createFolder(env, driveId, countryFolder, company);
  const existed = companyItem === null;
  if (existed) {
    if (!allowExisting) {
      throw new HttpError(
        409,
        `The SharePoint folder "${companyPath}" already exists. The run was stopped to prevent duplicates.`,
      );
    }
    companyItem = await getItem(env, driveId, companyPath);
  }

  for (const subfolder of COMPANY_SUBFOLDERS) {
    const slash = subfolder.lastIndexOf("/");
    const parent = slash === -1 ? companyPath : `${companyPath}/${subfolder.slice(0, slash)}`;
    await createFolder(env, driveId, parent, subfolder.slice(slash + 1));
  }

  return { folderPath: companyPath, existed };
}

export interface UploadedFile {
  name: string;
  webUrl: string | null;
  size: number;
}

export async function uploadFile(
  env: Env,
  country: Country,
  company: string,
  kind: DocumentKind,
  fileName: string,
  body: ReadableStream | ArrayBuffer,
): Promise<UploadedFile> {
  const { driveId, countryFolder } = resolveDrive(env, country);
  const path = `${countryFolder}/${company}/${UPLOAD_FOLDERS[kind]}/${fileName}`;
  const response = await graphFetch(env, `${GRAPH_ROOT}/drives/${driveId}/root:/${encodePath(path)}:/content`, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body,
  });
  if (!response.ok) throw await graphError(response, `Uploading "${fileName}" to SharePoint`);
  const item = await response.json<DriveItem>();
  return { name: item.name, webUrl: item.webUrl ?? null, size: item.size ?? 0 };
}
