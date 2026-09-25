/**
 * Runs the Worker on plain Node.js for local testing, for machines where Cloudflare's local
 * runtime (workerd, used by `npm run dev`) cannot run. Production still runs on Cloudflare.
 *
 * Differences from Cloudflare: no CPU/subrequest limits are enforced, and uploads are buffered
 * in memory instead of streamed.
 *
 * Usage: npm run dev:local   (reads settings from .dev.vars)
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import worker from "../src/worker/index";
import type { Env } from "../src/worker/env";

const ROOT = process.cwd();
const PUBLIC_DIR = resolve(ROOT, "public");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8790);

// --- Settings from .dev.vars ------------------------------------------------------------

function loadDevVars(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(path)) return vars;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    vars[key] = value;
  }
  return vars;
}

const devVarsPath = join(ROOT, ".dev.vars");
if (!existsSync(devVarsPath)) {
  console.error("Missing .dev.vars — copy .dev.vars.example to .dev.vars and fill it in.");
  process.exit(1);
}
const vars = loadDevVars(devVarsPath);

// --- Cloudflare-only APIs ---------------------------------------------------------------

/** On Node, a pass-through stream is enough; the fetch wrapper below sets the length. */
class LocalFixedLengthStream extends TransformStream {
  constructor(_length: number | bigint) {
    super();
  }
}
(globalThis as Record<string, unknown>).FixedLengthStream ??= LocalFixedLengthStream;

/** Node's fetch can't send a stream body without chunked encoding; buffer it so Content-Length is set. */
const nodeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.body instanceof ReadableStream) {
    init = { ...init, body: await new Response(init.body).arrayBuffer() };
  }
  return nodeFetch(input, init);
}) as typeof fetch;

// --- Static files (stands in for the ASSETS binding) -----------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const assets = {
  async fetch(input: RequestInfo | URL): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    let pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    // Like Cloudflare's asset handling: "/login" serves "login.html".
    if (!extname(pathname) && existsSync(resolve(PUBLIC_DIR, `.${pathname}.html`))) pathname += ".html";
    const filePath = resolve(PUBLIC_DIR, `.${pathname}`);
    if (!filePath.startsWith(PUBLIC_DIR + sep) || pathname.startsWith("/_")) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await readFile(filePath);
      return new Response(body, {
        headers: { "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream", "Cache-Control": "no-store" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

const env = { ...vars, ASSETS: assets } as unknown as Env;

// --- HTTP server ------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://${req.headers.host ?? `${HOST}:${PORT}`}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      duplex: "half",
    } as RequestInit);

    const started = Date.now();
    const response = await worker.fetch(request, env);
    const path = new URL(request.url).pathname;
    // Everything except static assets, so the sign-in flow is visible.
    if (!/\.(css|js|map|ico|png|svg|woff2?)$/.test(path)) {
      const extra = response.status >= 300 && response.status < 400 ? ` -> ${response.headers.get("location")?.slice(0, 80)}` : "";
      console.log(`${req.method} ${path} ${response.status}${extra} (${Date.now() - started} ms)`);
    }

    // Set-Cookie may appear more than once; Object.fromEntries would merge them into one
    // mangled header, so pass them through as an array.
    const responseHeaders: Record<string, string | string[]> = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) responseHeaders["set-cookie"] = cookies;
    res.writeHead(response.status, responseHeaders);
    if (response.body) Readable.fromWeb(response.body as never).pipe(res);
    else res.end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Local server error");
  }
});

server.listen(PORT, HOST, () => {
  const mode = vars.APP_MODE || "production";
  console.log(`Company Research running locally on Node.js: http://${HOST}:${PORT}  (APP_MODE=${mode})`);
  if (mode === "development" && vars.ALLOW_UNAUTHENTICATED === "true") {
    console.log("Sign-in check is OFF (local development only).");
  }
});
