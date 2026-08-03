# Streaming Migration

Migrating lab generation and chat from blocking request/response to streaming.

Written against the versions actually installed in this repo:
`ai@7.0.34`, `@ai-sdk/openai@4.0.17`, `express@5.2.1`, `react@19.2.7`.

---

## 1. Where the latency actually is

| Endpoint | Model call(s) | Output token budget | Blocking? |
| --- | --- | --- | --- |
| `POST /api/labs/generate` | lab content, then starter code | 2000 + 3000, **sequential** | Yes — user sees nothing |
| `POST /api/chat` | one reply | 500 | Yes |

Lab generation is roughly an order of magnitude slower than chat, and the client
makes it feel worse than it is:

- `labGeneration.service.ts:57` awaits `starterCodeService.generate(...)` *inside*
  the request, and that call needs `labContent.steps` — so it cannot start until
  the lab is fully generated. The two calls are strictly sequential.
- `LabGeneratorForm.tsx:76` calls `navigate()` **after** the `await`. The user
  stays on the form with a "Writing your lab…" button for the entire duration,
  then teleports to a fully-formed conversation.
- The response body is unused: `labGenerationService.generate` returns
  `Promise<void>`, so `res.json(result)` sends nothing meaningful. The client
  learns the lab exists only by navigating and re-fetching.

**So: fix lab generation first.** Chat is the same transport problem at 1/10th
the payoff; it is Phase 2.

> These are budget-derived estimates, not measurements. Log wall-clock time
> around both calls before and after — you want a real before/after number, and
> `maxTokens` is a ceiling, not the actual output length.

## 2. Goal

**Phase 1 — lab generation.** The user submits the form, lands in the
conversation view immediately, and watches the lab assemble itself. If starter
code was requested, it generates *after* the lab is readable, with its own
progress indicator.

**Phase 2 — chat.** Same transport, simpler payload.

**Success criteria:**

1. The user reaches `/chat/:id` in under a second, not after a minute.
2. Lab steps render progressively as they are generated.
3. Starter code no longer delays the lab becoming readable.
4. The finished lab is persisted exactly once, and a reload shows identical content.
5. Aborting mid-generation persists nothing.

## 3. Current state

| File | What it does now |
| --- | --- |
| `services/labGeneration.service.ts:38` | `await llm.invoke(...)` — structured output, blocks |
| `services/labGeneration.service.ts:57` | awaits starter code sequentially, still inside the request |
| `services/labGeneration.service.ts:70` | flattens `LabContent` to markdown, stores as one message |
| `controllers/labGeneration.controller.ts:35` | `res.json(result)` where `result` is `undefined` |
| `components/lab/LabGeneratorForm.tsx:69` | `await api.post(...)` then `navigate()` |
| `services/chat.service.ts:29` | `await llm.invoke(...)` — Phase 2 |

The LLM clients are LangChain's `ChatOpenAI`. The `ai` and `@ai-sdk/openai`
packages are already in `packages/server/package.json` but unused.

---

## 4. Design decisions

### 4.1 Keep structured output — `streamText` with an `output` setting

`labGeneration.service.ts` produces a typed object (`title` + `steps[]`) via
`withStructuredOutput`. The AI SDK equivalent is `streamText` with
`output: Output.object({ schema })`, which exposes `partialOutputStream` — an
async iterable of progressively-more-complete versions of your object, every
field optional until it arrives.

> **Not `streamObject`.** It exists and does the same job, but `ai@7.0.34` marks
> it deprecated (`index.d.ts:7502`): *"Use `streamText` with an `output` setting
> instead."* The SDK folded object generation into the text functions, so both
> phases of this migration end up on one API — `streamText` — differing only in
> whether an `output` is supplied.

**The tempting shortcut, and why to skip it:** `formatLabAsMarkdown` immediately
flattens the object to markdown, and markdown is all the user ever sees. So you
could drop structured output entirely, use `streamText` with a "write me markdown"
prompt, and stream plain text — simpler, fewer tokens, no JSON overhead.

Don't, for two reasons:

1. `starterCode.service.ts:37` consumes `labContent.title` and
   `labContent.steps[].title`. You would have to re-parse them out of markdown.
2. Your `implementation-plan.md` ties `quiz_questions` to a `lab_generations`
   row, and structured steps are what makes generating a quiz from a lab
   tractable. `lab_generations.content` being real JSON has downstream value.

Keeping the structure also unlocks a genuinely better lab UI later — per-step
cards with "mark complete" checkboxes instead of one giant markdown blob. Not in
scope here, but do not throw away the thing that enables it.

### 4.2 SSE, not plain-text chunks

Lab generation needs to send **more than one kind of thing** over one connection:

- lab content deltas
- "lab is done and persisted, here is the id"
- "starter code is generating…"
- "starter code ready" / "starter code failed"
- errors that happen after the response has already started

A plain-text stream can carry exactly one of those. SSE frames each event with a
type, so the client can switch on it. This is the deciding factor — not
theoretical elegance.

Note `EventSource` is unusable here: it only issues GET requests and cannot set
an `Authorization` header. You use `fetch` and parse frames yourself.

### 4.3 Starter code moves off the critical path, but stays in the request

Right now starter code adds its full generation time before the user sees
anything. It should run *after* the lab has streamed, so the user reads while it
generates.

The obvious move is fire-and-forget after `res.end()` — like `chat.service.ts:39`
does for notes. **Don't.** Your deploy target is Cloud Functions v2, where the
runtime may freeze or reclaim the instance once the response completes. Work
started after `res.end()` can silently vanish.

Instead, keep the connection open: stream the lab, emit `starter-code-start`,
generate, then persist and emit `lab-done`. One request, works in serverless, and
the client gets a live progress indicator for free.

(The durable answer is a job queue — write an intent row, process it, mark it
done. That is the right shape once you have more background work. Not yet.)

### 4.4 Navigate first, stream second

Flip the client order: generate the `conversationId`, `navigate()` to
`/chat/:id` immediately, and let the chat view own the stream.

This creates a wrinkle. `ChatBot` mounts and fetches
`/api/conversations/:id/messages`, but the conversation row does not exist yet —
`ensureConversation` runs inside `labGenerationService.generate`, and it needs a
`lab_generation_id` (a NOT NULL FK), which does not exist until generation
finishes.

Two ways out:

- **(chosen)** Pass the form values through router state. `ChatBot` sees pending
  state, skips the fetch, and opens the stream instead. No schema change.
- Insert a placeholder `lab_generations` row up front and `UPDATE` it on
  completion. Cleaner conceptually, but requires `content` to tolerate a
  placeholder and adds a write.

Take the first. If you later want generation to survive a page refresh, the
second becomes necessary — that is the trigger to revisit.

### 4.5 Persist on completion, not during

You are responding before you know the final object, so persistence moves to the
end of the stream. `await result.output` resolves with the fully validated object
once the stream is consumed — use that rather than accumulating partials
yourself, since it also gives you schema validation.

Order matters: `lab_generations` row → `ensureConversation` → `addMessages`. Same
order as today, just later.

### 4.6 `fetch` on the client, not axios

axios in the browser uses `XMLHttpRequest`, which buffers the whole response and
cannot expose it incrementally. Streaming needs `fetch`, whose `response.body` is
a `ReadableStream`.

The cost: the request interceptor in `lib/api.ts` that attaches the Supabase
bearer token does not apply. Extract that into a reusable helper so it is not
duplicated. Keep `api` for ordinary JSON endpoints.

---

## 5. Implementation

### Step 1 — Export an auth-header helper

`packages/client/src/lib/api.ts`:

```ts
export async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}
```

Refactor the existing interceptor to use it, so there is one source of truth:

```ts
api.interceptors.request.use(async (config) => {
  Object.assign(config.headers, await authHeaders());
  return config;
});
```

**Verify:** existing requests still work. Nothing has changed behaviourally.

---

### Step 2 — Rewrite `labGeneration.service.ts` to stream

```ts
import { openai } from '@ai-sdk/openai';
import { Output, streamText } from 'ai';
import z from 'zod';
import { starterCodeService } from './starterCode.service';
import {
  labGenerationRepository,
  type SkillLevel,
  type TargetEnvironment,
} from '../repositories/labGeneration.repository';
import { conversationRepository } from '../repositories/conversation.repository';

const labContentSchema = z.object({
  title: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      code: z.string().nullable(),
    }),
  ),
});

export type LabContent = z.infer<typeof labContentSchema>;

// formatLabAsMarkdown stays exactly as it is — still needed to persist the
// lab as a chat message.

type LabEvent =
  | { type: 'lab-delta'; partial: unknown }
  | { type: 'lab-done'; labGenerationId: string }
  | { type: 'starter-code-start' }
  | { type: 'starter-code-failed' };

export const labGenerationService = {
  async *generate(
    topicText: string,
    skillLevel: SkillLevel,
    environment: TargetEnvironment,
    conversationId: string,
    userId: string,
    starterCode: boolean,
    abortSignal: AbortSignal,
  ): AsyncGenerator<LabEvent> {
    const result = streamText({
      model: openai('gpt-4o'),
      output: Output.object({ schema: labContentSchema }),
      maxOutputTokens: 2000,
      abortSignal,
      prompt:
        `Write a hands-on, step-by-step lab for the topic "${topicText}", ` +
        `targeting a ${skillLevel} skill level, for a user working on ${environment}. ` +
        `Each step should have a title, a description, and optionally a shell code snippet to run.`,
    });

    // DeepPartial<LabContent> — nested steps[] entries are partial too.
    for await (const partial of result.partialOutputStream) {
      yield { type: 'lab-delta', partial };
    }

    // Resolves once the stream is consumed, with the validated object.
    const labContent = await result.output;

    // Starter code is generated after the lab is readable, not before.
    let starterCodeContent = null;
    if (starterCode) {
      yield { type: 'starter-code-start' };
      try {
        starterCodeContent = await starterCodeService.generate(
          topicText, skillLevel, environment, labContent,
        );
      } catch (error) {
        console.error('[labs] starter code generation failed:', error);
        yield { type: 'starter-code-failed' };
      }
    }

    const labGeneration = await labGenerationRepository.create(
      topicText, skillLevel, environment, labContent, starterCodeContent,
    );
    await conversationRepository.ensureConversation(conversationId, userId, labGeneration.id);
    await conversationRepository.addMessages(
      conversationId, null, formatLabAsMarkdown(labContent),
    );

    yield { type: 'lab-done', labGenerationId: labGeneration.id };
  },
};
```

**Why an async generator:** the service needs to emit several kinds of event over
time, and a generator expresses that without the service knowing anything about
HTTP. The controller decides how to serialize them. Keeps the layering you
already have.

> **Ordering note.** `lab-done` is emitted last, after persistence, so the client
> only enables the download button once the row genuinely exists. Emitting it
> earlier would race the `getStarterCode` query.

**Verify:** drive the generator from a scratch script, log each event. You should
see many `lab-delta`s, then `starter-code-start`, then one `lab-done` — and
exactly one new row in each of `lab_generations`, `conversations`, `messages`.

---

### Step 3 — Stream SSE from the controller

`packages/server/controllers/labGeneration.controller.ts`:

```ts
async generate(req: Request, res: Response) {
  const parseResult = generateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json(parseResult.error.format());
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const { topic, skillLevel, environment, conversationId, starterCode } = parseResult.data;

  // Everything that can fail with a real status code must happen above this line.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    for await (const event of labGenerationService.generate(
      topic, skillLevel, environment, conversationId, req.user!.id, starterCode, controller.signal,
    )) {
      send(event);
    }
  } catch (error) {
    console.error('[labs] error:', error);
    send({ type: 'error', message: 'Something went wrong generating your lab' });
  } finally {
    res.end();
  }
}
```

Note the shape: because SSE can carry an error *as an event*, the catch block no
longer has to worry about whether headers were already sent. That is the
concrete payoff from §4.2.

**Verify:**

```bash
curl -N -X POST http://localhost:3000/api/labs/generate \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"topic":"docker volumes","skillLevel":"beginner","environment":"macos","starterCode":true,"conversationId":"'$(uuidgen | tr A-Z a-z)'"}'
```

`-N` disables curl buffering. Without it everything arrives at once and you will
wrongly conclude streaming is broken.

---

### Step 4 — Navigate immediately from the form

`LabGeneratorForm.tsx` — replace the `onSubmit` body:

```tsx
const onSubmit = (data: LabGeneratorFormData) => {
  const conversationId = crypto.randomUUID();
  reset();
  // Hand the form values to the chat view; it owns the stream from here.
  navigate(`/chat/${conversationId}`, { state: { pending: data } });
};
```

The `generating` state and its error handling move to `ChatBot`. The submit
button no longer needs a loading state at all.

**Verify:** submitting navigates instantly.

> **Gotcha you'll hit immediately: `Cannot find name 'LabContent'`.** `LabContent`
> is defined and exported only on the server
> (`packages/server/services/labGeneration.service.ts`). This repo has no shared
> types package between `packages/client` and `packages/server` — they're
> separate TypeScript projects with separate `tsconfig.json`s — so nothing on the
> client can import it. Duplicate the shape as a plain type literal on the client,
> near `ChatBot.tsx`:
>
> ```ts
> type LabContent = {
>   title: string;
>   steps: { title: string; description: string; code: string | null }[];
> };
> ```
>
> This will drift silently if the server schema changes — acceptable for a shape
> this small and stable. A shared-types workspace is the real fix, but it's a
> structural change out of scope for this migration; revisit it once more types
> (`LabEvent`, eventually quiz types) need to cross the client/server boundary.

---

### Step 5 — Consume the stream in `ChatBot.tsx`

```tsx
const location = useLocation();
const pending = location.state?.pending as LabGeneratorFormData | undefined;

// DeepPartial, not Partial — steps[] entries are half-filled mid-stream too.
const [streamingLab, setStreamingLab] = useState<DeepPartial<LabContent> | null>(null);
const [phase, setPhase] = useState<'idle' | 'lab' | 'starter-code'>('idle');

useEffect(() => {
  // Existing fetch is skipped while a generation is in flight.
  if (pending || !conversationId) return;
  api.get<MessagesResponse>(`/api/conversations/${conversationId}/messages`)
    .then(({ data }) => { /* unchanged */ });
}, [conversationId, pending]);

useEffect(() => {
  if (!pending || !conversationId) return;
  const controller = new AbortController();

  (async () => {
    setPhase('lab');
    const response = await fetch(`${import.meta.env.VITE_API_URL}/api/labs/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ ...pending, conversationId }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Request failed: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true keeps multi-byte characters intact across chunk boundaries.
      buffer += decoder.decode(value, { stream: true });

      // A chunk can end mid-frame, so keep the trailing partial in the buffer.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6));

        if (event.type === 'lab-delta') setStreamingLab(event.partial);
        if (event.type === 'starter-code-start') setPhase('starter-code');
        if (event.type === 'starter-code-failed') {
          // The lab itself is fine — say so, rather than leaving the user
          // wondering why the download button never appeared.
          setPhase('idle');
          setError("Your lab is ready, but starter code couldn't be generated.");
        }
        if (event.type === 'lab-done') {
          setStreamingLab(null);
          setPhase('idle');
          // Re-fetch to get the canonical persisted message + starter code id.
          const { data } = await api.get<MessagesResponse>(
            `/api/conversations/${conversationId}/messages`,
          );
          setMessages(data.messages);
          setStarterCodeLabId(data.starterCodeLabId);
        }
        if (event.type === 'error') setError(event.message);
      }
    }
  })().catch((err) => {
    if ((err as Error).name !== 'AbortError') {
      setError('Something went wrong generating your lab.');
    }
  });

  return () => controller.abort();
}, [pending, conversationId]);
```

Render the in-flight lab inside the scrollable message panel, after
`ChatMessages` — chronologically it's the newest thing happening, the same slot
a new chat message would occupy, and this keeps it under the autoscroll logic
from Step 6 rather than pinned outside the scrolling area:

```tsx
<div className="flex-1 overflow-y-auto">
  <ChatMessages messages={messages} />
  {streamingLab && <StreamingLab content={streamingLab} />}
  {phase === 'starter-code' && (
    <p className="text-sm text-muted-foreground">Generating starter code…</p>
  )}
</div>
```

`StreamingLab` is a small component you write — nothing in the AI SDK or your
existing UI kit provides it. It renders `content.title` and maps `content.steps`,
and **every field must be treated as optional**, including array elements that
are still filling in — a step can exist with a `title` but no `description` yet.
`DeepPartial` is exported from `ai`, so the client can share the exact type the
SDK produces rather than approximating it with `Partial`, which is only one
level deep and would wrongly type `steps[i].title` as required:

```tsx
// packages/client/src/components/chat/StreamingLab.tsx
import type { DeepPartial } from "ai";
import type { LabContent } from "./ChatBot"; // or wherever the type lives — see gotcha below

type Props = {
  content: DeepPartial<LabContent>;
};

export const StreamingLab = ({ content }: Props) => (
  <div className="rounded-[14px] border border-border bg-muted px-4 py-3 text-sm">
    {content.title && (
      <h1 className="mb-2 text-lg font-bold text-foreground">{content.title}</h1>
    )}
    {content.steps?.map((step, i) => (
      <div key={i} className="mb-3">
        {step?.title && (
          <h3 className="mb-1 text-sm font-bold text-foreground">
            {i + 1}. {step.title}
          </h3>
        )}
        {step?.description && <p className="leading-relaxed">{step.description}</p>}
      </div>
    ))}
  </div>
);
```

The guards (`content.title &&`, `step?.title &&`, …) are load-bearing, not
defensive boilerplate — skip one and you render `undefined` on screen the moment
that field hasn't arrived yet, rather than simply not showing it.

This bare-bones version won't visually match a finished lab message, which
renders through `ChatMessages` → `ReactMarkdown` with syntax-highlighted code
blocks (`CodeBlock.tsx`). You could instead feed partial markdown through
`ReactMarkdown` for visual consistency, but partial/malformed markdown mid-stream
(an unclosed code fence, for instance) can render strangely until it completes.
Plain structured rendering, as above, is more robust against partial data —
pick markdown-through-`ReactMarkdown` only if visual continuity matters more
than that robustness.

**Verify:** steps appear one at a time; "Generating starter code…" shows only
after the lab is complete and readable; the download button appears at the end.

---

### Step 6 — Fix autoscroll

`ChatMessages.tsx:65` calls `scrollIntoView({ behavior: "smooth" })` on every
change to `messages`. During streaming this fires constantly, queueing
overlapping animations and fighting the user if they scroll up to read.

```tsx
const pinnedRef = useRef(true);

useLayoutEffect(() => {
  const el = containerRef.current?.parentElement;
  if (!el) return;
  pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
});

useEffect(() => {
  if (!pinnedRef.current) return;
  const el = containerRef.current?.parentElement;
  el?.scrollTo({ top: el.scrollHeight });   // instant, not smooth
}, [messages, streamingLab]);
```

Smooth scrolling cannot keep up with stream-rate updates and looks broken.

**Verify:** scroll up mid-stream and the view stays put; return to the bottom and
it resumes following.

---

### Step 7 — Add a cancel button

```tsx
{phase !== 'idle' && (
  <Button variant="outline" onClick={() => abortRef.current?.abort()}>Stop</Button>
)}
```

The chain: fetch abort → TCP close → Express `'close'` → `controller.abort()` →
AI SDK stops the OpenAI call → the generator never reaches its persistence lines
→ nothing is written. That works only because the `AbortSignal` was threaded
through Steps 2 and 3.

**Verify:** stop mid-generation, reload — no orphan `lab_generations`,
`conversations`, or `messages` rows.

---

## 6. Phase 2 — chat

Same transport, same function, much simpler payload — chat is just `streamText`
with the `output` setting omitted, which defaults to plain text and gives you
`textStream` instead of `partialOutputStream`. `chat.service.ts` becomes:

```ts
const result = streamText({
  model: openai('gpt-4o'),
  system: SYSTEM_PROMPT,
  maxOutputTokens: 500,
  messages: [...history, { role: 'user', content: prompt }],
  abortSignal,
  onFinish: async ({ finalStep }) => {
    await conversationRepository.addMessages(conversationId, null, finalStep.text);
    // notes extraction, unchanged
  },
});
return result.textStream;   // AsyncIterableStream<string>
```

Two things to handle that lab generation did not raise:

**Role mapping.** Your `messages` table stores assistant turns as `role: 'ai'`;
the AI SDK expects `'assistant'`. LangChain hid this because you passed message
objects straight through. Map at the boundary — do not migrate the DB enum:

```ts
const history = chatHistory.messages.map((m) => ({
  role: m.role === 'ai' ? 'assistant' as const : 'user' as const,
  content: m.content,
}));
```

**Split writes.** `addMessages` writes the user and AI rows in one insert
(`conversation.repository.ts:88`). Streaming needs the user row written up front
and the AI row written in `onFinish`. Add a dedicated method rather than passing
`''` as the AI text — that would leave blank bubbles in the history:

```ts
async addUserMessage(conversationId: string, content: string): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role: 'user', content });
  if (error) throw new Error(`addUserMessage failed: ${error.message}`);
},
```

---

## 7. Gotchas

- **Do not add `compression` middleware** to `index.ts` without configuring it.
  It buffers responses to compress them, silently killing streaming. If you need
  it, exclude these routes or call `res.flush()` after each write.
- **`X-Accel-Buffering: no`** is for nginx-style proxies that buffer by default.
  Harmless locally, necessary behind many reverse proxies.
- **Deployment risk.** Your scope targets Firebase Hosting rewrites → Cloud
  Functions v2. Functions v2 supports streaming, but Firebase Hosting's CDN layer
  may buffer it away. Test through the deployed rewrite path *early* — if it
  buffers, you may need to hit the function URL directly. Verify before building
  much on top of this.
- **`TextDecoder` without `{ stream: true }`** corrupts any multi-byte character
  (emoji, accents, box-drawing characters in code samples) that straddles a chunk
  boundary. Intermittent and miserable to debug.
- **SSE frames split across chunks.** The `buffer.split('\n\n')` + `pop()` pattern
  in Step 5 is not optional — without it you will `JSON.parse` half a frame.
- **`generateObject` is deprecated the same way** (`index.d.ts:7106`) — use
  `generateText` with an `output` setting. Relevant when `notes.service.ts` and
  `starterCode.service.ts` eventually move off LangChain's
  `withStructuredOutput`; both are non-streaming structured calls, so they map to
  `generateText`, not `streamText`.
- **`index.ts` mixes `import router` with `require('express')`.** Unrelated to
  this work, but inconsistent — worth cleaning up separately.
- **`react-markdown` re-parses the whole message on every update.** Fine at
  current lengths; if long labs feel sluggish, that is the cause. Throttle
  updates to ~30ms before reaching for a different renderer.

## 8. Definition of done

- [ ] Submitting the form navigates in under a second
- [ ] `curl -N` shows progressive SSE frames
- [ ] Lab steps render as they generate
- [ ] Starter code generates only after the lab is readable, with its own indicator
- [ ] Exactly one row each in `lab_generations` / `conversations` / `messages`
- [ ] Reload shows the same content that streamed
- [ ] Stop aborts and persists nothing
- [ ] Scrolling up mid-stream is not fought by autoscroll
- [ ] Phase 2: chat streams, notes extraction still fires

---

# Learning notes

### Optimise the critical path, not the easy path

The first draft of this document planned to migrate chat first, because chat is
plain text and lab generation is structured output — genuinely easier. That was
the wrong call: chat is ~500 output tokens and lab generation is ~5000 across two
sequential calls. Optimising chat first would have been real work for a barely
perceptible win.

"Where is the time actually going" beats "what is easiest to change" every time,
and it is worth being suspicious when those two answers conveniently coincide.
Measure before sequencing.

### Sequential awaits are a latency decision

```ts
const labContent = await llm.invoke(...)
const starter = await starterCodeService.generate(..., labContent)
```

The second call genuinely depends on the first, so you cannot parallelise them.
But you *can* ask whether the user needs to wait for both — and here they do not,
because the lab is useful the moment it is readable.

That reframing is the win, not streaming itself. Look for it whenever you see
awaits in a row: is this a data dependency, or just the order you wrote it in?

### Streaming inverts "responding" and "knowing"

Normally you compute a result, then describe it: status, headers, body — all
decided before anything is sent. Streaming forces you to commit to the
description first. Once `flushHeaders()` runs, `200 OK` is a promise you cannot
retract.

That is why Step 3 pushes every fallible operation above the flush. It
generalises: **when a protocol makes part of your response irrevocable, do all
your failing before you reach that point.** Same reasoning as HTTP trailers,
two-phase commit, and validating a migration before mutating.

Choosing SSE partly dissolves this, because an error can be sent *as data* rather
than as a status code. Picking a richer protocol can be cheaper than engineering
around a thin one.

### Chunk boundaries carry no meaning

The most useful mental model for streams: chunk boundaries are determined by MTU,
TLS record size, and proxy buffering — never by your data. A chunk can split a
UTF-8 character, an SSE frame, or a JSON object in half.

So every stream consumer needs a buffer and a framing rule. `TextDecoder({stream:
true})` is the buffer for character boundaries; `split('\n\n')` plus keeping the
remainder is the framing rule for SSE; `partialOutputStream` is the AI SDK doing
partial-JSON framing for you. Same idea three times.

Once you see it you will notice it everywhere: length prefixes, delimiters, and
self-describing formats all exist to solve exactly this.

### Cancellation must be threaded, not bolted on

Stop works because one `AbortSignal` connects five layers: browser fetch → TCP
close → Express `'close'` → `AbortController` → AI SDK → OpenAI's HTTP request.
Break any link and the upstream call keeps running and keeps billing you.

This is the most commonly skipped piece of AI plumbing and the most expensive to
skip. Cancellation is not a feature you add at the top — it is a signal you plumb
through the entire call stack.

### "Fire and forget" is a decision, not an oversight

`chat.service.ts:39` already does this: notes extraction runs with
`.catch(console.error)` and the response does not wait. That is a deliberate
latency/durability trade — faster responses, and in exchange a crashed process
silently loses a note.

§4.3 is where that trade stops being acceptable: on serverless, work started
after `res.end()` may never run at all, because the instance can be frozen. The
fix here was to keep the connection open, which works because there is a user
waiting. It would not work for anything genuinely long-running.

The durable answer is a queue: write an intent record, process it, mark it done.
Recognising the shape now is the point — you do not have to build it yet.

### Perceived performance is not performance

Streaming does not make generation faster. Total time to a complete lab is
roughly unchanged, and you have added real complexity: an async generator, SSE
framing on both ends, partial-object rendering, abort plumbing, scroll management.

What changed is time-to-first-content, and that is the number users feel. A
60-second generation you can start reading at second three is experienced as
dramatically faster than a 45-second blank spinner.

The honest framing: you traded engineering complexity for perceived speed, and it
was a good trade *here* because the wait is long and the output is naturally
sequential. It would be a bad trade for a 200ms endpoint. Knowing which situation
you are in — rather than reaching for streaming reflexively because AI apps have
it — is the actual skill.
