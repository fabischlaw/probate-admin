# ri-probate-app

A simple web app to browse Rhode Island probate matters via the [DecisionVault API](https://api.decisionvault.com).

## Features

- Lists all matters from your DecisionVault account
- Click a matter to view its details: clients, assets, and contacts
- Authentication is isolated in `auth.js` — swap in OAuth2 later without touching the rest of the app

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A DecisionVault API key

## Setup

1. **Clone / copy the project**

   ```bash
   cd ri-probate-app
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure your API key**

   Copy the example env file and fill in your key:

   ```bash
   cp .env.example .env
   ```

   Edit `.env`:

   ```
   DECISIONVAULT_API_KEY=your_actual_api_key_here
   PORT=3000
   ```

4. **Start the server**

   ```bash
   npm start
   ```

   For auto-restart during development:

   ```bash
   npm run dev
   ```

5. **Open the app**

   Navigate to [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
ri-probate-app/
├── auth.js          # Returns API auth headers — swap for OAuth2 here
├── server.js        # Express server; proxies all DecisionVault API calls
├── public/
│   ├── index.html   # App shell
│   └── app.js       # Frontend logic (vanilla JS, no build step)
├── .env             # Local secrets (git-ignored)
├── .env.example     # Template for .env
└── package.json
```

## Swapping to OAuth2

Open `auth.js` and replace the body of `getAuthHeaders()` with your OAuth2 token-fetch logic. The function must return a plain object of HTTP headers. Nothing else in the app needs to change.

Example:

```js
async function getAuthHeaders() {
  const token = await fetchOAuthToken(); // your implementation
  return {
    'Authorization': `Bearer ${token}`,  // OAuth2
    'Content-Type': 'application/json',
  };
}
// Current API key format (for reference): Authorization: Token {key}
```

## API Endpoints (proxied by the server)

| Route | DecisionVault endpoint |
|---|---|
| `GET /api/matters` | `GET /v1/matters` |
| `GET /api/matters/:id` | `GET /v1/matters/:id` |
| `GET /api/matters/:id/clients` | `GET /v1/matters/:id/clients` |
| `GET /api/matters/:id/assets` | `GET /v1/matters/:id/assets` |
| `GET /api/matters/:id/contacts` | `GET /v1/matters/:id/contacts` |

## Massachusetts Probate — Phase 1

The Massachusetts section is **Phase 1: UI and logic only**. PDF generation for MA forms is Phase 2 (pending MA template acquisition).

### What Phase 1 includes

- **State selector** — "Rhode Island" / "Massachusetts" tabs on the Generate Forms card. All existing RI functionality is unchanged.
- **Proceeding type selector** — six types: Voluntary Administration, Informal Intestate, Informal Testate, Formal Intestate, Formal Testate, Late & Limited.
- **Smart panel** — auto-populated rows from DecisionVault (date of death, domicile, estate value, voluntary admin eligibility) and YES/NO toggle questions for case facts that cannot be determined from data alone.
- **Form set computation** — required and conditional MUPC forms are computed dynamically from the proceeding type and toggle answers. Hovering a form chip shows the full form name.
- **Interested parties panel** — all contacts with LEGAL HEIR, SURVIVING SPOUSE, STEPCHILD, and MINOR badges derived from MUPC § 2-102/2-103 intestacy rules.
- **Generate Full Package** — calls `POST /api/ma/matter/:id/generate-package` and shows the computed form list + filing fee. Returns a "Phase 2" notice in place of a PDF download.
- **Individual Forms** — collapsible pill list of all forms for the selected proceeding type. Clicking shows the form name and a Phase 2 notice.

### MA API endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/ma/matter/:id/analysis` | Heir determination, voluntary admin eligibility, auto-answered toggles |
| `POST` | `/api/ma/matter/:id/generate-package` | Compute form set + fee (body: `{ proceedingType, toggleAnswers, selectedParties }`) |
| `POST` | `/api/ma/matter/:id/generate-form` | Single form metadata (body: `{ formId, toggleAnswers }`) |

## AI Features (Optional)

This application includes optional AI-powered document analysis for wills and death certificates. All core form generation functionality works without this feature enabled.

Set `AI_MODE` in your `.env` file to choose a mode:

| `AI_MODE` | Description |
|---|---|
| `disabled` | AI extraction off (default) |
| `browser` | Uses your active Claude.ai browser session — no API key needed. You must be logged into claude.ai in the same browser. Intended for internal/development use. |
| `api` | Calls the Anthropic API server-side. Also set `ANTHROPIC_API_KEY=sk-ant-...`. Suitable for production deployments. |

Example `.env` for browser mode:
```
AI_MODE=browser
```

Example `.env` for API mode:
```
AI_MODE=api
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### Phase 2 scope (future)

Acquire MA Probate Court PDF templates and implement `forms/mpc*.js` fillers using the same pdf-lib pattern as the RI forms. Wire the generate endpoints to return actual PDFs.

## Authentication

On first run, navigate to `/setup` to create the attorney account. Subsequent visits require login.

Roles: `attorney` (full access) · `firm_admin` · `paralegal` · `va` (read-only, no forms)

## Deploying to Railway

1. **Push to GitHub** — Connect your repo at [railway.app](https://railway.app)

2. **Set environment variables** in Railway's Variables panel:

   ```
   DECISIONVAULT_API_KEY=your_key
   SESSION_SECRET=your_long_random_string
   ANTHROPIC_API_KEY=your_key   # optional
   AI_MODE=disabled              # or 'api'
   NODE_ENV=production
   ```

3. **Deploy** — Railway auto-detects Node.js via `railway.json` and runs `node server.js`

4. **Health check** — Railway polls `GET /api/health` to verify the deployment is live

5. **Custom domain** — Add in Railway → Settings → Networking → Custom Domain

> **Note:** The `data/` directory is git-ignored. On Railway, data persists only within the container's filesystem. For production persistence, consider mounting a Railway Volume and pointing `DATA_DIR` to it.

