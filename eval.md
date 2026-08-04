# Evaluating the Quiz — Answer-Key Correctness

> Status: Steps 1 and 2 are implemented and sampled — `services/quizJudge.service.ts`, called
> fire-and-forget from `quiz.service.ts`, judging a random `QUIZ_JUDGE_SAMPLE_RATE` share of each
> quiz. The annotation-review loop and the dataset regression suite are still design only.

---

## The problem, stated plainly

You asked whether to use Langfuse's LLM-as-a-judge to check that the LLM is grading users
correctly.

**Grading is not the problem, because grading is not done by an LLM.** Look at
`packages/server/services/quiz.service.ts:167`:

```ts
const score = perQuestion.filter((q) => q.selectedIndex === q.correctIndex).length;
```

That's an integer comparison. The user picked choice `2`, the stored key says `2`, so it's
correct. There is no judgment happening, no model involved, nothing that can be "sort of
right." Putting an LLM judge on this step would be asking a language model to confirm that
`2 === 2`. It cannot fail, so evaluating it is wasted money.

**The real risk is one step earlier: the answer key itself may be wrong.**

When `gpt-5.6-luna` writes a question, it also decides which choice is correct and writes that
into `correctIndex`. Nothing checks that decision. Your own code comment says so
(`quiz.service.ts:176`):

> Structural checks only, by decision. This catches questions that are unanswerable or
> self-evidently broken; it does NOT verify that correctIndex is actually the right answer.

`isStructurallyValid()` checks that there are four choices, that none are blank, that none are
duplicates, that nobody wrote "all of the above." Every one of those is a check on *shape*. None
of them read the question and think about whether the marked answer is true.

So this failure is possible today:

1. The model writes a question about page replacement algorithms.
2. It marks choice `1` correct. Choice `3` is actually the correct one.
3. A user who genuinely understands the material picks `3`.
4. The comparison at line 167 runs, finds `3 !== 1`, and marks them **wrong**.
5. The app then shows them the `explanation` field confidently justifying the wrong answer.

Every part of the system behaves exactly as written. The grading is flawless. The user is still
told they're wrong when they're right, and there is no signal anywhere that this happened.

**That is what's worth evaluating.**

---

## The idea, in one sentence

Take each generated question, hide the answer key, ask a *different* model to answer it from
scratch, and record whether it picked the same choice the key says is correct.

If the two independently agree, the key is probably fine. If they disagree, something is worth a
human look — either the key is wrong, or the question is ambiguous enough that two competent
readers pick different answers. Both are bugs.

This technique has a name — **LLM-as-a-judge** — and it means nothing more exotic than "use a
model to evaluate the output of another model."

---

## Why the Langfuse UI evaluator doesn't work here

Langfuse has a feature where you configure a judge in the web UI: you write an evaluation prompt
with placeholders like `{{input}}` and `{{output}}`, and Langfuse fills those in from your traces
and runs the judge for you. No code.

That's genuinely nice, and it's the wrong fit here, for two reasons.

**Reason 1: it would hand the judge the answer key.**

Langfuse populates `{{output}}` from your trace's recorded output. Your `generate-quiz` call
records this:

```json
{ "questions": [
  { "question": "...", "choices": ["...", "...", "...", "..."],
    "correctIndex": 0, "explanation": "COW defers the copy until a write..." }
]}
```

`correctIndex` and `explanation` are right there. The judge would be shown the answer it's
supposed to work out independently — and it will simply agree, every time, on questions that are
badly keyed. The whole value of the check is that the judge doesn't know the answer. Leak the
key and the check measures nothing.

Langfuse supports JSONPath to pull out sub-fields, so you could try to extract only the choices.
But that runs into:

**Reason 2: one trace holds many questions, and you'd get one score for all of them.**

A single `generate-quiz` call produces 5–10 questions in one output blob. The UI evaluator scores
a trace, so you'd get one number for the whole batch. "This batch scored 0.6" doesn't tell you
*which* question is broken, which is the only thing you actually need to know. And JSONPath can't
loop over an array of unknown length to make one judge call per question.

So the judge goes in code. Same tool, same scores, same Langfuse dashboards — you just call it
yourself instead of configuring it in a form.

---

## Vocabulary

Four Langfuse terms, because the rest of this document assumes them:

| Term | What it means |
|---|---|
| **Trace** | One complete request, end to end. "User asked for a quiz on deadlocks" is a trace. |
| **Observation** (or *span*) | One step inside a trace. The embedding call is one; the generation call is another. Observations nest inside a trace like folders. |
| **Score** | A number attached to a trace or observation. `answer-key-agreement = 0`. This is how evaluation results get recorded, and it's what makes them filterable and chartable in the UI. |
| **Dataset** | A saved collection of test cases you can re-run on demand. Think of it as a test fixture file that lives in Langfuse. |

You are already producing traces, and they're already structured. `quiz.controller.ts:30` opens a
`quiz-generation` trace with a `quiz-request` root span; the service's `embed(...)`
(`quiz.service.ts:70`) and `generateText(...)` (line 88) nest under it, because
`registerTelemetry(new LangfuseVercelAiSdkIntegration())` in `lib/instrumentation.ts` emits AI SDK
spans into the ambient OTel context. There is no per-call callback handler to pass around anymore.
What you're adding is **scores**.

---

## Implementation

### Step 1 — the judge service

New file: `packages/server/services/quizJudge.service.ts`

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { LangfuseClient } from '@langfuse/client';
import { startActiveObservation, updateActiveObservation } from '@langfuse/tracing';
import z from 'zod';
import type { StoredQuestion } from '../repositories/quiz.repository';
import { langfuseSpanProcessor } from '../lib/instrumentation';

const langfuse = new LangfuseClient();

const verdictSchema = z.object({
    answerIndex: z.number().int().min(0).max(3),
    reasoning: z.string(),
});

// Random k-of-n, never the first k — see "Sample it" below. The original index
// rides along because the loop position means nothing once questions are skipped.
const SAMPLE_RATE = /* clamped process.env.QUIZ_JUDGE_SAMPLE_RATE, default 0.2 */;

export async function judgeAnswerKeys(questions: StoredQuestion[]) {
    const sample = sampleQuestions(questions);
    if (sample.length === 0) return;

    await Promise.all(sample.map(({ question: q, index }) =>
        startActiveObservation(`judge-answer-key-${index}`, async (span) => {
            // Note what the judge is NOT given: correctIndex, explanation.
            const prompt =
                `Answer this multiple-choice question. Reason from the subject matter, ` +
                `not from how the choices are worded.\n\n` +
                `${q.question}\n\n` +
                q.choices.map((c, i) => `${i}. ${c}`).join('\n');

            // Deliberately NOT gpt-5.6-luna. A judge that shares the author's blind
            // spots agrees with the author's mistakes — the one thing it must not do.
            const { output: verdict } = await generateText({
                model: openai('gpt-4o'),
                output: Output.object({ schema: verdictSchema }),
                maxOutputTokens: 2000,
                telemetry: { functionId: 'judge-answer-key' },
                prompt,
            });

            const agrees = verdict.answerIndex === q.correctIndex;

            updateActiveObservation({
                input: { question: q.question, choices: q.choices },
                output: verdict,
                // questionIndex is what maps a disagreement back to
                // quiz_sessions.questions[i]. Without it, a `value: 0` score names
                // a problem nobody can locate.
                metadata: { questionIndex: index, storedCorrectIndex: q.correctIndex, agrees },
            });

            langfuse.score.observation({ otelSpan: span.otelSpan }, {
                name: 'answer-key-agreement',
                value: agrees ? 1 : 0,
                dataType: 'boolean',
                comment: agrees
                    ? undefined
                    : `Judge chose ${verdict.answerIndex}, key says ${q.correctIndex}. ` +
                      verdict.reasoning,
            });
        }),
    ));

    await langfuseSpanProcessor.forceFlush();
    await langfuse.score.flush();
}
```

**As shipped, the judge is `openai('gpt-4o')`, not Anthropic** — no `ANTHROPIC_API_KEY` in the
env, and this needs no new dependency. It's the weaker choice: same provider family as
`gpt-5.6-luna` means some shared blind spots. Switching later is two lines —
`bun add @ai-sdk/anthropic`, add the key, swap the model.

Reading it line by line:

- **`Output.object({ schema })`** — the same mechanism `quiz.service.ts` and
  `labGeneration.service.ts` now use. It forces the model to return JSON matching that Zod shape
  instead of prose, so `verdict.answerIndex` is reliably a number 0–3.
- **The prompt** — contains the question and the four choices. It does **not** contain
  `correctIndex` or `explanation`. This omission is the entire mechanism.
- **`telemetry: { functionId: 'judge-answer-key' }`** — names the generation span. The global
  `registerTelemetry` in `lib/instrumentation.ts` is what actually ships it to Langfuse; there is
  nothing to pass per-call.
- **`startActiveObservation`** — creates a span in Langfuse so each judge call shows up as its own
  visible step you can click into and read. The `generateText` span nests inside it automatically,
  because the AI SDK integration emits into the active OTel context.
- **`updateActiveObservation`** — fills that span's input/output so the UI shows what the judge
  saw and what it said. Debugging aid; the check works without it.
- **`langfuse.score.observation({ otelSpan }, …)`** — the actual result. `1` for agree, `0` for
  disagree, with the judge's reasoning attached as a comment when they differ, so you can read
  *why* it disagreed without re-running anything. It must be scored against the **span**, not the
  trace: trace-level scores upsert on `(traceId, name)`, so ten questions writing
  `answer-key-agreement` to one trace leave exactly one surviving score. Scoring the span gives
  each question its own `observationId`, and trace-level filtering still finds them.
- **The two flushes, in that order** — spans and scores are batched through separate pipelines.
  Langfuse **drops a score whose observation hasn't been ingested yet**, so flushing scores first
  silently loses them. `langfuseSpanProcessor.forceFlush()` pushes the finished judge spans, then
  `langfuse.score.flush()` sends the scores that reference them. This was found the hard way: the
  first working version recorded the disagreements and silently dropped the agreements.
- **`Promise.all`** — all questions judged concurrently rather than one after another.

### Step 2 — wiring it into generation

No trace plumbing is needed. `quiz.controller.ts:30` wraps the request in
`propagateAttributes({ traceName: 'quiz-generation' })` plus
`startActiveObservation('quiz-request')`, and `generateQuiz` is awaited inside that callback — so
the judge's spans inherit the ambient OTel context and land in the same trace on their own:

```ts
import { judgeAnswerKeys } from './quizJudge.service';

// In quizService.generateQuiz, after createSession:
// Fire-and-forget. The user must not wait on the judge.
judgeAnswerKeys(questions).catch((error) =>
    console.error('[quiz] answer-key judge failed:', error),
);

return { sessionId: session.id, questions: /* stripped as today */ };
```

One caveat specific to fire-and-forget: `quiz-request` will have *ended* by the time the judge
finishes, since the controller returns first. The judge spans still land in the right trace, they
just arrive after the parent closed and the trace's duration won't cover them. Verified end to end
against a two-question fixture — one correctly keyed, one deliberately mis-keyed — which produced
exactly two scores on the trace: `1` on the good key, `0` on the bad one with the judge's reasoning
in the comment.

**Fire-and-forget** means: start the judge, don't `await` it, return to the user immediately. The
judge runs in the background while the quiz is already on their screen. You're already doing this
for note extraction in `chat.service.ts`.

The consequence worth being clear about: **this does not block a bad question from reaching the
user.** The first user to see a mis-keyed question still sees it. What this buys you is *knowing*,
instead of never finding out. Blocking on the judge would mean adding a full extra LLM round-trip
to the user's wait, on top of an embedding call and a large structured generation, to catch a
problem that occurs in some small fraction of questions. Not worth it — at least not until you
know the rate.

### Step 3 — reading the results

In the Langfuse UI, filter traces by `name = quiz-generation` and `answer-key-agreement = 0`.
That's your list of disputed questions, with the judge's reasoning on each.

---

## Three things to get right

**Sample it, don't judge everything.** *(Implemented.)* One judge call per question means a
10-question quiz goes from one generation call to eleven LLM calls. `sampleQuestions()` judges a
random `ceil(n × QUIZ_JUDGE_SAMPLE_RATE)` questions, minimum 1 — default rate `0.2`, so a
5-question quiz costs one judge call instead of five. Setting the rate to `0` disables the judge
without touching code; values outside `0..1` clamp, and a non-numeric value falls back to the
default.

Random *k*-of-*n*, not the first *k*: judging only the opening questions never inspects the later
ones, so if the generator degrades over a long output — rushed distractors, repeated facts — the bad
keys concentrate exactly where nobody looks, and the measured rate is wrong in the reassuring
direction. Run at `1.0` for a while to establish the real rate, then dial down: 1% means sample
lightly forever, 15% means fix the generation prompt at the source.

**Disagreement is a flag, not a verdict.** The judge is a language model too, and it will
sometimes be the one that's wrong. `value: 0` means *a human should look at this*. Never
auto-overwrite `correctIndex` from the judge's opinion — that trades a rare error for a systematic
one. Langfuse has annotation queues built for this exact review step.

**Use a different model than the generator.** Shipped as `gpt-4o` judging `gpt-5.6-luna`. Different
model, same family — which satisfies the letter of this rule and only half its intent. If both were
the *same* model, a question it gets confidently wrong when writing, it gets confidently wrong when
judging, and you'd record agreement on the one case you most needed to catch. A cross-provider judge
(`anthropic('claude-opus-5')`) is the stronger version and worth revisiting once the disagreement
rate is known.

---

## The free check you can do first

Before writing any of this: you already persist every session and every result via
`quizRepository.recordResult`. Query for questions where most users pick the *same wrong choice*.

A question that 80% of users miss, with their answers piled onto one particular distractor, is
almost always a bad answer key — not a hard question. Genuinely hard questions scatter wrong
answers across all three distractors. Concentration on one is the signature of "that distractor is
actually correct."

This costs nothing, needs no judge, and uses data you're already storing. It won't catch a bad key
on a rarely-served question, but it will find your worst offenders immediately.

---

## Where this goes next

Once you have ~50 hand-confirmed bad questions, put them in a **Langfuse Dataset** and use
`dataset.runExperiment()` with an item-level evaluator:

```ts
const dataset = await langfuse.dataset.get('bad-answer-keys');

const result = await dataset.runExperiment({
    name: 'prompt-v3',
    task: async (item) => regenerateQuestionFor(item.input),
    evaluators: [
        async ({ output, expectedOutput }) => ({
            name: 'key-correct',
            value: output.correctIndex === expectedOutput.correctIndex ? 1 : 0,
        }),
    ],
});

console.log(await result.format());
```

That converts the online judge into an **offline regression test** — run it on demand, whenever
you edit `QUESTION_EXEMPLARS` or the generation prompt in `quiz.service.ts`. That's what stops you
from shipping a prompt tweak that quietly makes answer keys worse. The online judge finds
problems; the dataset stops them coming back.

---

## Summary

| | |
|---|---|
| What you asked about | Judging whether the LLM grades users correctly |
| Why that's not it | Grading is `selectedIndex === correctIndex` — no LLM involved |
| The actual risk | `correctIndex` may be wrong; nothing verifies it |
| The check | Second model answers the question blind; compare to the stored key |
| Why not the Langfuse UI evaluator | It would show the judge the answer key, and it scores whole batches instead of individual questions |
| Where it runs | Fire-and-forget after generation, sampled |
| What you get | A filterable `answer-key-agreement` score per question, with reasoning |
| Cheapest first step | Query existing results for wrong answers concentrated on one distractor |
