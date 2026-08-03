# Observability & Evaluation — Learnings

A primer written against the actual Feynman codebase. Assumes no prior background in either topic.

---

## 1. The problem, in plain terms

Feynman makes four separate calls to a large language model. Right now, once a request leaves your server, **you have no idea what happened**. If a user says "the lab it generated was garbage," you cannot answer any of these:

- What exact prompt did we send?
- What exactly did the model return?
- How long did it take? How many tokens? What did it cost?
- Did it fail, or did it succeed and just produce something bad?
- Is this happening to one user or all of them?
- Was it worse than last week?

The only trace of any LLM call in the entire server is:

```ts
// packages/server/controllers/chat.controller.ts:48
console.error('[chat] error:', error)
```

That fires only on a thrown exception. The far more common failure — the model returns a perfectly valid response that is *wrong, off-topic, or low quality* — produces no signal at all. It looks identical to success.

Two different disciplines solve two different halves of this:

| | Question it answers | When it runs |
|---|---|---|
| **Observability** | "What actually happened in production?" | Continuously, on real traffic |
| **Evaluation** | "Is the output any good?" | On demand, against a fixed test set |

You need both. Observability without evaluation tells you the system is fast and cheap but not whether it's useful. Evaluation without observability tells you it passes your tests but not what real users are hitting.

---

## 2. Observability

### 2.1 What it means for LLM apps specifically

Traditional monitoring (uptime, error rate, p99 latency) assumes that a 200 response means success. For LLM apps that assumption breaks completely. A 200 with a fluent, confident, wrong answer is the *characteristic* failure mode. So LLM observability means capturing the **content** of every model interaction, not just its status code.

### 2.2 The vocabulary

You'll see these five words everywhere. They're the whole model:

**Trace** — one end-to-end user request. In Feynman, one `POST /api/chat` is one trace. One `POST /api/labs/generate` is one trace.

**Span (or Observation)** — one unit of work inside a trace. A trace is a tree of spans. A lab generation trace would contain: a `generate-lab` span, inside it an LLM call span, then a sibling `generate-starter-code` span with its own LLM call, then a `db-write` span.

**Generation** — a special kind of span representing an LLM call specifically. It carries the extra fields you care about: model name, input messages, output text, prompt/completion token counts, cost, temperature, latency, time-to-first-token.

**Session** — a group of traces that belong together. In Feynman this maps *exactly* onto your `conversationId`. A user generates a lab, then asks five follow-up questions — that's six traces, one session. Being able to replay a whole conversation is enormously useful for debugging.

**Score** — a number or label attached to a trace or generation. This is the bridge to evaluation. Scores can come from user feedback (thumbs up), from code (did the JSON parse?), from another LLM (is this on-topic?), or from a human reviewing manually.

### 2.3 What you get once it's wired up

- **Full replay.** Click any conversation and see every prompt, every response, every intermediate step, in order, with timings.
- **Cost per feature.** You'll immediately learn that `starterCode.service.ts` (3000 max tokens) is likely your single most expensive call, and that `notes.service.ts` fires on *every single chat turn* whether or not it saves anything — a cost you're currently paying blind.
- **Latency breakdown.** Your whole streaming architecture exists to reduce perceived latency (per your recent commits). Right now you're optimizing without measurement. Time-to-first-token is the metric that actually matters for `streamText`, and you can't see it.
- **Failure visibility.** See §4 for the specific things currently failing silently in this codebase.
- **Per-user debugging.** Every request already carries `req.user!.id`. Attach it and you can pull up one student's entire history when they report a problem.

---

## 3. Evaluation

### 3.1 What it means

An eval is a **repeatable test for non-deterministic output**. The core difficulty: you cannot assert `output === expected`, because the model will phrase things differently every time and that's fine.

So instead of exact matching, you score outputs along dimensions you care about, and you track whether the average score goes up or down when you change something.

### 3.2 The four kinds of evaluator

Ordered from cheapest and most reliable to most expensive and least reliable. **Most people reach for #3 first. That's a mistake — exhaust #1 before touching #3.**

**1. Deterministic / code-based.** Plain assertions. Free, instant, 100% reliable. Applies whenever a requirement is mechanically checkable.

Feynman is unusually rich in these, because you've already written the rules down as prose in your prompts. Look at `starterCode.service.ts` — the prompt says:

> "Always include a dependency manifest…", "Always include a README.md…", "Keep it under 8 files.", "Use relative paths only."

Every one of those is an `expect()` waiting to be written. You are currently *asking* the model to follow four hard rules and never checking whether it did. (You partially check paths — `isSafePath` — but see §4.)

**2. Human annotation.** You (or a TA, or a student) look at outputs and rate them. Slow, doesn't scale, but it's the ground truth everything else is calibrated against. Twenty hand-labelled examples are worth more than a thousand unreviewed ones.

**3. LLM-as-a-judge.** A second LLM call scores the first one's output against a rubric. Necessary for genuinely subjective qualities — "is this explanation clear for a beginner?", "is this on-topic?". Costs money, adds latency, and is itself unreliable, so you must validate the judge against human labels before you trust it.

**4. User feedback.** Thumbs up/down in the UI. The most honest signal you can get, and nearly free to collect. Its weakness is sparsity — most users rate nothing.

### 3.3 Online vs offline

**Offline eval** runs against a fixed dataset before you ship. This is a regression test. You change `SYSTEM_PROMPT`, you re-run the suite, you compare scores to the previous run. This is what stops you from "fixing" one behaviour and silently breaking another.

**Online eval** runs against live production traffic, sampled. It catches drift and real-world inputs your test set never imagined.

Start offline. It's cheaper, deterministic, and it's the one that gives you the confidence to change prompts.

### 3.4 The dataset is the hard part

The eval framework is easy; the test cases are the work. A dataset is just a list of `{ input, expectedOutput? }`. Twenty good cases beat two hundred lazy ones.

The best source of cases is **production traces** — which is the deep reason to do observability first. You ship, you watch real conversations, you find the ten that went badly, and those become your dataset. Building an eval set from imagination before you have traffic means you'll test the failures you guessed at rather than the ones you have.

---

## 4. Applied to Feynman: what's invisible right now

### 4.1 The four LLM call sites

| # | File | SDK | Model / limit | Purpose |
|---|---|---|---|---|
| 1 | `services/chat.service.ts` | AI SDK `streamText` | gpt-4o / 500 tok | Student Q&A, guardrailed to CS topics |
| 2 | `services/labGeneration.service.ts` | AI SDK `streamText` + `Output.object` | gpt-4o / 2000 tok | Structured lab, streamed as partial objects |
| 3 | `services/starterCode.service.ts` | LangChain `ChatOpenAI.withStructuredOutput` | gpt-4o / 3000 tok | Multi-file stub project |
| 4 | `services/notes.service.ts` | LangChain `ChatOpenAI.withStructuredOutput` | gpt-4o / 300 tok | Classifier + summariser, fire-and-forget |

Note you're spanning **two different SDKs**. That matters for tool choice (§5) — you want one dashboard, not two.

### 4.2 Specific silent failures in the current code

These are real, in your repo today:

**Notes extraction fails invisibly.**
```ts
// chat.service.ts:59-61
notesService
    .extractAndSave(prompt, responseText, userId, labGenerationId, conversationId)
    .catch((err) => console.error('[notes] extraction failed:', err))
```
Fire-and-forget with a `console.error` sink. If OpenAI rate-limits you, or the structured output fails to validate, every note silently stops being saved. The user sees a working chat and an empty notes page. Nobody is alerted. There is no counter of how often this fires.

**The `shouldSave` classifier is unmeasured.** This is a binary classifier deciding what's worth remembering — the single most eval-able component in your codebase, and you have no idea what its precision or recall is. It could be returning `false` 100% of the time and the app would look completely normal.

**`isSafePath` silently drops files.**
```ts
// starterCode.service.ts:64
return { ...result, files: result.files.filter((f) => isSafePath(f.path))}
```
If the model emits an absolute path, that file vanishes with zero logging. The user downloads a zip with a missing file and no explanation. You'd want a span event every time this filter removes something — it's telling you your prompt isn't working.

**Starter-code failure is user-visible but not developer-visible.**
```ts
// labGeneration.service.ts:83-86
console.error('[labs] starter code generation failed:', error)
yield {type: 'starter-code-failed'}
```
You correctly tell the user. But you have no aggregate: is this 0.1% of labs or 15%?

**Abort handling is unmeasured.** Both controllers wire up `AbortController` on `res.on('close')`. When a user navigates away mid-stream, you've already paid for those tokens. You currently can't distinguish "user abandoned" from "model errored" from "completed fine," and abandonment rate is a genuine quality signal.

**Regenerate destroys evidence.** `replaceLab` deletes all messages and `deleteByConversation` deletes all notes. A regenerate is the strongest possible signal that the first lab was bad — and it currently erases the very artifact you'd want to study. Traces live outside your database, so instrumenting this preserves the failed lab for analysis.

### 4.3 Evals worth building, ranked by value-to-effort

**Tier 1 — deterministic, write these first.** Cheap, reliable, immediately useful.

- *Starter code:* has a dependency manifest; has a README.md; ≤ 8 files; all paths pass `isSafePath` *before* filtering; file count > 0.
- *Lab generation:* output validates against `labContentSchema`; step count within a sane range; when `environment === 'windows'`, code snippets don't use `apt-get`/`sudo`. (Note your markdown formatter hardcodes ` ```bash ` — a real correctness bug that an eval would surface.)
- *All call sites:* completion didn't hit the token ceiling. Your 500-token chat limit and 300-token notes limit are tight enough that truncation is plausible, and a truncated response is a silently broken one.

**Tier 2 — LLM-as-judge on chat guardrails.** Your `SYSTEM_PROMPT` makes four separable promises: only CS/SWE topics; concise, not verbose; never generate files; never produce step-by-step labs (redirect to the lab generator instead). Build a small dataset of adversarial prompts — off-topic questions, "write me a lab on Docker", "give me a file" — and judge whether each rule held. This is what protects you when you edit that prompt.

**Tier 3 — the notes classifier.** Hand-label ~30 real (question, answer) pairs as save-worthy or not, then measure precision/recall of `shouldSave`. Highest-signal eval per unit of effort in the project, because it's a binary classification with unambiguous ground truth.

**Tier 4 — user feedback.** Thumbs up/down on chat responses and on generated labs. Also: treat *regenerate* as an implicit thumbs-down on the previous lab — you already have that button, it's a free-quality signal you're currently discarding.

---

## 5. Why Langfuse for this project

- **It covers both halves.** Tracing, datasets, experiments, LLM-as-judge, human annotation, and user-feedback scores in one product. You don't stand up two tools and correlate them by hand.
- **It handles both your SDKs.** You use AI SDK 7 in two services and LangChain in the other two. Langfuse has first-class integrations for each, feeding into a single trace tree. A tool that only understood one of them would give you a half-picture.
- **Scores attach to traces.** An eval result isn't a number in a spreadsheet — it's attached to the exact trace, so a bad score is one click from the prompt that caused it. This is the payoff for doing observability and evaluation in one system rather than two.
- **Self-hostable and open source.** Relevant for a student project with student data: you can run it locally or in Docker with no vendor lock-in, and the managed free tier is generous enough to start.

---

## 6. Suggested sequence

Doing this in the wrong order wastes effort — specifically, building evals before you have traces means guessing at your own failure modes.

1. **Trace everything.** All four call sites, tagged with `userId` and `conversationId`. Change nothing else. Just look at it for a week.
2. **Add user feedback.** Thumbs up/down; wire regenerate as an implicit negative. Nearly free, and it starts labelling your data for you.
3. **Write Tier 1 deterministic evals.** Assertions against rules you've already written into your prompts.
4. **Build a dataset from real traces.** Pull the worst 20 conversations you observed in step 1.
5. **Add LLM-as-judge for the chat guardrails**, validated against your own labels from step 4.
6. **Run the suite before every prompt change.** This is the point where it starts paying for itself.

The implementation for all of this is in `observability-and-evaluation-implementation.md`.
