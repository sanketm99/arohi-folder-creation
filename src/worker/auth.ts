import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
import { appMode, requireEnv, type Env } from "./env";
import { HttpError } from "./errors";

/**
 * Microsoft Entra ID single sign-on (OpenID Connect authorization code flow with PKCE).
 *
 * The code exchange happens on the server with the client secret, so no Microsoft token
 * ever reaches the browser. The browser only holds our own signed session cookie.
 */

const SESSION_COOKIE = "cr_session";
const FLOW_COOKIE = "cr_auth";
const SESSION_HOURS = 8;
const FLOW_MINUTES = 10;

export interface User {
  id: string;
  name: string;
  email: string;
}

// --- Cookies ---------------------------------------------------------------------------

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function cookieHeader(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const flags = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

function isSecure(url: URL): boolean {
  return url.protocol === "https:";
}

// --- Our own signed tokens -------------------------------------------------------------

function sessionKey(env: Env): Uint8Array {
  return new TextEncoder().encode(requireEnv(env, "SESSION_SECRET"));
}

async function sign(env: Env, payload: Record<string, unknown>, expires: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(sessionKey(env));
}

async function verify<T>(env: Env, token: string): Promise<T | undefined> {
  try {
    const { payload } = await jwtVerify(token, sessionKey(env));
    return payload as T;
  } catch {
    return undefined;
  }
}

// --- Entra endpoints --------------------------------------------------------------------

interface OpenIdConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

let metadataCache: { tenant: string; value: OpenIdConfig } | undefined;
let jwksCache: { uri: string; keySet: ReturnType<typeof createRemoteJWKSet> } | undefined;

async function openIdConfig(env: Env): Promise<OpenIdConfig> {
  const tenant = authTenant(env);
  if (metadataCache?.tenant === tenant) return metadataCache.value;
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`,
  );
  if (!response.ok) throw new HttpError(503, "Could not reach Microsoft sign-in. Please try again.");
  const value = await response.json<OpenIdConfig>();
  metadataCache = { tenant, value };
  return value;
}

/**
 * Sign-in uses its own AUTH_* settings when present, otherwise the existing MS_*
 * SharePoint app registration. Reusing it only needs a Web redirect URI added in Entra;
 * signing in grants users nothing beyond their own name and email.
 */
function authTenant(env: Env): string {
  return (env.AUTH_TENANT_ID ?? "").trim() || requireEnv(env, "MS_TENANT_ID");
}

function authClientId(env: Env): string {
  return (env.AUTH_CLIENT_ID ?? "").trim() || requireEnv(env, "MS_CLIENT_ID");
}

function authClientSecret(env: Env): string {
  return (env.AUTH_CLIENT_SECRET ?? "").trim() || requireEnv(env, "MS_CLIENT_SECRET");
}

function redirectUri(env: Env, url: URL): string {
  return (env.AUTH_REDIRECT_URI ?? "").trim() || `${url.origin}/auth/callback`;
}

// --- PKCE helpers ------------------------------------------------------------------------

function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// --- Who may sign in ----------------------------------------------------------------------

/** Optional allow-list: ALLOWED_EMAIL_DOMAINS="arohi.com,example.com". Empty means the whole tenant. */
export function isAllowedEmail(env: Env, email: string): boolean {
  const domains = (env.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (!domains.length) return true;
  const address = email.toLowerCase();
  return domains.some((domain) => address.endsWith(`@${domain}`));
}

// --- The flow -----------------------------------------------------------------------------

/** Step 1: send the user to Microsoft. */
export async function startLogin(env: Env, url: URL): Promise<Response> {
  const config = await openIdConfig(env);
  const verifier = randomString();
  const state = randomString(16);
  const nonce = randomString(16);

  const authorize = new URL(config.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: authClientId(env),
    response_type: "code",
    response_mode: "query",
    redirect_uri: redirectUri(env, url),
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();

  const flow = await sign(env, { state, nonce, verifier }, `${FLOW_MINUTES}m`);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": cookieHeader(FLOW_COOKIE, flow, FLOW_MINUTES * 60, isSecure(url)),
      "Cache-Control": "no-store",
    },
  });
}

/** Step 2: Microsoft sends the user back here with a code. */
export async function completeLogin(request: Request, env: Env, url: URL): Promise<Response> {
  const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (failure) return loginFailed(url, failure);

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const cookie = readCookie(request, FLOW_COOKIE);
  const flow = cookie ? await verify<{ state: string; nonce: string; verifier: string }>(env, cookie) : undefined;

  if (!code || !flow || !state || flow.state !== state) {
    return loginFailed(url, "The sign-in link expired. Please try again.");
  }

  const config = await openIdConfig(env);
  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: authClientId(env),
      client_secret: authClientSecret(env),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(env, url),
      code_verifier: flow.verifier,
      scope: "openid profile email",
    }),
  });
  if (!response.ok) {
    console.error(`Token exchange failed (HTTP ${response.status})`);
    return loginFailed(url, "Microsoft could not complete the sign-in. Please try again.");
  }

  const { id_token: idToken } = await response.json<{ id_token?: string }>();
  if (!idToken) return loginFailed(url, "Microsoft did not return a sign-in token.");

  if (!jwksCache || jwksCache.uri !== config.jwks_uri) {
    jwksCache = { uri: config.jwks_uri, keySet: createRemoteJWKSet(new URL(config.jwks_uri)) };
  }

  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, jwksCache.keySet, {
      issuer: config.issuer,
      audience: authClientId(env),
    });
    claims = verified.payload as Record<string, unknown>;
  } catch {
    return loginFailed(url, "The sign-in token could not be verified.");
  }
  if (claims.nonce !== flow.nonce) return loginFailed(url, "The sign-in token did not match this browser.");

  const email = String(claims.preferred_username ?? claims.email ?? "");
  const user: User = {
    id: String(claims.oid ?? claims.sub ?? ""),
    name: String(claims.name ?? email),
    email,
  };
  if (!isAllowedEmail(env, email)) {
    return loginFailed(url, `${email || "This account"} is not allowed to use this application.`);
  }

  const session = await sign(env, { ...user }, `${SESSION_HOURS}h`);
  const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
  // Two separate Set-Cookie headers: start the session, and drop the temporary flow cookie.
  headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, session, SESSION_HOURS * 3600, isSecure(url)));
  headers.append("Set-Cookie", cookieHeader(FLOW_COOKIE, "", 0, isSecure(url)));
  return new Response(null, { status: 302, headers });
}

export function logout(url: URL): Response {
  const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", 0, isSecure(url)));
  return new Response(null, { status: 302, headers });
}

function loginFailed(url: URL, message: string): Response {
  const target = new URL("/", url.origin);
  target.searchParams.set("error", message.slice(0, 200));
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
}

/** The signed-in user, or undefined. Development mode can skip sign-in entirely. */
export async function currentUser(request: Request, env: Env): Promise<User | undefined> {
  if (appMode(env) === "development" && env.ALLOW_UNAUTHENTICATED?.trim().toLowerCase() === "true") {
    return { id: "dev", name: "Development user", email: "dev@localhost" };
  }
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return undefined;
  const session = await verify<User & { exp: number }>(env, cookie);
  return session?.id ? { id: session.id, name: session.name, email: session.email } : undefined;
}

/** Same, but for API routes: refuses instead of returning undefined. */
export async function requireUser(request: Request, env: Env): Promise<User> {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Your session has ended. Reload the page to sign in again.");
  return user;
}
