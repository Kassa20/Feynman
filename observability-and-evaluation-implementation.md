# Observability & Evaluation — Implementation Plan (Langfuse)

Companion to `observability-and-evaluation-learnings.md`, which explains the concepts. This document is the how.

Written against the code as it stands: Bun + Express 5, `ai@7.0.34` with `@ai-sdk/openai@4.0.17`, `@langchain/openai@1.5.5`, Supabase auth, SSE streaming.

---

## Decisions at a glance

| Decision | Choice | Why |
|---|---|---|
| Platform | Langfuse (managed cloud to start) | One tool for tracing + evals; supports both your SDKs |
| Transport | OpenTelemetry via `LangfuseSpanProcessor` | Langfuse v4 JS SDK is OTel-native; not optional |
| AI SDK integration | `LangfuseVercelAiSdkIntegration` + `registerTelemetry` | The AI SDK 7 path (v5-era `experimental_telemetry` differs) |
| LangChain integration | `CallbackHandler` from `@langfuse/langchain` | Per-invoke callback; no global setup needed |
| Where traces start | Controllers, not services | Span lifetime then matches the SSE stream lifetime |
| Session identity | Existing `conversationId` | Zero new plumbing; groups a lab + its follow-ups |
| User identity | Existing `req.user!.id` | Already on every authenticated request |
| First evals | Deterministic assertions, not LLM judges | Your prompts already state mechanically checkable rules |
| Eval runner | `langfuse.experiment.run` via a Bun script | Runs locally and in CI; no test framework needed initially |

**Phases 1–3 are the foundation and are worth doing as one unit. Stop there for a week and just watch the traces before building anything in phases 4+.**

---

## Phase 0 — Account and environment

1. Create a project at [cloud.langfuse.com](https://cloud.langfuse.com) (or self-host via their Docker compose). Grab the public key, secret key, and host URL.

2. Add to `packages/server/.env` — which is already gitignored, and Bun loads automatically, so no `dotenv` needed:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or https://us.cloud.langfuse.com
```

> **Verify the variable name against the docs for the version you install.** The v3 SDK used `LANGFUSE_BASEURL`; v4 uses `LANGFUSE_BASE_URL`. Getting this wrong fails silently — the SDK falls back to a default host and your traces go nowhere. If nothing appears in the dashboard after Phase 1, check this first.

3. Install:

```bash
cd packages/server
bun add @langfuse/otel @langfuse/tracing @langfuse/client @langfuse/langchain @langfuse/vercel-ai-sdk @opentelemetry/sdk-node
```

---

## Phase 1 — OpenTelemetry bootstrap

Langfuse v4 sends data as OTel spans, so you need an OTel SDK running before any instrumented code executes.

Create `packages/server/lib/instrumentation.ts`:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { registerTelemetry } from 'ai';
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk';

export const langfuseSpanProcessor = new LangfuseSpanProcessor();

const sdk = new NodeSDK({
    spanProcessors: [langfuseSpanProcessor],
});

sdk.start();

// Routes AI SDK 7 telemetry (streamText, generateText) into the OTel pipeline above.
registerTelemetry(new LangfuseVercelAiSdkIntegration());

// Traces are batched in memory. Flush them before the process dies, or you lose
// whatever was buffered — most visibly on `bun --watch` restarts during development.
const shutdown = async () => {
    await sdk.shutdown();
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Wire it in as the **first** import in `packages/server/index.ts`:

```ts
import './lib/instrumentation';   // must be first — sets up OTel before anything else loads
import router from './routes';
// ...rest unchanged
```

### Key decision: why a `NodeSDK`, and the Bun caveat

Langfuse v4 dropped its bespoke client transport in favour of OpenTelemetry, so this bootstrap isn't optional boilerplate — it's the actual data path.

**You're on Bun, and Bun's OpenTelemetry support is less battle-tested than Node's.** The manual span processor above is the low-risk configuration: it uses only the OTel SDK core, no auto-instrumentation packages (which monkey-patch `http`, `fs`, etc. and are where Bun incompatibilities usually surface).

Verify this phase before writing another line: start the server, make one chat request, and confirm a trace appears in the Langfuse dashboard. If nothing shows up:
1. Check `LANGFUSE_BASE_URL` spelling (see Phase 0).
2. Add `new ConsoleSpanExporter()` as a second span processor to confirm spans are being produced at all — that isolates "not generating spans" from "not exporting spans."
3. If spans are produced but never exported under Bun, fall back to running the server under Node for now (`node --experimental-strip-types index.ts`) to confirm it's a runtime issue rather than a config one.

Also note `index.ts` currently mixes `import router from './routes'` with `const express = require('express')`. That works under Bun but is worth normalising to `import express from 'express'` while you're in the file — mixed module systems are exactly the kind of thing that makes instrumentation load-order bugs hard to diagnose.

---

## Phase 2 — Trace context (userId, sessionId, tags)

Instrumentation alone gives you anonymous traces. The value comes from attaching identity, and you already have everything you need on the request.

### Key decision: start the trace in the controller, not the service

Your services are async generators driven by the controller's `for await` loop. If you started the span inside the service, its lifetime would be ambiguous across suspension points. Wrapping the controller's consumption loop makes the span cover exactly the SSE stream's lifetime — first token to `res.end()` — which is also the number you actually care about.

Update `packages/server/controllers/chat.controller.ts`:

```ts
import { startActiveObservation, updateActiveTrace } from '@langfuse/tracing';

// ...inside sendMessage, replacing the existing try/catch/finally:

await startActiveObservation('chat-request', async () => {
    updateActiveTrace({
        name: 'chat',
        userId: req.user!.id,
        sessionId: conversationId,     // groups the lab + all its follow-up turns
        input: { prompt },
        tags: ['chat'],
    });

    try {
        for await (const event of chatService.sendMessage(
            prompt, conversationId, req.user!.id, controller.signal,
        )) {
            send(event);
        }
    } catch (error) {
        if (error instanceof ConversationNotFoundError) {
            send({ type: 'error', message: 'Conversation not found' });
        } else {
            console.error('[chat] error:', error);
            updateActiveTrace({ metadata: { failed: true } });
            send({ type: 'error', message: 'Something went wrong' });
        }
    } finally {
        res.end();
    }
});
```

Do the same in `labGeneration.controller.ts`, with the richer input you already have:

```ts
updateActiveTrace({
    name: 'lab-generation',
    userId: req.user!.id,
    sessionId: conversationId,
    input: { topic, skillLevel, environment, starterCode },
    tags: ['lab', regenerate ? 'regenerate' : 'initial'],
});
```

Tagging `regenerate` is deliberate. Per the learnings doc, a regenerate is an implicit thumbs-down on the previous lab, and this tag makes that filterable from day one.

### Instrument the silent failures

While you're here, make the invisible things visible. In `labGeneration.service.ts`:

```ts
} catch (error) {
    console.error('[labs] starter code generation failed:', error)
    updateActiveTrace({ metadata: { starterCodeFailed: true } })
    yield {type: 'starter-code-failed'}
}
```

In `starterCode.service.ts`, record when the path filter actually removes something — that's your prompt failing, and it currently vanishes without trace:

```ts
const safeFiles = result.files.filter((f) => isSafePath(f.path))
const dropped = result.files.length - safeFiles.length
if (dropped > 0) {
    updateActiveTrace({ metadata: { unsafePathsDropped: dropped } })
}
return { ...result, files: safeFiles }
```

And in `chat.service.ts`, the fire-and-forget notes call — currently your most invisible failure path:

```ts
notesService
    .extractAndSave(prompt, responseText, userId, labGenerationId, conversationId)
    .catch((err) => {
        console.error('[notes] extraction failed:', err)
        updateActiveTrace({ metadata: { notesExtractionFailed: true } })
    })
```

> Because this promise is deliberately not awaited, it may resolve after the parent span has closed. Treat the metadata flag as best-effort. If notes reliability turns out to matter, the real fix is a job queue rather than fire-and-forget — but that's a separate change, and the flag will tell you whether it's warranted.

---

## Phase 3 — LangChain call sites

`notes.service.ts` and `starterCode.service.ts` use LangChain, which doesn't flow through the AI SDK integration. They need the callback handler.

The handler picks up the surrounding OTel context automatically, so these calls nest inside the trace started in Phase 2 rather than creating orphans — which is the whole point of doing Phase 2 first.

In `packages/server/services/notes.service.ts`:

```ts
import { CallbackHandler } from '@langfuse/langchain';

const langfuseHandler = new CallbackHandler();

// ...in extractAndSave:
const result = await noteAgent.invoke(
    `A user asked the following question...`,   // prompt unchanged
    { callbacks: [langfuseHandler], runName: 'extract-note' },
);
```

Same shape in `starterCode.service.ts`:

```ts
const result = await llm.invoke(
    `A learner is about to work through this hands-on lab...`,   // prompt unchanged
    { callbacks: [langfuseHandler], runName: 'generate-starter-code' },
);
```

A single module-level `CallbackHandler` instance is fine and preferred — it's stateless with respect to individual runs, and per-run identity comes from the ambient trace context.

**Checkpoint.** At this point one lab generation with starter code enabled should produce a single trace containing: the lab `streamText` generation, a nested `generate-starter-code` generation, with token counts and cost on each. If starter code shows up as a *separate* top-level trace, context propagation isn't working — the likely cause is the Bun/OTel issue from Phase 1.

---

## Phase 4 — User feedback scores

The cheapest real quality signal you can collect. Langfuse calls these *scores*, and they attach to a trace by ID.

### Returning the trace ID to the client

The client needs the trace ID to attach feedback to it. Emit it as an SSE event from the controller, inside the active observation:

```ts
import { getActiveTraceId } from '@langfuse/tracing';

// immediately after updateActiveTrace(...):
send({ type: 'trace-id', traceId: getActiveTraceId() });
```

This slots into your existing event-union pattern. Add it to the `ChatEvent`/`LabEvent` types and handle it in `ChatBot.tsx` alongside the other event types, storing it on the message object.

### Score endpoint

Create `packages/server/controllers/feedback.controller.ts`:

```ts
import z from 'zod';
import type { Request, Response } from 'express';
import { LangfuseClient } from '@langfuse/client';

const langfuse = new LangfuseClient();

const feedbackSchema = z.object({
    traceId: z.string().min(1),
    value: z.union([z.literal(0), z.literal(1)]),
    comment: z.string().max(1000).optional(),
});

export const feedbackController = {
    async submit(req: Request, res: Response) {
        const parseResult = feedbackSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        const { traceId, value, comment } = parseResult.data;

        try {
            langfuse.score.create({
                traceId,
                name: 'user-feedback',
                value,
                dataType: 'NUMERIC',
                comment,
            });
            res.status(204).end();
        } catch (error) {
            console.error('[feedback] error:', error);
            res.status(500).json({ message: 'Something went wrong' });
        }
    },
};
```

Register it in `routes.ts`, matching your existing style:

```ts
router.post('/api/feedback', requireAuth, feedbackController.submit);
```

### Free signal: wire regenerate as an implicit negative

You don't need any new UI for this one. When `regenerate: true` arrives at `labGeneration.controller.ts`, the previous lab in that conversation was unsatisfactory. If the client sends the prior trace ID along with the regenerate request, you can score it `0` automatically. This gives you labelled negative examples with zero user effort — and those are exactly the cases you'll want in your eval dataset in Phase 6.

---

## Phase 5 — Deterministic evals

Start here, not with LLM judges. These are free, instant, and reliable, and your prompts already state the rules.

Create `packages/server/evals/deterministic.ts`:

```ts
import type { starterCode } from '../services/starterCode.service';
import type { LabContent } from '../services/labGeneration.service';

const MANIFESTS = ['requirements.txt', 'package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile'];

export function evaluateStarterCode(output: starterCode) {
    const paths = output.files.map((f) => f.path);
    return [
        { name: 'has-manifest', value: paths.some((p) => MANIFESTS.includes(p.split('/').pop() ?? '')) ? 1 : 0 },
        { name: 'has-readme',   value: paths.some((p) => p.toLowerCase().endsWith('readme.md')) ? 1 : 0 },
        { name: 'under-8-files', value: output.files.length <= 8 ? 1 : 0 },
        { name: 'non-empty',     value: output.files.length > 0 ? 1 : 0 },
        // The prompt says "STUB files, not a finished solution" — TODO markers are the proxy.
        { name: 'has-todos',     value: output.files.some((f) => f.content.includes('TODO')) ? 1 : 0 },
    ];
}

export function evaluateLab(output: LabContent, environment: string) {
    const allCode = output.steps.map((s) => s.code ?? '').join('\n');
    return [
        { name: 'step-count-sane', value: output.steps.length >= 3 && output.steps.length <= 15 ? 1 : 0 },
        { name: 'has-code-steps',  value: output.steps.some((s) => s.code) ? 1 : 0 },
        // Catches the model ignoring the target environment.
        { name: 'env-appropriate', value:
            environment === 'windows' && /\b(apt-get|sudo|brew)\b/.test(allCode) ? 0 : 1 },
    ];
}
```

### Key decision: why these specific checks

Each one traces directly to a rule already written in your prompts — `starterCode.service.ts` literally says "Always include a dependency manifest", "Always include a README.md", "Keep it under 8 files", "Write STUB files, not a finished solution". You are currently asking for four hard guarantees and verifying none of them. These assertions cost nothing and tell you immediately whether your prompt is being followed.

`env-appropriate` is included because it exposes a real bug: `formatLabAsMarkdown` in `labGeneration.service.ts` hardcodes ` ```bash ` for every code block regardless of the `environment` the user selected. A Windows user gets PowerShell commands labelled as bash — or worse, gets bash commands. This eval will make that visible; fixing it is a separate change.

---

## Phase 6 — Datasets and experiments

Now the offline regression suite. This is what lets you edit `SYSTEM_PROMPT` without fear.

### Build the dataset from real traces

**Do not invent test cases.** Run phases 1–4 for a week first, then go into Langfuse, filter for traces with negative feedback or the `regenerate` tag, and promote the worst ~20 into a dataset. Langfuse has a "add to dataset" button on each trace for exactly this.

For the chat guardrails you can seed a handful of adversarial cases by hand, because your system prompt states its rules explicitly:

```ts
// packages/server/evals/seed-chat-dataset.ts
import { LangfuseClient } from '@langfuse/client';

const langfuse = new LangfuseClient();

const cases = [
    { input: 'What is the difference between a process and a thread?', expected: 'on-topic-answer' },
    { input: 'What should I cook for dinner tonight?',                 expected: 'refusal-off-topic' },
    { input: 'Write me a step-by-step lab on setting up Docker.',      expected: 'redirect-to-generator' },
    { input: 'Generate a main.py file for me.',                        expected: 'refusal-no-files' },
    { input: 'thanks!',                                                expected: 'brief-acknowledgement' },
];

for (const c of cases) {
    await langfuse.dataset.createItem({
        datasetName: 'chat-guardrails',
        input: c.input,
        expectedOutput: c.expected,
    });
}
```

Run with `bun run packages/server/evals/seed-chat-dataset.ts`.

### The experiment runner

```ts
// packages/server/evals/run-chat-eval.ts
import '../lib/instrumentation';
import { LangfuseClient } from '@langfuse/client';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { langfuseSpanProcessor } from '../lib/instrumentation';

const langfuse = new LangfuseClient();

// Judge rubric derived directly from SYSTEM_PROMPT in chat.service.ts.
const judge = async ({ input, output, expectedOutput }: any) => {
    const { text } = await generateText({
        model: openai('gpt-4o-mini'),
        prompt:
            `A study assistant is constrained to: only answer computer science / software engineering ` +
            `questions; be concise; never generate files; never produce step-by-step labs (it should ` +
            `instead tell the user they can regenerate a lab).\n\n` +
            `User asked: "${input}"\nAssistant replied: "${output}"\n` +
            `Expected behaviour: ${expectedOutput}\n\n` +
            `Did the assistant follow its constraints? Reply with only "1" or "0".`,
    });
    return { name: 'guardrail-adherence', value: text.trim() === '1' ? 1 : 0 };
};

const dataset = await langfuse.dataset.get('chat-guardrails');

const result = await dataset.runExperiment({
    name: `chat-guardrails-${new Date().toISOString()}`,
    description: 'Regression run against current SYSTEM_PROMPT',
    task: async (item) => {
        // Import SYSTEM_PROMPT from chat.service.ts rather than copying it, so the
        // eval always tests the prompt you actually ship.
        const { text } = await generateText({
            model: openai('gpt-4o'),
            system: SYSTEM_PROMPT,
            maxOutputTokens: 500,
            prompt: item.input as string,
        });
        return text;
    },
    evaluators: [judge],
});

console.log(await result.format());
await langfuseSpanProcessor.forceFlush();
```

### Key decision: export `SYSTEM_PROMPT` rather than duplicating it

`SYSTEM_PROMPT` is currently a module-private const in `chat.service.ts`. Add `export` to it so the eval imports the real thing. If you copy-paste the prompt into the eval, the two drift apart within a week and your suite starts testing a prompt you no longer ship — which is worse than having no suite, because it's falsely reassuring.

### Key decision: a cheaper model for the judge

The judge uses `gpt-4o-mini` while the task uses `gpt-4o`. Judging "did it follow four explicit rules" is a much easier task than answering the question, so the cheap model is adequate — and since the judge runs once per dataset item per experiment run, its cost compounds faster than the task's.

**Validate the judge before trusting it.** Hand-label ten outputs yourself, run the judge on the same ten, and check agreement. If it disagrees with you more than once or twice, fix the rubric before you start making decisions based on its scores. An unvalidated judge is just a random number generator with good branding.

---

## Phase 7 — Running it

Add to `packages/server/package.json`:

```json
"scripts": {
    "dev": "bun --watch run index.ts",
    "eval:chat": "bun run evals/run-chat-eval.ts",
    "eval:seed": "bun run evals/seed-chat-dataset.ts"
}
```

The workflow that makes all of this worthwhile:

1. Edit `SYSTEM_PROMPT`.
2. `bun run eval:chat`.
3. Compare the run against the previous one in the Langfuse experiments view.
4. Ship only if scores held or improved.

That loop is the entire return on this work. Everything before it is setup.

---

## Verification checklist

Work through these in order — each one isolates a different failure point:

- [ ] Server starts with instrumentation imported first, no OTel errors in the console.
- [ ] A chat request produces exactly one trace in Langfuse, with correct `userId` and `sessionId`.
- [ ] The trace shows the prompt, the full response, token counts, cost, and latency.
- [ ] A lab generation with `starterCode: true` produces **one** trace containing **two nested** generations (AI SDK + LangChain in the same tree).
- [ ] A chat turn on a lab conversation shows the `extract-note` LangChain generation nested under it.
- [ ] All traces from one conversation group under a single session.
- [ ] `POST /api/feedback` attaches a visible score to a trace.
- [ ] `bun run eval:chat` completes and reports per-item scores.
- [ ] Deliberately weakening `SYSTEM_PROMPT` (e.g. deleting the off-topic rule) makes the eval score drop — this proves the suite actually detects regressions rather than passing everything.

That last item is the one people skip, and it's the only one that proves the suite works.

---

## Risks and things to watch

**Bun + OpenTelemetry.** The main technical risk, flagged in Phase 1. Verify tracing works end-to-end before building anything on top of it.

**Cost of tracing.** Negligible — spans are batched and exported async, off the request path. The judge model in Phase 6 is the only meaningful new spend, and it only runs when you invoke the eval script.

**PII.** Traces will contain full student questions and answers. For a university project with real student data, consider self-hosting Langfuse rather than using the cloud, and check whether your institution has requirements here. Langfuse supports masking if you need to redact fields.

**Scope creep.** Phases 1–3 deliver most of the value. Resist building the full eval harness before you've looked at a week of real traces — the whole argument for sequencing it this way is that production traffic tells you which evals are worth writing, and guessing wastes the effort.
