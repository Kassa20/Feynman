# Grounding starter code in real docs with an MCP server

> **Status:** design + full implementation walkthrough. No code has been written yet.
> This document is meant to be read top-to-bottom and then followed step by step.

---

## Part 1 — Understanding the problem

### What's broken

Open `packages/server/services/starterCode.service.ts`. The prompt contains this rule:

```
- Always include a dependency manifest idiomatic to the language you chose
  (requirements.txt for Python, package.json for Node, go.mod for Go, ...)
  listing every dependency the lab needs, with pinned versions.
```

We are asking the model to write **exact version numbers from memory**.

Think about what that actually requires. The model would have to have memorised,
for every package in every ecosystem, which version was current — and its training
data was frozen months or years ago. It cannot do this. But it has been *told* to
produce pinned versions, so it produces something. That something is a plausible-
looking string like `fastapi==0.104.1`. Sometimes it's real. Often it isn't, or it's
two years stale, or it conflicts with another pin in the same file.

This is the single most common LLM failure mode, and it has a name: the model is
**confabulating**. Not lying, not broken — it is doing exactly what it was trained
to do, which is produce the most likely-looking next token. "A version number goes
here" is a pattern it knows perfectly. "*Which* version number" is a fact it does
not have.

### The second half of the bug

You also reported **missing packages**. That one has a different cause, and it's
worth spotting because it's a plain code bug, not an AI problem.

Look at line 44 of the same file:

```ts
const stepTitles = labContent.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
```

We build the prompt from step **titles only**. But look at the lab schema in
`labGeneration.service.ts:16`:

```ts
steps: z.array(z.object({
    title: z.string(),
    description: z.string(),   // <-- we throw this away
    code: z.string().nullable(), // <-- and this
}))
```

A step title says *"Set up the database connection."* The **description** is where
the lab says *"...using SQLAlchemy's async engine with asyncpg as the driver."*
Those two package names — the ones the starter code needs to install — are in the
text we discard before we ever call the model.

So: we starve the model of context, then ask it to recall facts it doesn't have.
Two separate fixes.

### Why an MCP server is the right instinct

Your idea — connect the agent to a documentation server — is correct, and it's
correct for a specific reason worth internalising:

> **When a model doesn't know a fact, don't prompt harder. Give it a way to look
> the fact up.**

No amount of "be accurate!" or "use real versions!" in a prompt can create
information that isn't in the weights. Prompt engineering shapes *behaviour*.
Tool use supplies *facts*. You have a facts problem.

### What MCP actually is

MCP (Model Context Protocol) is a standard way for a program to expose **tools** to
a language model. That's it. It's a protocol — like HTTP is a protocol — that says
"here is how a tool server describes what it can do, and here is how you call it."

Before MCP, if you wanted your app to talk to five different tool providers, you
wrote five different integrations. With MCP, you speak one protocol and any
compliant server plugs in.

**Context7** is an MCP server run by Upstash that indexes library documentation. It
exposes exactly two tools:

| Tool | Input | Output |
|---|---|---|
| `resolve-library-id` | `libraryName`, `query` | Candidate library IDs like `/vercel/next.js` |
| `query-docs` | `libraryId`, `query` | Relevant documentation snippets |

The two-step shape exists because "fastapi" is ambiguous — there could be several
indexed projects — so you resolve a name to a stable ID first, then fetch docs for
that ID. You already use this server inside Claude Code; we're going to let your
*application's* model use it too.

---

## Part 2 — Two design decisions, and why

Before writing code, two choices need justifying. If you only remember two things
from this document, make it these.

### Decision 1: Do NOT add tools to the existing `Output.object` call

The obvious move is to bolt the MCP tools onto the call we already have:

```ts
// ❌ Tempting. Don't.
const { output } = await generateText({
    model: openai('gpt-5.6-luna'),
    output: Output.object({ schema: starterCodeSchema }),
    tools: await mcpClient.tools(),
    stopWhen: isStepCount(8),
    // ...
})
```

One call, tools *and* structured output. Fewer moving parts. Why not?

Because of how AI SDK 7 implements structured output. From the SDK source
(`packages/ai/src/generate-text/generate-text.ts`):

```ts
// parse output only if the last step was finished with "stop":
let resolvedOutput;
if (lastStep.finishReason === 'stop') {
    resolvedOutput = await outputSpecification.parseCompleteOutput(...)
}
```

Read that carefully. `output` is populated **only** when the final step finished
naturally. Now consider what a tool loop does: the model calls a tool, gets a
result, calls another tool, gets a result... and each of those steps finishes with
`finishReason: 'tool-calls'`, not `'stop'`.

If the model is still mid-lookup when it hits `isStepCount(8)`, the loop halts on a
`'tool-calls'` step. `resolvedOutput` stays `undefined`. Your `output` is
`undefined`. Then this line:

```ts
return { ...output, files: output.files.filter(...) }
//                        ^^^^^^^^^^^ TypeError: Cannot read properties of undefined
```

...throws, and the user's starter code fails entirely.

So the "simpler" design has a failure mode that is **non-deterministic** (it depends
on how many lookups the model decides to do) and **worse than the bug we're fixing**
(no code at all, instead of code with bad pins). We'd be trading a quality problem
for a reliability problem.

**Instead: split into two phases.**

```
Phase 1 — RESEARCH        Phase 2 — GENERATE
tools: yes                tools: no
output: plain text        output: Output.object
can loop                  single shot, deterministic
can fail safely → null    unchanged from today
        │                         ▲
        └──── dependency brief ───┘
```

Phase 1 uses tools but returns free-form text, so `finishReason` never matters —
we just read `result.text`, which is always populated. Phase 2 keeps its structured
output and has no tools, so it behaves exactly as it does today. Neither phase can
break the other.

This is a general pattern worth naming: **separate the step that gathers
information from the step that produces the artifact.** Gathering is messy,
variable-length, and failure-prone. Producing needs to be rigid and schema-shaped.
Don't make one call do both.

### Decision 2: Failure must degrade, not propagate

Context7 is a third-party HTTP service. It will, at some point, be slow, rate-limit
you, or be down. When that happens, what should the user see?

The wrong answer is "an error." The lab generated fine. The starter code would have
generated fine ninety seconds ago. A docs lookup failing is a reason for *slightly
worse pins*, not for *no starter code*.

So `docsResearchService.research()` will be written to **never throw**. It catches
everything and returns `null`, and `null` simply means "no brief to inject" — the
prompt falls back to what it does today. The feature is an *enhancement layer*, and
enhancement layers must be removable at runtime.

---

## Part 3 — Implementation

Four files, in dependency order. Read each step's explanation before copying code.

### Step 0 — Install the package

```bash
cd packages/server
bun add @ai-sdk/mcp
```

**Verify you got the right major version.** MCP support ships separately from the
`ai` package and is versioned against it:

```bash
npm view @ai-sdk/mcp dist-tags
# { latest: '2.0.29', 'ai-v6': '1.0.67', 'ai-v5': '0.0.27', ... }
```

This repo has `ai@7.0.34`, so you want the `latest` (2.x) line. If `package.json`
ends up with `^1.x` or `^0.x` you've installed the AI SDK 6 or 5 build and the
types won't line up. Check:

```bash
grep '@ai-sdk/mcp' package.json   # expect "^2.0.29"
```

---

### Step 1 — Get a Context7 API key

Sign in at [context7.com](https://context7.com) and create an API key.

**Local development** — add to `packages/server/.env`:

```
CONTEXT7_API_KEY=ctx7sk-...
```

Bun loads `.env` automatically. Do not add `dotenv` (see `packages/server/CLAUDE.md`).

**Production** — set it in the **Cloud Run console** on the `feynman-server`
service, *not* in the deploy workflow.

Why not the workflow? Read the comment in `.github/workflows/deploy.yml`:

```yaml
# Env vars are deliberately not passed: omitting them leaves the
# service's existing configuration (OPENAI_API_KEY, SUPABASE_*, LANGFUSE_*)
# untouched. Change those in the Cloud Run console, not here.
```

`gcloud run deploy --set-env-vars` **replaces the entire env var set**, it doesn't
merge. Adding one variable to that workflow would silently delete
`OPENAI_API_KEY` and every Supabase credential on the next deploy. The existing
design avoids that trap; don't reintroduce it.

---

### Step 2 — New file: `packages/server/services/docsResearch.service.ts`

This is the only file in the codebase that will know MCP exists. Everything else
just receives a string.

```ts
import { createMCPClient } from '@ai-sdk/mcp';
import { openai } from '@ai-sdk/openai';
import { generateText, isStepCount } from 'ai';
import type { LabContent } from './labGeneration.service';

// Context7 lookups are network round trips and the model may make several.
// Cap the whole phase so a slow docs server can't stall lab generation.
const RESEARCH_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
    `You are a build engineer who verifies dependencies before a project is scaffolded. ` +
    `You have tools that read current library documentation. Use them — never rely on ` +
    `your own recollection of package names or version numbers, which is out of date.`;

export const docsResearchService = {
    /**
     * Looks up current documentation for the libraries this lab needs and returns
     * a plain-text brief for the starter-code prompt.
     *
     * Never throws. Returns null when research is unavailable (no API key, the
     * docs server is down, the timeout fires), in which case starter-code
     * generation proceeds exactly as it did before this feature existed.
     */
    async research(
        topicText: string,
        labContent: LabContent,
        abortSignal: AbortSignal,
    ): Promise<string | null> {
        if (!process.env.CONTEXT7_API_KEY) return null;

        let mcpClient;
        try {
            mcpClient = await createMCPClient({
                transport: {
                    type: 'http',
                    url: 'https://mcp.context7.com/mcp',
                    headers: { Authorization: `Bearer ${process.env.CONTEXT7_API_KEY}` },
                },
            });

            const steps = labContent.steps
                .map((s, i) => `${i + 1}. ${s.title}\n   ${s.description}`)
                .join('\n');

            const { text } = await generateText({
                model: openai('gpt-5.6-luna'),
                tools: await mcpClient.tools(),
                stopWhen: isStepCount(8),
                abortSignal: AbortSignal.any([
                    abortSignal,
                    AbortSignal.timeout(RESEARCH_TIMEOUT_MS),
                ]),
                telemetry: { functionId: 'research-lab-dependencies' },
                system: SYSTEM_PROMPT,
                prompt:
                    `A starter-code project is about to be scaffolded for this lab:\n\n` +
                    `Topic: ${topicText}\n` +
                    `Title: ${labContent.title}\n` +
                    `Steps:\n${steps}\n\n` +
                    `Identify every library, framework and runtime this project must ` +
                    `install. For each one, use the tools to resolve it and read its ` +
                    `installation and setup documentation.\n\n` +
                    `Then report:\n` +
                    `- the exact package name as published to its registry\n` +
                    `- the version the current documentation demonstrates\n` +
                    `- the install command\n` +
                    `- any peer or companion package the docs say is also required ` +
                    `(database drivers, type packages, build plugins)\n\n` +
                    `If you could not verify something, say so explicitly instead of ` +
                    `guessing. An honest "unverified" is more useful than a wrong version.`,
            });

            return text;
        } catch (error) {
            // Research is an enhancement. Losing it must never cost the user
            // their starter code, so swallow everything and let the caller
            // fall back to the unaugmented prompt.
            console.error('[docs-research] lookup failed, continuing without it:', error);
            return null;
        } finally {
            await mcpClient?.close();
        }
    },
};
```

#### Walking through the parts that matter

**`if (!process.env.CONTEXT7_API_KEY) return null;`**
The cheapest possible failure. If the key isn't configured — a fresh clone, a
teammate's machine, a misconfigured Cloud Run service — we skip the whole phase
without an error, without a network call, without a log line. The feature is simply
off.

**`createMCPClient({ transport: { type: 'http', ... } })`**
The `http` transport is streamable HTTP, the current recommended transport for
remote MCP servers. Two things to note:

- The `Authorization: Bearer` header is how Context7 authenticates you. Same header
  scheme as your own API — nothing exotic.
- The SDK also accepts an explicit `StreamableHTTPClientTransport` object from
  `@modelcontextprotocol/sdk`. You don't need it. The `{ type: 'http' }` shorthand
  constructs the same thing and keeps a dependency out of your `package.json`.

**`await mcpClient.tools()`**
This is the interesting line. It performs the MCP handshake: asks the server "what
can you do?", receives back the tool definitions (name, description, JSON Schema
for arguments), and converts them into the SDK's tool format. You never write a
`tool({ ... })` definition by hand. The server describes itself; the SDK adapts it.

That's the whole point of a protocol — Context7 can add a third tool tomorrow and
your model gains it with no code change on your side.

**`stopWhen: isStepCount(8)`**
Without this the model gets exactly one turn, which means it could call a tool but
never see the result. `stopWhen` turns a single call into an **agent loop**: call
tool → run tool → feed result back → let the model decide what's next → repeat,
until it stops on its own or the limit trips.

Eight steps is roughly "resolve and query three or four libraries." Budget it:
`resolve-library-id` + `query-docs` is two steps per library.

This is the first tool-calling code in the repo — there is currently no `tools:`,
`stopWhen:` or `maxSteps` anywhere in `packages/server`. Everything else is
single-shot. Worth knowing when you're debugging: this call behaves differently
from every other LLM call in the codebase.

**`AbortSignal.any([abortSignal, AbortSignal.timeout(...)])`**
Two independent reasons to stop:

1. `abortSignal` — the user navigated away or cancelled. Threaded down from
   `labGeneration.service.ts`, which threads it from the controller.
2. `AbortSignal.timeout(30_000)` — Context7 is being slow.

`AbortSignal.any` combines them: whichever fires first aborts the call. Without the
timeout, a hanging tool call would block starter code indefinitely while the client
sits on "Generating starter code…" with no way out.

**`telemetry: { functionId: 'research-lab-dependencies' }`**
`lib/instrumentation.ts` wires Langfuse into OpenTelemetry, so this call is traced
automatically — including every MCP tool call as a nested child span. You will be
able to open a trace and read exactly which libraries the model looked up and what
docs came back. For a feature whose whole purpose is factual accuracy, that
visibility is not optional; it's how you'll debug it.

Note the field is **`telemetry`**, not `experimental_telemetry`. AI SDK 7 promoted
it out of experimental. Every other service in this repo already uses the new form
(`generate-starter-code`, `generate-quiz`, `extract-note`, `judge-answer-key`) —
match them.

**`finally { await mcpClient?.close() }`**
The MCP client holds an open HTTP connection. Not closing it leaks a socket per
lab generation. On Cloud Run, where instances are reused across many requests,
leaked sockets accumulate until the instance degrades — and this is the kind of bug
that never shows up in local testing because you restart the dev server constantly.

`finally` guarantees it runs on the success path, the error path, and the abort
path. The `?.` handles the case where `createMCPClient` itself threw and
`mcpClient` was never assigned.

**The prompt's last instruction**
> *"If you could not verify something, say so explicitly instead of guessing."*

This matters more than it looks. Giving the model tools does not stop it
confabulating — it just gives it an *alternative*. You have to make the alternative
explicitly acceptable. A model that believes it must produce a version number will
produce one whether or not it found it. A model told "unverified is a valid answer"
will use it. You are removing the pressure that caused the original bug.

---

### Step 3 — Edit `packages/server/services/starterCode.service.ts`

Three changes. Everything else — the schema, `Output.object`, `isSafePath` — stays
exactly as it is.

#### 3a. Accept the brief

```ts
async generate(
    topicText: string,
    skillLevel: string,
    environment: TargetEnvironment,
    labContent: LabContent,
    dependencyBrief: string | null,   // <-- new
    abortSignal: AbortSignal,
): Promise<starterCode> {
```

> Aside: the current parameter is named `SkillLevel` with a capital S, which shadows
> the imported `SkillLevel` *type*. Renaming it to `skillLevel` while you're here is
> a safe one-word fix, but it's cosmetic — skip it if you'd rather keep the diff
> minimal.

#### 3b. Send step descriptions, not just titles

This is the fix for **missing packages**, and it is independent of MCP. Replace:

```ts
// before — throws away the text that names the libraries
const stepTitles = labContent.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
```

with:

```ts
const steps = labContent.steps
    .map((s, i) => `${i + 1}. ${s.title}\n   ${s.description}`)
    .join('\n')
```

and update the prompt line from `Steps:\n${stepTitles}` to `Steps:\n${steps}`.

Do this even if you never wire up MCP. It costs a few hundred tokens and it hands
the model the sentence where the lab names its actual dependencies.

#### 3c. Inject the brief and soften the pinning rule

Build the block conditionally, so a `null` brief produces today's exact prompt:

```ts
const briefBlock = dependencyBrief
    ? `Verified dependency documentation, retrieved from the libraries' current ` +
      `docs just now. Prefer this over your own recollection of package names and ` +
      `version numbers:\n\n${dependencyBrief}\n\n`
    : ''
```

Insert `briefBlock` immediately before the `Rules:` line, then rewrite the manifest
rule:

```ts
`- Always include a dependency manifest idiomatic to the language you chose ` +
`(requirements.txt for Python, package.json for Node, go.mod for Go, Cargo.toml ` +
`for Rust, etc.) listing every dependency the lab needs.\n` +
`- Pin a version ONLY when it appears in the verified documentation above. For ` +
`anything unverified, use an unpinned or minimum-bound requirement rather than ` +
`inventing a number. A wrong pin breaks the install; a loose one does not.\n` +
```

Note what changed conceptually. The old rule demanded pins unconditionally, which
*forced* fabrication when the model didn't know. The new rule makes pinning
conditional on evidence and gives an explicit escape hatch. Same lesson as in the
research prompt: **never write a rule that can only be satisfied by guessing.**

The last sentence — *"A wrong pin breaks the install; a loose one does not"* —
tells the model which way to err. Stating the asymmetry of the failure modes is far
more effective than "be careful."

---

### Step 4 — Edit `packages/server/services/labGeneration.service.ts`

Add the import:

```ts
import { docsResearchService } from './docsResearch.service';
```

Then, in the existing `if (starterCode)` block (currently lines 92–104), add one
line before the `starterCodeService.generate` call:

```ts
let starterCodeContent = null
if (starterCode) {
    yield {type: 'starter-code-start'};
    try {
        const brief = await docsResearchService.research(
            topicText, labContent, abortSignal,
        )
        starterCodeContent = await starterCodeService.generate(
            topicText, skillLevel, environment, labContent, brief, abortSignal,
        )
    } catch (error) {
        if (abortSignal.aborted) return;
        console.error('[labs] starter code generation failed:', error)
        updateActiveObservation({ metadata: { starterCodeFailed: true } })
        yield {type: 'starter-code-failed'}
    }
}
```

That's the entire integration. Three points:

**Why sequential and not parallel?** The brief is an *input* to generation. There's
nothing to overlap — generation cannot start until research finishes.

**Why inside the existing `try`?** Belt and braces. `research()` is written never to
throw, but if that contract is ever violated the existing catch already handles it
correctly: log, mark the Langfuse observation, emit `starter-code-failed`.

**Why no new SSE event?** The client (`components/chat/ChatBot.tsx`) already shows
"Generating starter code…" from `starter-code-start` until `lab-done`. Research
happens inside that window, so the indicator is already accurate. Adding a
`starter-code-research` event would mean touching the event union, the controller,
and the client's phase state machine — real complexity for a slightly more specific
loading label. Skip it unless the wait feels confusing in practice.

---

## Part 4 — The tradeoff you're accepting

Be clear-eyed about the cost. You are adding, on the critical path:

- one extra LLM call (the research loop)
- several Context7 HTTP round trips inside it

Realistically **10–25 seconds** on top of starter-code generation, during which the
user stares at "Generating starter code…".

That is the price of correct dependencies, and it's probably worth paying — a
manifest that doesn't install wastes far more than 25 seconds of the learner's
time. But if it feels too slow once you've tried it, the cheapest lever is dropping
`isStepCount(8)` to `4`: roughly two libraries verified instead of four. Verify the
two that matter rather than none.

---

## Part 5 — Verifying it works

Do these **in order**. Step 5 is the one people skip and shouldn't.

**1. Package is correct**
```bash
cd packages/server && grep '@ai-sdk/mcp' package.json   # expect ^2.x
```

**2. Servers start clean**
```bash
cd packages/server && bun --watch run index.ts   # → "Server listening on port 3000"
cd packages/client && bun run dev                # → http://localhost:5173
```

**3. Generate a lab on a fast-moving stack**
Pick a topic whose ecosystem churns, where the old behaviour was most likely wrong
— *"Build a REST API with FastAPI"*, *"Server components in Next.js"*,
*"Vector search with pgvector and LangChain"*. Tick the **starter code** checkbox.

**4. A/B the manifest — this is the actual pass/fail test**
Download the zip. Open `requirements.txt` / `package.json`. For each entry:

- Does the package exist under that exact name on the registry?
- Does the pinned version exist?
- Is every library named in the lab's step descriptions present?

Then compare against a zip generated on the same topic **before** the change. If
you didn't keep one, `git stash` your work and generate one. A single "looks fine"
proves nothing — you're measuring an improvement, so you need the baseline.

**5. Read the Langfuse trace**
Open the `lab-generation` trace. You should see a new
`research-lab-dependencies` observation with MCP tool calls nested beneath it.
Click into them and read the inputs and outputs.

This is where you learn whether the feature is *actually* working or just appearing
to. Watch for: did it look up the right libraries? Did `resolve-library-id` return
the project you expected, or a same-named impostor? Did the docs actually contain
version information, or did `query-docs` return prose that mentions no versions at
all? A brief that says nothing useful will produce output indistinguishable from
having no brief.

**6. Break it on purpose**
Comment out `CONTEXT7_API_KEY` in `.env`, restart, generate again.

**Expected:** starter code is still produced. No `starter-code-failed` reaches the
client. No user-visible error. Nothing in the server log except, at most, your
`[docs-research]` line.

Then try it with a bad key (`CONTEXT7_API_KEY=nonsense`) to exercise the `catch`
path rather than the early return — those are different code paths and both need
to degrade silently.

If either test surfaces an error to the user, the graceful-degradation contract is
broken and must be fixed before this ships. An enhancement layer that can take down
the feature it enhances is worse than no enhancement.

---

## Part 6 — If versions are still wrong afterwards

Worth understanding the limit of this fix before you're surprised by it.

Context7 serves **documentation**. Documentation reliably tells you the correct
package *name*, the correct install command, and which companion packages you also
need. What it gives you for *versions* is whatever version the docs happened to be
written against — which is usually current, but is not a guarantee.

The authority on "what version is current" is the **package registry**, not the
docs. If pinning is still off after this change, the follow-on is a small local
tool defined alongside the MCP tools:

```ts
tools: {
    ...await mcpClient.tools(),
    latestVersion: tool({
        description: 'Get the current published version of a package',
        inputSchema: z.object({
            ecosystem: z.enum(['npm', 'pypi']),
            name: z.string(),
        }),
        execute: async ({ ecosystem, name }) => { /* fetch the registry JSON */ },
    }),
}
```

Roughly twenty lines, and it makes pinning exact rather than probable. It also
demonstrates something useful: MCP tools and hand-written local tools are the same
kind of object to the model. You can mix them freely in one `tools` map.

**Don't build this yet.** Ship the MCP change, measure with step 4 above, and add
the registry tool only if the numbers are still wrong. Do the cheap fix, measure,
then decide — building both at once means you won't know which one worked.
