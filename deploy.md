# Deploying to Firebase

Deploys the Vite client to **Firebase Hosting** and the Express server to a
**Cloud Functions 2nd gen** function (which runs on Cloud Run under the hood).

- **Firebase project**: `feynman-491f5`
- **Supabase** stays where it is — it is not deployed here. Only the client and
  server move.

> **Read Step 0 first.** The server does not currently run on Node, only on Bun.
> Four things must be fixed before any deploy command will work.

---

## Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Blaze (pay-as-you-go) plan** | Cloud Functions will not run on the free Spark plan | [Console → Usage and billing](https://console.firebase.google.com/project/feynman-491f5/usage/details) |
| Firebase CLI | already installed, v15.23.0 | `firebase --version` |
| Logged in | already done — `feynman-491f5` is visible | `firebase projects:list` |

Blaze has a free tier that covers small apps, but a card must be on file.

---

## Step 0 — Fix the Node-compatibility blockers

The server is written for Bun. Cloud Functions runs **Node**. Good news: there are
no `Bun.*` API calls anywhere in `packages/server`, so only these four items need
changing.

### 0.1 — `require()` in an ESM file

`packages/server/index.ts:5` uses:

```ts
const express = require('express')
```

`packages/server/package.json` declares `"type": "module"`, so this file is ESM.
Bun tolerates `require` in ESM; **Node throws `require is not defined`**. Change it
to a real import.

### 0.2 — Replace `app.listen()` with a function export

Cloud Functions supplies the HTTP listener, so the server must *export* the Express
app rather than bind a port. Split the current `index.ts` into two files:

**`packages/server/app.ts`** — builds and exports the app, no `listen`:

```ts
import './lib/instrumentation';
import express from 'express';
import cors from 'cors';
import router from './routes';

export const app = express();

// Required only if the client calls the function URL directly (see Step 4).
app.use(cors({ origin: true }));
app.use(express.json());
app.use(router);
```

**`packages/server/index.ts`** — local dev entrypoint, keeps working with `bun run dev`:

```ts
import { app } from './app';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
```

**`packages/server/functions.ts`** — the deployed entrypoint:

```ts
import { onRequest } from 'firebase-functions/v2/https';
import { app } from './app';

export const api = onRequest(
  {
    region: 'us-central1',
    timeoutSeconds: 3600,   // lab generation streams for a long time
    memory: '1GiB',
    secrets: [
      'OPENAI_API_KEY',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'LANGFUSE_SECRET_KEY',
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_BASE_URL',
    ],
  },
  app,
);
```

Install the two new deps:

```bash
cd packages/server
bun add firebase-functions cors
bun add -d @types/cors
```

### 0.3 — Emit JavaScript that Node can run

`packages/server/tsconfig.json` sets `noEmit: true` and `allowImportingTsExtensions`
— it is configured for Bun executing TS directly, and produces no output.

Two further traps if you try a plain `tsc` build:

- Relative imports are extensionless (`import router from './routes'`). Node ESM
  **requires** file extensions, so a naive ESM emit fails at runtime.
- `"type": "module"` means emitted `.js` is treated as ESM, so you cannot simply
  emit CommonJS either.

The clean way around both is to **bundle to a single `.cjs` file** (the `.cjs`
extension is always CommonJS regardless of the `type` field). Add to
`packages/server/package.json`:

```json
{
  "main": "lib/index.cjs",
  "scripts": {
    "dev": "bun --watch run index.ts",
    "build:functions": "bun build ./functions.ts --target=node --format=cjs --outfile=lib/index.cjs --external=firebase-functions --external=firebase-admin"
  }
}
```

Bundling also sidesteps `node_modules` resolution in the deployed package. Add
`packages/server/lib/` to `.gitignore`.

### 0.4 — Pin the Node runtime

Add to `packages/server/package.json` (your local Node is v26; the runtime is
separate and must be one Cloud Functions supports):

```json
{ "engines": { "node": "22" } }
```

---

## Step 1 — Create the Firebase config

Neither `firebase.json` nor `.firebaserc` exists yet. Create both at the repo root.

**`.firebaserc`**

```json
{
  "projects": {
    "default": "feynman-491f5"
  }
}
```

**`firebase.json`**

```json
{
  "hosting": {
    "public": "packages/client/dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ],
    "headers": [
      {
        "source": "/assets/**",
        "headers": [
          { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
        ]
      }
    ]
  },
  "functions": {
    "source": "packages/server",
    "runtime": "nodejs22",
    "predeploy": ["npm --prefix packages/server run build:functions"],
    "ignore": [
      "node_modules",
      ".git",
      ".env",
      "data/textbooks/**",
      "scripts/**",
      "*.local"
    ]
  }
}
```

The `"source": "**" → /index.html` rewrite is the SPA fallback, so react-router
deep links like `/quiz` resolve instead of 404ing.

Note there is **no `/api/**` rewrite** here — see Step 4 for why.

---

## Step 2 — Upload the secrets

`packages/server/.env` is gitignored and is **not** deployed. Each value must go
into Google Secret Manager. Run these one at a time; each prompts for the value:

```bash
firebase functions:secrets:set OPENAI_API_KEY
firebase functions:secrets:set SUPABASE_URL
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
firebase functions:secrets:set LANGFUSE_SECRET_KEY
firebase functions:secrets:set LANGFUSE_PUBLIC_KEY
firebase functions:secrets:set LANGFUSE_BASE_URL
```

Verify:

```bash
firebase functions:secrets:access OPENAI_API_KEY
```

Two env vars are deliberately excluded:

- **`PORT`** — Cloud Functions sets this itself.
- **`QUIZ_JUDGE_SAMPLE_RATE`** — not a secret. Either hardcode a default in
  `quizJudge.service.ts` or add it to the `onRequest` config as a plain env var.
  If it is unset the judge reads `undefined`, so confirm the fallback behavior.

> `SUPABASE_SERVICE_ROLE_KEY` bypasses all row-level security. It belongs only in
> Secret Manager and only on the server — never in the client bundle.

---

## Step 3 — Deploy the function

```bash
firebase deploy --only functions
```

On first deploy Firebase will ask to enable several Google Cloud APIs
(Cloud Build, Artifact Registry, Cloud Run, Secret Manager) — accept.

When it finishes, **copy the function URL** from the output. It looks like:

```
https://api-<hash>-uc.a.run.app
```

Confirm it is alive:

```bash
curl -i https://api-<hash>-uc.a.run.app/
# expect: 200, "Server online!"

curl -i https://api-<hash>-uc.a.run.app/api/conversations
# expect: 401 {"message":"Missing Authorization header"}
```

A 401 here is the **success** case — it proves the request reached your
`requireAuth` middleware.

---

## Step 4 — Point the client at the API (important)

### Why not use a Hosting `/api/**` rewrite

The obvious setup is a Hosting rewrite from `/api/**` to the function, keeping
everything same-origin. **Do not do this for this app.**

`labGeneration.service.ts` and `chat.service.ts` are async generators that stream
SSE events, and the controllers correctly set `text/event-stream`,
`no-transform`, and `X-Accel-Buffering: no`. But **Firebase Hosting's CDN buffers
responses and caps requests at 60 seconds.** Routed through it, lab generation
will either arrive as a single blob when generation completes, or time out.
`X-Accel-Buffering` is an nginx directive — it does not control the Hosting CDN.

Calling the Cloud Run URL directly bypasses the CDN entirely, which is why
Step 0.2 adds `cors` and Step 3 sets `timeoutSeconds: 3600`.

### Set the client env

`VITE_API_URL` is inlined into the bundle **at build time**, so it must be set
before you build. In `packages/client/.env.production`:

```
VITE_SUPABASE_URL=<same as your existing .env>
VITE_SUPABASE_ANON_KEY=<same as your existing .env>
VITE_API_URL=https://api-<hash>-uc.a.run.app
```

Your `src/lib/api.ts` already reads `VITE_API_URL` as the Axios `baseURL`, and both
the client calls and the server routes carry the `/api` prefix, so no path changes
are needed.

---

## Step 5 — Build and deploy the client

```bash
cd packages/client
bun run build          # tsc -b && vite build  → packages/client/dist
cd ../..
firebase deploy --only hosting
```

Your site will be at:

- `https://feynman-491f5.web.app`
- `https://feynman-491f5.firebaseapp.com`

---

## Step 6 — Update Supabase auth settings

Auth redirects will fail until Supabase knows about the new domain.

In the Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL**: `https://feynman-491f5.web.app`
- **Redirect URLs**: add `https://feynman-491f5.web.app/**`

If you use any OAuth providers, add the same callback URL in each provider's
own console.

---

## Step 7 — Verify

1. Open `https://feynman-491f5.web.app` — landing page renders when logged out.
2. Sign up / log in — confirms Supabase auth and the redirect URLs.
3. Navigate directly to `https://feynman-491f5.web.app/quiz` — must not 404
   (proves the SPA rewrite).
4. **Generate a lab.** This is the critical test — steps should appear
   incrementally, not all at once after a long pause. If they arrive in one
   blob, the request is being buffered somewhere.
5. Open a chat and confirm the reply streams token by token.
6. Run a quiz to confirm the pgvector RAG path reaches Supabase.
7. Check Langfuse for traces — confirms the OTel secrets took effect.

```bash
firebase functions:log --only api          # server-side errors
```

---

## Redeploying after changes

```bash
# server only
firebase deploy --only functions

# client only (rebuild first — Hosting serves whatever is in dist/)
cd packages/client && bun run build && cd ../.. && firebase deploy --only hosting

# both
cd packages/client && bun run build && cd ../.. && firebase deploy
```

Forgetting `bun run build` before a hosting deploy silently ships the previous
build — the same trap as forgetting `--build` on `docker compose up`.

---

## Notes and gotchas

**Textbook ingestion is offline.** `scripts/ingestTextbooks.ts` is excluded from
the deploy via `firebase.json` `ignore`. Embeddings already live in Supabase
pgvector, so the deployed server only reads them. Re-run ingestion locally with
Bun when you add sources; nothing needs redeploying.

**Cold starts.** A 2nd gen function that has been idle takes a few seconds to
wake, and your first lab generation after a quiet period will feel slow. If that
matters, set `minInstances: 1` in the `onRequest` config — but this bills
continuously, so leave it at 0 while testing.

**Cost controls.** Streaming LLM calls on a 3600s timeout can get expensive if
something loops. Set a budget alert in the Google Cloud console, and consider
`maxInstances` in the `onRequest` config to cap concurrency.

**Langfuse flushing.** `lib/instrumentation.ts` flushes traces on `SIGTERM`/`SIGINT`.
Cloud Functions instances can be terminated without a clean signal, so expect
occasional dropped traces in production. Not a correctness problem.

**Docker is unrelated to this.** The `docker-compose.yml` and Dockerfiles in this
repo are for local verification only; Firebase builds its own container from
source. Deploying does not use them.
