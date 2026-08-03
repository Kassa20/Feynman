# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Lab Website: users pick a software/coding topic and an LLM generates a step-by-step,
skill-level-tailored hands-on lab. See `project-scope.md` for full product scope
(skill-level persistence per user/topic, generation caching by `(topic, skill_level)`,
post-lab quizzes, deferred trust/verification pipeline).

**Stack**: React + Tailwind + shadcn/ui (Vite) frontend, Express + TypeScript backend
(Bun runtime), Supabase (Postgres + Auth), Vercel AI SDK (`ai`, `@ai-sdk/openai`) for
generation, Langfuse + OpenTelemetry for LLM observability. Deployed to Firebase
(Hosting for the client, Cloud Functions 2nd gen wrapping the Express app, with
`/api/**` rewrites to the function).

## Commands

Root uses Bun; the client is a separate Vite-scripted package.

```bash
# server (packages/server)
bun install
bun --watch run index.ts   # or: bun run dev

# client (packages/client)
bun install                 # or npm install
bun run dev                 # vite dev server
bun run build                # tsc -b && vite build
bun run lint                  # eslint .
```

There is no test suite in this repo yet.

Bun-specific conventions (packages/server): use `bun <file>` not `node`/`ts-node`,
`bun test` not jest/vitest, `bun install` not npm/yarn/pnpm, `bunx` not `npx`. Bun
auto-loads `.env` — don't add dotenv.

## Architecture

### Server (`packages/server`) — controller → service → repository

- `routes.ts` wires Express routes to controllers; almost every route is gated by
  `requireAuth` (`middleware/auth.middleware.ts`), which validates the `Bearer` token
  via `supabase.auth.getUser` and attaches `req.user`.
- **Controllers** (`controllers/`) parse/validate the HTTP request and delegate to a
  service.
- **Services** (`services/`) hold business logic and LLM calls (via the Vercel AI SDK,
  `openai(...)` + `streamText`/`Output.object`). `labGeneration.service.ts` and
  `chat.service.ts` are async generators that `yield` typed SSE-style events
  (`lab-delta`, `lab-done`, `chat-delta`, `chat-done`, etc.) consumed by the
  controller and streamed to the client.
- **Repositories** (`repositories/`) are the only layer that talks to Supabase
  (`lib/supabase.ts`).
- `lib/instrumentation.ts` is imported first in `index.ts` for its side effect: it
  wires Langfuse (`LangfuseSpanProcessor`) into an OpenTelemetry `NodeSDK` and
  registers AI SDK telemetry, so every `streamText` call is traced. It flushes on
  `SIGTERM`/`SIGINT` — important because Bun's `--watch` restarts can otherwise drop
  buffered traces.

Key flows:
- **Lab generation** (`services/labGeneration.service.ts`): streams a structured lab
  (title + steps with optional shell code) from the model, optionally generates
  starter code (`starterCode.service.ts`), persists via
  `labGenerationRepository.create`, and links/replaces it on the conversation
  (`regenerate` flag decides between `ensureConversation` and `replaceLab`).
- **Chat** (`services/chat.service.ts`): loads prior conversation history, streams a
  reply constrained to CS/software topics by the system prompt, persists both turns,
  and can fire-and-forget note extraction (`notes.service.ts`) when `takeNotes` is set.

### Client (`packages/client`) — Vite + React Router

- Routes defined in `src/App.tsx`; auth-gated pages wrapped in `ProtectedRoute`.
- `src/lib/api.ts` is an Axios instance that injects the Supabase session's
  `Authorization: Bearer <token>` header on every request via an interceptor.
- `src/lib/AuthContext.tsx` + `src/lib/supabase.ts` manage Supabase auth state.
- `components/chat/` holds the streaming chat/lab UI (`ChatBot`, `StreamingLab`,
  `ChatMessages`, `ChatInput`) that consumes the server's SSE-style generator events.

---

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
