# Lab Generation Accuracy — Problem Analysis & Fixes

**Problem:** Generate Lab mode produces labs with mistakes — wrong commands, stale
APIs, invented flags — because the model has no correct documentation to refer to
when generating.

---

## Where the accuracy problem comes from

The entire generation is `packages/server/services/labGeneration.service.ts:58-67`.

- **Model is `gpt-4o`** — an old model with a knowledge cutoff well before current
  library versions. Likely the single biggest source of wrong commands/APIs.
- **The prompt is one sentence.** No system prompt, no rules about version pinning,
  no "don't invent flags," no output constraints beyond the Zod shape.
- **Zero grounding.** Nothing retrieves real documentation. The model writes from
  memory, which is exactly the failure being described.
- **`maxOutputTokens: 2000`** is tight for a multi-step lab. Truncation mid-generation
  produces mangled steps that read like mistakes.
- **No verification pass.** Nothing checks that commands or package versions exist
  before the lab is written to the DB.
- **Topic is free text** (`packages/client/src/components/lab/LabGeneratorForm.tsx:11-15`,
  max 500 chars), despite `project-scope.md` describing a curated list. Free text
  means per-topic documentation can't be pre-attached.

`project-scope.md` already flags this under Open / Deferred:
*"Verification/trust pipeline for LLM-generated lab instructions."* This is that
item coming due.

---

## Fixes, cheapest first

### 1. Upgrade the model — minutes, large impact

`openai('gpt-4o')` → a current frontier model. Same for
`packages/server/services/starterCode.service.ts:21`.

Newer models have both a later cutoff and far better instruction-following on
"say you're unsure rather than inventing." Do this before anything else, so the
remaining work isn't engineering around a stale-model problem.

### 2. Rewrite the prompt with a real system message — ~1 hour, large impact

The `starterCode.service.ts` prompt is already much better than the lab prompt —
it has explicit rules. Bring the lab prompt up to that standard:

- "Prefer stable, widely-used tooling over the newest release."
- "If you are not confident a command, flag, or version is correct, describe the
  step in prose and tell the learner where to look it up — do not invent a command."
- "Pin versions only when you are confident; otherwise instruct the learner to
  install latest."
- Environment-specific rules (brew vs apt vs winget) instead of leaving
  `${environment}` to do all the work.

Also revisit `maxOutputTokens: 2000` so longer labs aren't truncated.

### 3. Ground generation in real docs — the actual fix, days

Three options, roughly increasing cost:

| Option | How | Tradeoff |
|---|---|---|
| **Web search tool** | Give the model a search tool via the AI SDK; require it to look up install/setup steps for the topic's primary tool before writing. | Simplest real grounding; works with free-text topics. Can be noisy. |
| **Docs retrieval (Context7-style)** | Resolve the topic to a library ID, fetch current docs, inject as context. | Higher precision than search; only covers topics that map cleanly to a library. |
| **Curated topic packs** | Return to the scoped curated topic list; hand-attach a small vetted doc/command snippet per topic. | Highest quality, doesn't scale. For a v1 with ~20 topics it's very strong. Also restores the `(topic, skill_level)` cache key from the scope doc. |

### 4. Add a verification pass — ~1 day

A second LLM call that reviews the generated lab against the retrieved docs and
flags steps with wrong commands, then either repairs them or marks them
"unverified" in the UI.

Cheaper than execution, catches most confabulated flags. Requires a schema change
to carry a per-step verification status.

### 5. Measure it — ~1-2 days

LangFuse is already wired up (`packages/server/lib/instrumentation.ts`, callback
handlers in both services), but it's tracing only right now.

Add a dataset of ~30 representative (topic, skill level, environment) triples and
an LLM-judge scoring for "are the commands plausible/current," then run it before
and after each change above. Without this, there's no way to tell whether any of
1-4 helped.

### 6. Execution-based validation — weeks, probably out of scope for v1

Run generated shell steps in an ephemeral container and gate on exit codes. The
only thing that gives real certainty, but it conflicts with the scope's
"the site does not execute anything on the user's behalf."

---

## Recommended order

1. **Do 1 and 2 today** — nearly free, and may resolve most of the observed problem.
2. **Then 5** — so it's possible to tell whether 3 is worth building.
3. **Then 3 via web search**, with curated topic packs as the upgrade path if
   search proves too noisy.
