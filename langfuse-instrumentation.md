# How Langfuse Works & What `instrumentation.ts` Does

## The big picture: what problem this solves

Your server calls an LLM (via the Vercel AI SDK's `streamText`) to generate labs
and chat replies. Those calls are black boxes by default — you can't see what
prompt was sent, how many tokens it used, how long it took, or where it failed
without adding logging by hand.

**Langfuse** is a platform that collects and visualizes this data: prompts,
completions, token counts, latency, cost, errors — organized into "traces" you
can browse in a dashboard. It's the LLM equivalent of an APM tool like Datadog,
but tailored to LLM apps.

**OpenTelemetry (OTel)** is the underlying, vendor-neutral instrumentation
standard that captures this data as "spans" (a span = one unit of work, e.g.
"one call to the OpenAI API," with a start time, end time, and attributes).
Langfuse doesn't reinvent this — it plugs into OTel and receives the spans OTel
collects.

So the chain is:

```
streamText() call
   -> Vercel AI SDK emits OTel spans (once telemetry is registered)
   -> OTel NodeSDK routes those spans to a "span processor"
   -> LangfuseSpanProcessor formats and ships them to Langfuse's backend
   -> you see a trace in the Langfuse dashboard
```

## Why this needs to run before anything else

`index.ts` imports `instrumentation.ts` *first*, purely for its side effects —
nothing is imported from it and used elsewhere. This matters because
OpenTelemetry works by patching other libraries as they're loaded; if
`NodeSDK.start()` ran after Express or the AI SDK were already imported, some
instrumentation hooks might not attach. Importing it first guarantees the
tracing pipeline exists before any traced code runs.

## Line-by-line: `packages/server/lib/instrumentation.ts`

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

registerTelemetry(new LangfuseVercelAiSdkIntegration());

const shutdown = async () => {
    await sdk.shutdown();
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

1. **`new LangfuseSpanProcessor()`** — creates the "exporter." A span processor
   is an OTel concept: it's handed every span as it finishes and decides what
   to do with it. This one batches spans and sends them to Langfuse's API
   (reading your Langfuse keys from env vars automatically). By default it
   only exports Langfuse/GenAI-relevant spans, not every span in the process,
   so unrelated internals don't show up as noise.

2. **`new NodeSDK({ spanProcessors: [...] })`** — OpenTelemetry's all-in-one
   setup helper for a Node process. It wires whatever span processors you give
   it into the pipeline that receives span output.

3. **`sdk.start()`** — activates the instrumentation. Before this call,
   nothing is being traced.

4. **`registerTelemetry(new LangfuseVercelAiSdkIntegration())`** — the piece
   specific to the Vercel AI SDK. By default `streamText`/`generateText` don't
   emit OTel spans on their own; this line tells the AI SDK "start emitting
   telemetry, formatted the way Langfuse expects" (prompt, model name, token
   usage land as recognizable fields in the UI instead of generic span data).
   This is what makes every `streamText` call in `labGeneration.service.ts`
   and `chat.service.ts` automatically traced, with zero code changes at the
   call sites themselves.

5. **`shutdown` + `SIGTERM`/`SIGINT` handlers** — spans aren't sent to
   Langfuse immediately; they're buffered in memory and flushed in batches for
   efficiency. If the process exits without flushing, whatever's still
   buffered is lost. This matters a lot here because `bun --watch` kills and
   restarts the process on every file save during development — without this
   handler you'd silently lose traces on nearly every hot reload.
   `sdk.shutdown()` forces one final flush before exit.

## What you'd actually see in Langfuse

For one lab-generation request you'd get a trace containing a span for the
`streamText` call: the exact prompt sent, the streamed output, model used,
input/output token counts, latency, and cost. This is what lets you answer
"why did generation take 12 seconds" or "why did the model return malformed
JSON" after the fact, without having added a single manual `console.log`.
