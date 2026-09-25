# Company Research

Collects a company's FactSet research documents and uploads them to SharePoint:

| FactSet source | SharePoint folder |
| --- | --- |
| Annual reports (headline says "Annual Report", since 2015) | `Company Reports/Annual Filings` |
| Quarterly / periodic filings (since 2015) | `Company Reports/Quarterly Filings/Results` |
| Investor presentations (since 2015) | `Company Reports/Presentations` |
| Earnings-call transcripts (since 2020, "Corrected" preferred), converted to PDF | `Company Reports/Quarterly Filings/Transcript` |

It creates the standard folder layout under `<Country>/<Company>` and stops if that company folder already exists.

## Countries

The dropdown lists the built-in countries plus every other country folder already in the Rest of World library — nothing is stored by the app, the folders themselves are the list. India, China and Hong Kong have their own libraries; everything else uses Rest of World.

Some countries are named differently in SharePoint, so the app maps them (see `src/shared/countries.ts`): Sri Lanka → `SriLanka`, United Arab Emirates → `UAE`, United States → `US`, China → `China_A_Shares`, Hong Kong → `HongKong`.

**"+ Add a country"** on the page creates a new top-level folder in the Rest of World library, and it then appears for everyone. It refuses names that duplicate an existing country or clash with an existing folder (for example `US`). Non-country folders are filtered out by `EXCLUDED_COUNTRY_FOLDERS`.

It runs as a single **Cloudflare Worker** (free plan) that serves the web page and a small API. Kavi and Third Bridge from the original Python tool are not included yet.

## How it works

The Workers free plan allows only 10 ms of CPU and 50 outgoing requests per request, so a run is split into many small requests driven by the browser page:

1. `POST /api/prepare`: finds the FactSet entity (Arohi entity search), then creates the SharePoint folders.
2. `POST /api/documents`: lists one document type from FactSet.
3. For each document, one of:
   - `POST /api/transfer`: the Worker streams the PDF from FactSet straight into SharePoint.
   - `POST /api/factset/transcript` then `PUT /api/upload`: the browser turns the transcript XML into a PDF (CPU-heavy), and the Worker stores it.

All secrets stay in the Worker. The browser never sees FactSet or Microsoft credentials, and the Worker only sends FactSet credentials to `*.factset.com` hosts.

> **Keep the tab open while a run is in progress.** The browser drives the run, so closing the tab stops it. The page warns before closing.

## Branding

The UI follows the Arohi brand guidelines. `public/arohi.css` is the design-system stylesheet, copied in unchanged (snapshot pinned 2026-09-05) — **extend it in `public/styles.css`, don't edit its tokens**.

- **Fonts:** Source Serif Pro for headings, Source Sans Pro for body, loaded from Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com` are allowed in `public/_headers`). Falls back to Georgia / Arial.
- **Colours:** the approved palette only — navy `#1b1d32`, sand, gold `#e98200`, sunrise, black, white. No custom colours. Errors are shown in **gold, not red**, so they still belong to the page.
- **Status:** step states are distinguished by words ("Done", "Running", "Not collected") as well as colour, since the palette has no green/red pair.

```
src/worker/   Cloudflare Worker: API routes, auth, FactSet, SharePoint (Microsoft Graph)
src/client/   Browser app: run orchestration, transcript XML → PDF (pdf-lib)
src/shared/   Naming rules and country list used by both
public/       Static page (index.html, arohi.css, styles.css, _headers); app.js is built
tests/        Vitest tests
```

## Configuration

Every setting is an environment variable. Nothing sensitive is in the repository.

| Name | Purpose |
| --- | --- |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Microsoft Graph app registration with SharePoint write access |
| `INDIA_DRIVE_ID`, `CHINAHK_DRIVE_ID`, `ROW_DRIVE_ID` | SharePoint drive IDs (India / China + Hong Kong / all other countries) |
| `FACTSET_USERNAME`, `FACTSET_API_KEY` | FactSet API credentials |
| `AROHI_API_KEY`, `AROHI_ENTITY_SEARCH_URL` | Arohi entity search (company name → FactSet entity id) |
| `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `AUTH_TENANT_ID` | Optional. A separate Entra registration for signing users in; by default the `MS_*` one is reused (see below) |
| `AUTH_REDIRECT_URI` | Optional. Only when the redirect URI is not `<site>/auth/callback` |
| `SESSION_SECRET` | Signs the app's session cookie. Any long random string |
| `ALLOWED_EMAIL_DOMAINS` | Optional. e.g. `arohi.com`. Empty means anyone in the tenant |
| `EXCLUDED_COUNTRY_FOLDERS` | Optional. Comma-separated folders in the Rest of World library that are not countries, keeping them out of the dropdown. Folders starting with `_` are always ignored. Defaults to `AI Trackers,Li Auto,Memory`. |
| `APP_MODE` | `production` (default, set in `wrangler.jsonc`), `uat` or `development`. Non-production shows the "Use existing company folder" testing option. |
| `ALLOW_UNAUTHENTICATED` | `true` skips sign-in. Only honoured when `APP_MODE=development`; for local use. |

## Local development

Requires Node.js 20+.

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` (git-ignored), then:

```bash
npm run dev
```

Open http://localhost:8787.

If Cloudflare's local runtime (`workerd.exe`) is blocked on your machine (`spawn EPERM` / "Access is denied"), run the same Worker code on plain Node.js instead:

```bash
npm run dev:local
```

Open http://127.0.0.1:8790 (set a `PORT` environment variable to use a different port). It reads the same `.dev.vars`, but Cloudflare's CPU and subrequest limits are not enforced, so a final check on Cloudflare is still worthwhile.

Other commands:

```bash
npm run check
```

(`check` runs the TypeScript typecheck and the tests.)

## Deploying to Cloudflare

### 1. Push to Git

```bash
git init
```

```bash
git add .
```

```bash
git commit -m "Company Research: FactSet to SharePoint on Cloudflare Workers"
```

Then add your remote (GitHub or GitLab) and push.

### 2. Connect the repository to Cloudflare

In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** and select the repo.

- Build command: *(leave empty)*. `wrangler deploy` runs `npm run build:client` itself.
- Deploy command: `npx wrangler deploy`

Every push to the production branch then deploys automatically. You can also deploy by hand with `npx wrangler login` and then `npm run deploy`.

### 3. Add the secrets

Add each variable from the table above as a **Secret**, either under **Worker → Settings → Variables and Secrets** or from the command line:

```bash
npx wrangler secret put FACTSET_API_KEY
```

Use secrets rather than plain-text variables: plain-text dashboard variables are overwritten by `vars` in `wrangler.jsonc` on each deploy.

### 4. Set up Microsoft sign-in (required)

Users sign in with Microsoft Entra ID (OpenID Connect, authorization code flow with PKCE). The code is exchanged on the server, so no Microsoft token reaches the browser — the browser only holds this app's own signed, HttpOnly session cookie, which lasts 8 hours.

By default it reuses the existing `MS_*` app registration, so there are only two steps:

1. **Entra admin centre → App registrations →** open the registration used for `MS_CLIENT_ID` → **Authentication → Add a platform → Web**, and add the redirect URIs:
   - `https://<your-site>/auth/callback`
   - `http://localhost:8790/auth/callback` (local testing)

   Leave the "Access tokens" and "ID tokens" boxes unticked — this uses the authorization code flow. No API permissions to add: `openid`, `profile` and `email` are granted by default.
2. Set `SESSION_SECRET` to a long random string:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

Optionally set `ALLOWED_EMAIL_DOMAINS` (e.g. `arohi.com`), or in Entra set *Enterprise applications → Properties → Assignment required* and pick the group that may use it.

To sign users in with a **separate** registration instead, set `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` and `AUTH_TENANT_ID`; they override the `MS_*` values.

Signing in grants a user nothing beyond their own name and email — the SharePoint access stays app-only, used by the server.

Until a user is signed in, the site serves only the sign-in page and every API call returns 401.

## Limits and known gaps

- Transcript PDFs use the built-in Helvetica font, which can't draw characters outside Western European scripts (for example Chinese). Those characters appear as `?`; `₹` is written as `Rs.`. A later change could embed a Unicode font.
- Single documents larger than 250 MB can't be uploaded (Microsoft Graph simple-upload limit).
- The `Industry/Kavi` and `Industry/Third Bridge` folders are still created, so the SharePoint layout is ready when those sources return.
