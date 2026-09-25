import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  ENABLED_DOCUMENT_KINDS,
  FileNameRegistry,
  type DocumentKind,
} from "../shared/naming";
import { buildTranscriptPdf } from "./transcriptPdf";
import { parseTranscriptXml } from "./transcriptXml";

interface AppConfig {
  mode: "development" | "uat" | "production";
  countries: string[];
  defaultCountry: string;
  user: { name: string; email: string };
}

interface PrepareResult {
  entity: { id: string; name: string };
  company: string;
  country: string;
  folderPath: string;
  existed: boolean;
}

interface DocumentItem {
  id: string;
  title: string;
  url: string;
}

interface DocumentList {
  items: DocumentItem[];
  skipped: number;
  excluded: number;
}

interface UploadedFile {
  name: string;
  webUrl: string | null;
  size: number;
}

type StepName = "setup" | DocumentKind;
type StepState = "" | "active" | "done" | "failed";

/** Documents processed in parallel. Each one is a separate, small Worker request. */
const CONCURRENCY = 3;

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const ui = {
  form: el<HTMLFormElement>("form"),
  company: el<HTMLInputElement>("company"),
  country: el<HTMLSelectElement>("country"),
  addCountryToggle: el<HTMLButtonElement>("addCountryToggle"),
  addCountryRow: el("addCountryRow"),
  newCountry: el<HTMLInputElement>("newCountry"),
  addCountry: el<HTMLButtonElement>("addCountry"),
  cancelCountry: el<HTMLButtonElement>("cancelCountry"),
  addCountryStatus: el("addCountryStatus"),
  topbar: el("topbar"),
  userName: el("userName"),
  userEmail: el("userEmail"),
  userInitials: el("userInitials"),
  testingOptions: el("testingOptions"),
  allowExisting: el<HTMLInputElement>("allowExisting"),
  start: el<HTMLButtonElement>("start"),
  status: el("status"),
  runPanel: el("runPanel"),
  bar: el("bar"),
  found: el("found"),
  uploaded: el("uploaded"),
  progress: el("progress"),
  errors: el("errors"),
  folderLink: el("folderLink"),
  log: el("log"),
};

// --- API -----------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(path, { ...init, credentials: "same-origin", redirect: "error" });
    } catch {
      if (attempt >= attempts) {
        throw new ApiError("Could not reach the server. Check your connection, or reload the page to sign in again.", 0);
      }
      await delay(attempt * 2000);
      continue;
    }
    if (response.ok) return response;
    if (RETRYABLE.has(response.status) && attempt < attempts) {
      await delay(attempt * 2000);
      continue;
    }
    throw new ApiError(await errorMessage(response), response.status);
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return `Request failed (HTTP ${response.status}).`;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new ApiError("Unexpected response from the server. Reload the page to sign in again.", response.status);
  }
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown, attempts = 3): Promise<T> {
  const response = await call(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    attempts,
  );
  return readJson<T>(response);
}

// --- UI helpers ----------------------------------------------------------------------

function setStep(step: StepName, state: StepState): void {
  const element = el(`step-${step}`);
  element.className = state ? `step ${state}` : "step";
  const note = element.querySelector<HTMLElement>(".step-status");
  if (note) note.textContent = STEP_STATUS_TEXT[state];
}

/** The dot colours alone cannot tell "done" from "failed" — the words do. */
const STEP_STATUS_TEXT: Record<StepState, string> = {
  "": "Waiting",
  active: "Running",
  done: "Done",
  failed: "Not collected",
};

function log(message: string, level: "" | "success" | "error" = ""): void {
  const line = document.createElement("div");
  line.textContent = message;
  if (level) line.className = level;
  const nearBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 40;
  ui.log.append(line);
  if (nearBottom) ui.log.scrollTop = ui.log.scrollHeight;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Stats {
  found: number;
  processed: number;
  uploaded: number;
  errors: number;
}

function render(stats: Stats, listingDone: boolean): void {
  ui.found.textContent = String(stats.found);
  ui.uploaded.textContent = String(stats.uploaded);
  ui.progress.textContent = `${stats.processed} / ${stats.found}`;
  ui.errors.textContent = String(stats.errors);
  const percent = !listingDone ? 5 : stats.found === 0 ? 100 : 10 + (90 * stats.processed) / stats.found;
  ui.bar.style.width = `${Math.min(100, percent)}%`;
}

async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}

// --- Document processing -------------------------------------------------------------

async function transferDocument(
  target: PrepareResult,
  kind: DocumentKind,
  item: DocumentItem,
  names: FileNameRegistry,
): Promise<UploadedFile> {
  const fileName = names.claim(item.title, item.id);
  return postJson<UploadedFile>("/api/transfer", {
    company: target.company,
    country: target.country,
    kind,
    url: item.url,
    fileName,
  });
}

async function processTranscript(target: PrepareResult, item: DocumentItem, names: FileNameRegistry): Promise<UploadedFile> {
  const xmlResponse = await call("/api/factset/transcript", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: item.url }),
  });
  const xml = new DOMParser().parseFromString(await xmlResponse.text(), "application/xml");
  const transcript = parseTranscriptXml(xml, item.title);
  const fileName = names.claim(transcript.title, item.id);
  const pdf = await buildTranscriptPdf(transcript);

  const query = new URLSearchParams({ company: target.company, country: target.country, kind: "transcripts", fileName });
  const response = await call(`/api/upload?${query}`, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: new Blob([pdf as BlobPart], { type: "application/pdf" }),
  });
  return readJson<UploadedFile>(response);
}

// --- Run -----------------------------------------------------------------------------

let running = false;

async function run(): Promise<void> {
  const company = ui.company.value.trim();
  if (!company) {
    ui.status.textContent = "Enter a company name.";
    ui.company.focus();
    return;
  }

  running = true;
  ui.start.disabled = true;
  ui.status.classList.remove("error");
  ui.runPanel.hidden = false;
  ui.log.replaceChildren();
  ui.folderLink.hidden = true;
  (["setup", ...DOCUMENT_KINDS] as StepName[]).forEach((step) => setStep(step, ""));
  // Hide the step cards for sources that are switched off.
  for (const kind of DOCUMENT_KINDS) {
    el(`step-${kind}`).hidden = !ENABLED_DOCUMENT_KINDS.includes(kind);
  }

  const stats: Stats = { found: 0, processed: 0, uploaded: 0, errors: 0 };
  let currentStep: StepName = "setup";
  render(stats, false);

  try {
    setStep("setup", "active");
    ui.status.textContent = "Preparing…";
    log(`Starting research for ${company} (${ui.country.value}). Finding the company in FactSet…`);

    // Not retried: a retry after a partial success would report the folder as already existing.
    const target = await postJson<PrepareResult>(
      "/api/prepare",
      { company, country: ui.country.value, allowExisting: ui.allowExisting.checked },
      1,
    );
    log(`FactSet matched ${target.entity.name} (${target.entity.id}).`, "success");
    log(
      target.existed
        ? `Using the existing SharePoint folder ${target.folderPath}.`
        : `Created SharePoint folder ${target.folderPath}.`,
      "success",
    );
    // Deliberately not a link: SharePoint's own folder URLs did not open reliably here,
    // so the path is shown as text for the user to navigate to themselves.
    ui.folderLink.textContent = `Uploading to ${target.folderPath}`;
    ui.folderLink.hidden = false;

    ui.status.textContent = "Listing FactSet documents…";
    const lists = new Map<DocumentKind, DocumentItem[]>();
    const unavailable = new Set<DocumentKind>();
    for (const kind of ENABLED_DOCUMENT_KINDS) {
      // One source being unavailable (for example not included in the FactSet
      // subscription) must not stop the others.
      try {
        const list = await postJson<DocumentList>("/api/documents", { entityId: target.entity.id, kind });
        lists.set(kind, list.items);
        stats.found += list.items.length;
        const notes = [
          list.excluded ? `${list.excluded} non-annual documents ignored` : "",
          list.skipped ? `${list.skipped} without a download link` : "",
        ].filter(Boolean);
        log(`${DOCUMENT_KIND_LABELS[kind]}: ${list.items.length} found${notes.length ? ` (${notes.join(", ")})` : ""}.`);
      } catch (error) {
        unavailable.add(kind);
        stats.errors++;
        setStep(kind, "failed");
        log(`${DOCUMENT_KIND_LABELS[kind]}: skipped — ${describe(error)}`, "error");
      }
      render(stats, false);
    }
    setStep("setup", "done");
    render(stats, true);

    for (const kind of ENABLED_DOCUMENT_KINDS) {
      const items = lists.get(kind) ?? [];
      currentStep = kind;
      if (unavailable.has(kind)) continue;
      if (!items.length) {
        setStep(kind, "done");
        continue;
      }

      setStep(kind, "active");
      const names = new FileNameRegistry();
      let failures = 0;

      await runPool(items, CONCURRENCY, async (item) => {
        ui.status.textContent = `Uploading ${DOCUMENT_KIND_LABELS[kind].toLowerCase()} (${stats.processed + 1} of ${stats.found})…`;
        try {
          const file = kind === "transcripts"
            ? await processTranscript(target, item, names)
            : await transferDocument(target, kind, item, names);
          stats.uploaded++;
          log(`Uploaded ${file.name}`, "success");
        } catch (error) {
          stats.errors++;
          failures++;
          log(`Could not upload "${item.title}": ${describe(error)}`, "error");
        } finally {
          stats.processed++;
          render(stats, true);
        }
      });

      setStep(kind, failures ? "failed" : "done");
    }

    if (unavailable.size) {
      log(`Not collected: ${[...unavailable].map((kind) => DOCUMENT_KIND_LABELS[kind].toLowerCase()).join(", ")}.`, "error");
    }
    if (stats.found === 0 && !unavailable.size) {
      ui.status.textContent = "Completed — FactSet has no documents for this company.";
    } else if (stats.errors) {
      ui.status.textContent = `Completed with ${stats.errors} error(s).`;
      log(`Finished: ${stats.uploaded} uploaded, ${stats.errors} failed. Review the errors above.`, "error");
    } else {
      ui.status.textContent = "Completed successfully.";
      log(`All ${stats.uploaded} documents were uploaded to SharePoint.`, "success");
    }
  } catch (error) {
    setStep(currentStep, "failed");
    ui.status.textContent = "Stopped.";
    log(describe(error), "error");
  } finally {
    running = false;
    ui.start.disabled = false;
  }
}

// --- Startup -------------------------------------------------------------------------

window.addEventListener("beforeunload", (event) => {
  if (running) event.preventDefault();
});

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!running) void run();
});

function showUser(user: { name: string; email: string }): void {
  ui.userName.textContent = user.name;
  ui.userEmail.textContent = user.email;
  ui.userInitials.textContent = initialsOf(user.name || user.email);
  ui.topbar.hidden = false;
}

function initialsOf(name: string): string {
  const words = name.replace(/[^\p{L}\s.'-]/gu, " ").split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function fillCountries(countries: string[], selected: string): void {
  ui.country.replaceChildren(...countries.map((country) => new Option(country, country, false, country === selected)));
}

function showAddCountry(show: boolean): void {
  ui.addCountryRow.hidden = !show;
  ui.addCountryToggle.hidden = show;
  ui.addCountryStatus.textContent = "";
  ui.addCountryStatus.classList.remove("error");
  if (show) ui.newCountry.focus();
  else ui.newCountry.value = "";
}

async function addCountry(): Promise<void> {
  const name = ui.newCountry.value.trim();
  if (!name) {
    ui.newCountry.focus();
    return;
  }
  ui.addCountry.disabled = true;
  ui.addCountryStatus.classList.remove("error");
  ui.addCountryStatus.textContent = "Adding…";
  try {
    const result = await postJson<{ name: string; countries: string[] }>("/api/countries", { name }, 1);
    fillCountries(result.countries, result.name);
    showAddCountry(false);
    ui.status.textContent = `Added ${result.name}. Its folder is ready in the Rest of World library.`;
  } catch (error) {
    ui.addCountryStatus.textContent = describe(error);
    ui.addCountryStatus.classList.add("error");
  } finally {
    ui.addCountry.disabled = false;
  }
}

ui.addCountryToggle.addEventListener("click", () => showAddCountry(true));
ui.cancelCountry.addEventListener("click", () => showAddCountry(false));
ui.addCountry.addEventListener("click", () => void addCountry());
ui.newCountry.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addCountry();
  }
});

async function init(): Promise<void> {
  try {
    const config = await readJson<AppConfig>(await call("/api/config", { method: "GET" }));
    showUser(config.user);
    fillCountries(config.countries, config.defaultCountry);
    ui.testingOptions.hidden = config.mode === "production";
    ui.start.disabled = false;
    ui.status.textContent = "Ready";
  } catch (error) {
    ui.status.textContent = describe(error);
    ui.status.classList.add("error");
  }
}

void init();
