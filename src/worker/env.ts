import { HttpError } from "./errors";

export interface Env {
  ASSETS: Fetcher;

  APP_MODE?: string;
  ALLOW_UNAUTHENTICATED?: string;

  /** Microsoft Entra ID single sign-on. Tenant falls back to MS_TENANT_ID. */
  AUTH_TENANT_ID?: string;
  AUTH_CLIENT_ID?: string;
  AUTH_CLIENT_SECRET?: string;
  /** Only needed when the sign-in redirect URI is not <site>/auth/callback. */
  AUTH_REDIRECT_URI?: string;
  /** Signs this app's own session cookie. Any long random string. */
  SESSION_SECRET?: string;
  /** Optional allow-list, e.g. "arohi.com". Empty means anyone in the tenant. */
  ALLOWED_EMAIL_DOMAINS?: string;

  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;

  /** Comma-separated ROW folders that are not countries and must stay out of the dropdown. */
  EXCLUDED_COUNTRY_FOLDERS?: string;

  INDIA_DRIVE_ID?: string;
  CHINAHK_DRIVE_ID?: string;
  ROW_DRIVE_ID?: string;

  FACTSET_USERNAME?: string;
  FACTSET_API_KEY?: string;

  AROHI_API_KEY?: string;
  AROHI_ENTITY_SEARCH_URL?: string;
}

type ConfigName = Exclude<keyof Env, "ASSETS">;

export function requireEnv(env: Env, name: ConfigName): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new HttpError(500, `The server is missing the ${name} setting. Contact the system administrator.`);
  }
  return value;
}

export type AppMode = "development" | "uat" | "production";

export function appMode(env: Env): AppMode {
  const mode = (env.APP_MODE ?? "").trim().toLowerCase();
  return mode === "development" || mode === "uat" ? mode : "production";
}
