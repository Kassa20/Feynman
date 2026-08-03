# Quiz Feature — RAG over Ingested Textbooks — Full Implementation

> **Note on file location:** plan mode restricts edits to this plan file, so the complete
> implementation lives here. On approval it replaces `quiz-feature.md` and is split into the
> real source files at the paths given in each section heading.

---

## Context

`quiz-feature.md` specifies a quiz built on a **hand-curated question bank**: JSON seed files at
`packages/server/data/quiz-seed/*.json`, a `quiz_questions` table with `not null` provenance
columns, a fixed `quiz_topics` dropdown, and request-time selection by plain SQL
(`quiz-feature.md:13`). pgvector appears only as optional ingest-time dedup (§7).

That premise is wrong for how content will actually be sourced. There is no well-formatted array
of questions to ingest and no plan to author one. Instead: **textbook PDFs are ingested and
embedded offline; at request time the user's query retrieves relevant chunks and an LLM writes the
questions, steered by a few exemplars of good question types.**

| `quiz-feature.md` | This design |
|---|---|
| `quiz_topics` fixed dropdown | dropped — free-text query + suggested chips |
| `quiz_questions` durable bank | dropped — questions generated per request |
| `get_quiz_questions` RPC (`ORDER BY random()`) | replaced by vector similarity over chunks |
| JSON seed files + `ingestQuiz.ts` | PDF ingest pipeline + `ingestTextbooks.ts` |
| pgvector optional (Phase 5) | pgvector *is* the retrieval path |
| `quiz_attempts` table | folded into `quiz_sessions` |

What survives: plain-JSON controller conventions, server-side grading, and the rule that the
answer key never reaches the client.

Nothing is implemented yet — zero quiz code in the repo — so this is a spec revision, not a
refactor.

**Decisions encoded (user-confirmed):**

- Generation at request time; the **answer key lives in a server-side `quiz_sessions` row**.
- **Structural validation only** in the first pass — no grounding-quote check, no verify pass.
- **Plain JSON**, not SSE.
- PDFs are **local files in a gitignored folder** with a checked-in sidecar manifest.
- Topic input is **free text plus suggested chips**.

### Environment facts (verified against the live project)

- pgvector is **available but not installed**: `vector` 0.8.2 shows `installed_version: null`.
- Existing tables: `lab_generations`, `conversations`, `messages`, `notes`. No migration files —
  schema lives in Supabase, applied via `mcp__supabase__apply_migration`.
- `@langchain/openai` ^1.5.5 is installed, so `OpenAIEmbeddings` is available.
  **New deps:** `pdf-parse` (v2 — the `PDFParse` class) and `@langchain/textsplitters`.
- ⚠️ **RLS is disabled on all four existing tables**, which Supabase flags as critical: anyone with
  the anon key can read or modify every row. The new tables follow the same service-role-only
  posture for consistency (so this change doesn't worsen it), but it is real pre-existing exposure
  that deserves its own pass. Out of scope here.

---

## 1. Database migrations

Applied with `mcp__supabase__apply_migration`, one call per named migration.

### 1a. `enable_pgvector`

```sql
create extension if not exists vector with schema extensions;
```

### 1b. `create_textbook_chunks`

```sql
create table public.textbook_chunks (
  id          uuid primary key default gen_random_uuid(),
  source_file text not null,
  title       text not null,
  author      text,
  license     text not null,
  page        int,
  chunk_index int  not null,
  content     text not null,
  embedding   extensions.vector(1536) not null,
  created_at  timestamptz not null default now()
);

create index textbook_chunks_source_idx
  on public.textbook_chunks (source_file);

create index textbook_chunks_embedding_idx
  on public.textbook_chunks
  using hnsw (embedding extensions.vector_cosine_ops);
```

**Why these details matter:**

- `source_file` is the **idempotency key for the whole document**. Re-ingesting a textbook deletes
  every row with that `source_file` and re-inserts. This is simpler than the per-question
  `natural_key = sha256(...)` hashing in `quiz-feature.md:70`, and it's the correct granularity:
  chunk boundaries shift when you change `chunkSize`, so per-chunk hashes would orphan rows on
  every tuning pass. The `source_idx` exists to make that delete fast.
- `license` is `not null`, preserving the provenance discipline from `quiz-feature.md:15` — a
  textbook without a recorded license cannot be ingested.
- `1536` is `text-embedding-3-small`'s dimensionality. It is baked into both the column and the
  RPC signature, so switching embedding models means a new column and a full re-ingest. That's
  inherent to pgvector, not a shortcut.
- **HNSW over IVFFlat**: IVFFlat needs a training step against representative data and degrades if
  the corpus grows well past what it was trained on. HNSW has no training step and behaves well
  on a small-and-growing corpus, which is exactly this situation. Build is slower, which is
  irrelevant for an offline script.
- `vector_cosine_ops` must match the `<=>` operator used in the RPC. Mismatch here silently
  disables the index — the query still works, just via sequential scan.

### 1c. `create_quiz_sessions`

```sql
create table public.quiz_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  query        text not null,
  difficulty   skill_level not null,
  questions    jsonb not null,
  source_ids   uuid[] not null default '{}',
  score        int,
  total        int,
  answers      jsonb,
  submitted_at timestamptz,
  created_at   timestamptz not null default now()
);

create index quiz_sessions_user_idx
  on public.quiz_sessions (user_id, created_at desc);
```

**Why these details matter:**

- `questions` stores the **full** generated question objects, `correctIndex` and `explanation`
  included. This is the entire reason the table exists: the client is sent a stripped copy, so the
  key is only ever in Postgres and in the grading code path.
- **One table, not two.** `quiz-feature.md:72` had a separate `quiz_attempts` because questions
  were durable and reusable across many attempts. Here every session is generated for exactly one
  attempt, so a second table would be in 1:1 correspondence with the first. `score` / `answers` /
  `submitted_at` are nullable and filled in on submit; `submitted_at is not null` is the flag that
  makes a session single-use.
- `difficulty skill_level` **reuses the existing enum** already defined for `lab_generations`
  (`beginner`/`intermediate`/`advanced`), staying consistent with `SkillLevel` at
  `packages/server/repositories/labGeneration.repository.ts:4`. No new type.
- `source_ids` records which chunks fed the generation. Nothing reads it yet; it costs one array
  column and is the difference between being able and unable to debug a bad question later.

Follow the existing convention: RLS disabled, all access through the service-role client in
`packages/server/lib/supabase.ts` (the posture recorded in `notes-feature.md:35`). Because
service-role bypasses RLS, **every read must scope ownership manually** with `.eq('user_id', …)` —
see §3b.

### 1d. Similarity-search RPC

```sql
create or replace function public.match_textbook_chunks(
  query_embedding extensions.vector(1536),
  match_count     int default 8
)
returns table (
  id         uuid,
  content    text,
  title      text,
  page       int,
  similarity float
)
language sql
stable
as $$
  select
    c.id,
    c.content,
    c.title,
    c.page,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.textbook_chunks c
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
```

**Why an RPC:** `supabase-js` has no query-builder expression for the `<=>` distance operator —
the same reason `quiz-feature.md:115` reached for an RPC. This is the identical motivation applied
to a different operator.

**Why `order by ... <=>` and not `order by similarity desc`:** only the raw distance expression
matches the HNSW index. Ordering by the derived `1 - distance` column defeats it and forces a full
scan. The subtraction is for the caller's convenience (higher = better, comparable to a threshold);
the ordering stays in index-friendly form.

`<=>` is cosine distance in `[0, 2]`, so `similarity` lands in `[-1, 1]` — for OpenAI embeddings,
in practice around `[0, 1]`.

---

## 2. Dependencies

```bash
cd packages/server
bun add pdf-parse @langchain/textsplitters
```

`pdf-parse` v2 exposes the `PDFParse` class (the API LangChain's current JS docs use directly).
`@langchain/textsplitters` supplies `RecursiveCharacterTextSplitter`. `OpenAIEmbeddings` comes from
the already-installed `@langchain/openai`.

**Not installed on purpose:** `@langchain/community`'s `SupabaseVectorStore`. It would work, but it
opens its own Supabase client and issues its own SQL, which breaks the repository rule in
`CLAUDE.md` that repositories are the only layer talking to Supabase. The hand-rolled path is one
RPC and one insert — less code than the abstraction, and it keeps the layering intact.

### `.gitignore` addition

```gitignore
packages/server/data/textbooks/*.pdf
```

The manifest is checked in; the PDFs are not. Textbooks are large and often not redistributable.

---

## 3. Server — repositories

### 3a. `packages/server/repositories/textbook.repository.ts`

```ts
import { supabase } from '../lib/supabase'

export type TextbookChunkInput = {
    sourceFile: string;
    title: string;
    author: string | null;
    license: string;
    page: number | null;
    chunkIndex: number;
    content: string;
    embedding: number[];
}

export type MatchedChunk = {
    id: string;
    content: string;
    title: string;
    page: number | null;
    similarity: number;
}

export const textbookRepository = {
    // Delete-then-insert so re-running ingestion for a file replaces it wholesale.
    // Chunk boundaries move when chunkSize changes, so there is no stable per-chunk
    // identity to upsert against.
    async replaceChunks(sourceFile: string, chunks: TextbookChunkInput[]): Promise<void> {
        const { error: deleteError } = await supabase
            .from('textbook_chunks')
            .delete()
            .eq('source_file', sourceFile)

        if (deleteError) throw new Error(`replaceChunks delete failed: ${deleteError.message}`)

        for (let i = 0; i < chunks.length; i += 200) {
            const { error } = await supabase
                .from('textbook_chunks')
                .insert(
                    chunks.slice(i, i + 200).map((chunk) => ({
                        source_file: chunk.sourceFile,
                        title: chunk.title,
                        author: chunk.author,
                        license: chunk.license,
                        page: chunk.page,
                        chunk_index: chunk.chunkIndex,
                        content: chunk.content,
                        embedding: chunk.embedding,
                    })),
                )

            if (error) throw new Error(`replaceChunks insert failed: ${error.message}`)
        }
    },

    async matchChunks(embedding: number[], matchCount: number): Promise<MatchedChunk[]> {
        const { data, error } = await supabase.rpc('match_textbook_chunks', {
            query_embedding: embedding,
            match_count: matchCount,
        })

        if (error) throw new Error(`matchChunks failed: ${error.message}`)

        return (data ?? []).map((row: {
            id: string; content: string; title: string; page: number | null; similarity: number;
        }) => ({
            id: row.id,
            content: row.content,
            title: row.title,
            page: row.page,
            similarity: row.similarity,
        }))
    },
}
```

**Why the 200-row insert batches:** a 600-page textbook produces a few thousand chunks, each
carrying a 1536-float embedding. A single insert would be a multi-hundred-megabyte JSON body and
will fail on request size. 200 is comfortably under any limit and keeps the script's progress
legible.

**Why `embedding` is passed as a plain `number[]`:** PostgREST accepts a JSON array for a `vector`
column and casts it. No client-side string formatting needed.

### 3b. `packages/server/repositories/quiz.repository.ts`

```ts
import { supabase } from '../lib/supabase'
import type { SkillLevel } from './labGeneration.repository'

// The stored shape — includes the answer key. Never serialized to the client as-is.
export type StoredQuestion = {
    question: string;
    choices: string[];
    correctIndex: number;
    explanation: string;
}

export type QuizSession = {
    id: string;
    query: string;
    difficulty: SkillLevel;
    questions: StoredQuestion[];
    submittedAt: string | null;
}

export const quizRepository = {
    async createSession(
        userId: string,
        query: string,
        difficulty: SkillLevel,
        questions: StoredQuestion[],
        sourceIds: string[],
    ): Promise<{ id: string }> {
        const { data, error } = await supabase
            .from('quiz_sessions')
            .insert({
                user_id: userId,
                query,
                difficulty,
                questions,
                source_ids: sourceIds,
            })
            .select('id')
            .single()

        if (error) throw new Error(`createSession failed: ${error.message}`)
        return data
    },

    // Ownership is filtered here, not by RLS — the service-role client bypasses it.
    async getSession(sessionId: string, userId: string): Promise<QuizSession | null> {
        const { data, error } = await supabase
            .from('quiz_sessions')
            .select('id, query, difficulty, questions, submitted_at')
            .eq('id', sessionId)
            .eq('user_id', userId)
            .maybeSingle()

        if (error) throw new Error(`getSession failed: ${error.message}`)
        if (!data) return null

        return {
            id: data.id,
            query: data.query,
            difficulty: data.difficulty,
            questions: data.questions as StoredQuestion[],
            submittedAt: data.submitted_at,
        }
    },

    async recordResult(
        sessionId: string,
        score: number,
        total: number,
        answers: number[],
    ): Promise<void> {
        const { error } = await supabase
            .from('quiz_sessions')
            .update({ score, total, answers, submitted_at: new Date().toISOString() })
            .eq('id', sessionId)

        if (error) throw new Error(`recordResult failed: ${error.message}`)
    },
}
```

Conventions followed from `labGeneration.repository.ts` and `notes.repository.ts`: object-literal
export, explicit `Promise<T>` return types, snake_case→camelCase mapping at the boundary, `jsonb`
read back with a cast, and the uniform `` throw new Error(`<method> failed: ${error.message}`) ``.

`recordResult` doesn't re-check `user_id` because the only caller has already fetched the session
through the ownership-scoped `getSession`.

---

## 4. Server — `packages/server/services/quiz.service.ts`

Modeled on `notes.service.ts`: a module-level `CallbackHandler`, a zod schema, and a
`ChatOpenAI(...).withStructuredOutput(schema)` singleton. This is the one-shot LangChain path, not
the streaming AI SDK path used by `labGeneration.service.ts`.

```ts
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { CallbackHandler } from '@langfuse/langchain';
import z from 'zod';
import { textbookRepository } from '../repositories/textbook.repository';
import { quizRepository, type StoredQuestion } from '../repositories/quiz.repository';
import type { SkillLevel } from '../repositories/labGeneration.repository';

const langfuseHandler = new CallbackHandler();

const embeddings = new OpenAIEmbeddings({ model: 'text-embedding-3-small' });

const quizSchema = z.object({
    questions: z.array(
        z.object({
            question: z.string(),
            choices: z.array(z.string()).length(4),
            correctIndex: z.number().int().min(0).max(3),
            explanation: z.string(),
        }),
    ),
});

const quizAgent = new ChatOpenAI({ model: 'gpt-5.6-luna', maxTokens: 4000 })
    .withStructuredOutput(quizSchema);

// Retrieval knobs. RETRIEVAL_COUNT is generous because the model needs enough
// material to write distinct questions; MIN_SIMILARITY is the honesty check that
// stops us generating from passages that have nothing to do with the query.
const RETRIEVAL_COUNT = 8;
const MIN_SIMILARITY = 0.3;

export class NoCoverageError extends Error {}
export class SessionNotFoundError extends Error {}
export class AlreadySubmittedError extends Error {}
```

### 4a. Exemplars — the few-shot steer

```ts
// Shown to the model as the target *form* of a question, not as content to copy.
// Each illustrates a distinct question type worth producing.
const QUESTION_EXEMPLARS = `
Example 1 — tests a causal mechanism, not a definition:
{
  "question": "A process calls fork() and the child immediately calls execve(). Why does copy-on-write make this sequence cheap?",
  "choices": [
    "The parent's pages are never physically copied before execve() replaces the address space",
    "fork() is optimized to skip creating a new process descriptor",
    "execve() runs in the parent's address space, so no new memory is needed",
    "The kernel caches the child's page table from a previous fork()"
  ],
  "correctIndex": 0,
  "explanation": "COW defers the copy until a write. execve() discards the address space first, so the copy never happens."
}

Example 2 — applies a rule to a concrete scenario:
{
  "question": "A disk scheduler receives requests for cylinders 98, 183, 37 while the head sits at 53 moving upward. Under SCAN, which is serviced first?",
  "choices": ["98", "183", "37", "53"],
  "correctIndex": 0,
  "explanation": "SCAN continues in the current direction, so it services 98 and 183 on the way up before reversing for 37."
}

Example 3 — distinguishes two commonly confused concepts:
{
  "question": "Which condition distinguishes deadlock from livelock?",
  "choices": [
    "In deadlock the processes are blocked; in livelock they keep changing state without progressing",
    "Deadlock involves exactly two processes; livelock involves three or more",
    "Livelock can only occur on multiprocessor systems",
    "Deadlock is always resolved by the scheduler; livelock never is"
  ],
  "correctIndex": 0,
  "explanation": "Both stall progress, but livelocked processes are actively running and changing state."
}
`.trim();
```

**Why exemplars rather than a longer rulebook:** the failure mode of LLM-written MCQs is
recall-of-a-definition questions with three obviously wrong distractors. Prose instructions
("write application-level questions") move that needle much less than three concrete specimens
showing the target form. Note each exemplar is from a *different* domain than most quiz topics
will be — deliberate, so the model copies the shape and not the subject.

### 4b. Generation

```ts
export const quizService = {
    async generate(
        userId: string,
        query: string,
        difficulty: SkillLevel,
        count: number,
    ): Promise<{ sessionId: string; questions: { question: string; choices: string[] }[] }> {
        const queryEmbedding = await embeddings.embedQuery(query);
        const chunks = await textbookRepository.matchChunks(queryEmbedding, RETRIEVAL_COUNT);

        // matchChunks always returns the nearest rows, however far away they are.
        // Without this guard a query about a topic we have no textbook for would
        // still produce a confident-looking quiz built from irrelevant passages.
        if (chunks.length === 0 || chunks[0]!.similarity < MIN_SIMILARITY) {
            throw new NoCoverageError(`No textbook coverage for "${query}"`);
        }

        const passages = chunks
            .map((chunk, index) =>
                `[${index + 1}] ${chunk.title}${chunk.page !== null ? `, p.${chunk.page}` : ''}\n${chunk.content}`,
            )
            .join('\n\n---\n\n');

        const result = await quizAgent.invoke(
            `You are writing a ${difficulty}-level multiple-choice quiz on the topic "${query}".\n\n` +
            `Write exactly ${count} questions using ONLY the passages below. Every question must be ` +
            `answerable from these passages alone.\n\n` +
            `Rules:\n` +
            `- Exactly 4 choices, exactly one unambiguously correct.\n` +
            `- Distractors must be plausible to someone who half-understands the material — ` +
            `common misconceptions, adjacent concepts, right idea applied to the wrong case. ` +
            `Never filler.\n` +
            `- Never use "all of the above", "none of the above", or "both A and B".\n` +
            `- Do not reference "the passage" or "the text" — the reader will not see them.\n` +
            `- Do not repeat the same fact across two questions.\n` +
            `- The explanation states why the correct choice is right in one or two sentences.\n` +
            `- Calibrate to ${difficulty}: beginner tests core concepts, intermediate tests ` +
            `application, advanced tests edge cases and interactions between concepts.\n\n` +
            `Here are examples of the KIND of question to write. Copy their form, not their subject:\n\n` +
            `${QUESTION_EXEMPLARS}\n\n` +
            `Passages:\n\n${passages}`,
            { callbacks: [langfuseHandler], runName: 'generate-quiz' },
        );

        const valid = result.questions.filter(isStructurallyValid);

        if (valid.length === 0) {
            throw new Error('Model returned no structurally valid questions');
        }

        const questions: StoredQuestion[] = valid.slice(0, count);

        const session = await quizRepository.createSession(
            userId,
            query,
            difficulty,
            questions,
            chunks.map((chunk) => chunk.id),
        );

        // Strip the key before it leaves the server. This is the whole point of
        // persisting the session.
        return {
            sessionId: session.id,
            questions: questions.map(({ question, choices }) => ({ question, choices })),
        };
    },
```

**Why validation is a filter, not a retry:** a structurally broken question is rare and the
cheapest correct response is to serve the remaining good ones. Retrying doubles latency for a case
that mostly doesn't happen; throwing wastes a whole generation over one bad row. If `valid` comes
back shorter than `count` the user gets a shorter quiz, and `total` in the result reflects that
honestly.

```ts
// Structural checks only, by decision. This catches questions that are
// unanswerable or self-evidently broken; it does NOT verify that correctIndex is
// actually the right answer. See "Known limitation" below.
function isStructurallyValid(question: {
    question: string; choices: string[]; correctIndex: number; explanation: string;
}): boolean {
    if (question.question.trim().length === 0) return false;
    if (question.choices.length !== 4) return false;
    if (question.choices.some((choice) => choice.trim().length === 0)) return false;

    // Duplicate choices mean two correct answers or a wasted slot.
    const normalized = question.choices.map((choice) => choice.trim().toLowerCase());
    if (new Set(normalized).size !== normalized.length) return false;

    if (question.correctIndex < 0 || question.correctIndex >= question.choices.length) return false;

    // The prompt bans these; the model occasionally does it anyway, and they make
    // the single-correct-answer assumption false.
    if (normalized.some((choice) => choice.startsWith('all of the above')
        || choice.startsWith('none of the above'))) return false;

    return true;
}
```

Note the zod schema (`.length(4)`, `correctIndex` bounded `0..3`) already rejects most of this at
parse time — `withStructuredOutput` will have thrown before `isStructurallyValid` runs. The
function is defense in depth plus the checks zod can't express: cross-field duplicate detection and
the banned-phrase rule. The `correctIndex` range check is redundant with the schema today, and kept
because it's the one whose failure produces an unanswerable question.

### 4c. Grading

```ts
    async submit(
        userId: string,
        sessionId: string,
        answers: number[],
    ): Promise<{
        score: number;
        total: number;
        perQuestion: {
            question: string;
            choices: string[];
            selectedIndex: number | null;
            correctIndex: number;
            explanation: string;
        }[];
    }> {
        const session = await quizRepository.getSession(sessionId, userId);
        if (!session) throw new SessionNotFoundError(sessionId);
        if (session.submittedAt) throw new AlreadySubmittedError(sessionId);

        const perQuestion = session.questions.map((question, index) => {
            const selectedIndex = answers[index] ?? null;
            return {
                question: question.question,
                choices: question.choices,
                selectedIndex,
                correctIndex: question.correctIndex,
                explanation: question.explanation,
            };
        });

        const score = perQuestion.filter((q) => q.selectedIndex === q.correctIndex).length;
        const total = session.questions.length;

        await quizRepository.recordResult(sessionId, score, total, answers);

        return { score, total, perQuestion };
    },
}
```

**Why `total` comes from the stored questions, not from `answers.length`:** the client could send
any array. The session row is the authority on how many questions there were.

**Why single-use sessions:** without `submittedAt` gating, a client could submit repeatedly and
read the key off the first response to score 100% on the second. `AlreadySubmittedError` → 409
closes that.

**Known limitation (accepted):** with structural checks only, nothing verifies that `correctIndex`
is genuinely correct. If wrong keys show up in practice, the cheapest next guard is to add a
`supportingQuote: z.string()` field to the schema, require it be copied verbatim from a passage,
and assert in `isStructurallyValid` that it's a substring of one of the retrieved chunks — a
hallucinated question then fails a plain string comparison, at zero extra LLM cost.

---

## 5. Server — controller and routes

### `packages/server/controllers/quiz.controller.ts`

```ts
import type { Request, Response } from 'express';
import z from 'zod';
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import {
    quizService,
    NoCoverageError,
    SessionNotFoundError,
    AlreadySubmittedError,
} from '../services/quiz.service';

const startSchema = z.object({
    query: z.string().trim()
        .min(1, { message: 'Topic cannot be empty' })
        .max(500, { message: 'Topic cannot exceed 500 characters' }),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
    count: z.number().int().min(3).max(10).default(5),
});

const submitSchema = z.object({
    sessionId: z.string().uuid(),
    answers: z.array(z.number().int().min(0).max(3)).min(1).max(10),
});

export const quizController = {
    async start(req: Request, res: Response) {
        const parseResult = startSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        const { query, difficulty, count } = parseResult.data;

        await propagateAttributes(
            {
                traceName: 'quiz-generation',
                userId: req.user!.id,
                tags: ['quiz'],
            },
            () => startActiveObservation('quiz-request', async (span) => {
                span.updateOtelSpanAttributes({ input: { query, difficulty, count } });

                try {
                    const quiz = await quizService.generate(req.user!.id, query, difficulty, count);
                    res.json(quiz);
                } catch (error) {
                    if (error instanceof NoCoverageError) {
                        return res.status(404).json({
                            message: 'No textbook content covers that topic yet',
                        });
                    }
                    console.error('[quiz] error:', error);
                    span.updateOtelSpanAttributes({ level: 'ERROR', statusMessage: String(error) });
                    res.status(500).json({ message: 'Something went wrong generating your quiz' });
                }
            }),
        );
    },

    async submit(req: Request, res: Response) {
        const parseResult = submitSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        const { sessionId, answers } = parseResult.data;

        try {
            const result = await quizService.submit(req.user!.id, sessionId, answers);
            res.json(result);
        } catch (error) {
            if (error instanceof SessionNotFoundError) {
                return res.status(404).json({ message: 'Quiz session not found' });
            }
            if (error instanceof AlreadySubmittedError) {
                return res.status(409).json({ message: 'This quiz has already been submitted' });
            }
            console.error('[quiz] error:', error);
            res.status(500).json({ message: 'Something went wrong' });
        }
    },
};
```

**Why the Langfuse wrapper is on `start` only:** `submit` makes no LLM call. The wrapper exists to
attach the trace that `generate-quiz` nests under. Unlike AI SDK calls — auto-traced by the global
`registerTelemetry` in `lib/instrumentation.ts:16` — LangChain calls need
`{ callbacks: [langfuseHandler] }` passed explicitly, which §4 does.

**Why `NoCoverageError` returns 404 and not 400:** the request is well-formed; the corpus simply
doesn't contain the topic. The client renders this as a distinct empty state, not a validation
error.

`SessionNotFoundError` deliberately covers both "no such session" and "belongs to another user" —
`getSession` filters on `user_id`, so a cross-user probe is indistinguishable from a miss. That's
the intent: it leaks nothing about other users' sessions.

### `packages/server/routes.ts` — additions

```ts
import { quizController } from './controllers/quiz.controller';

// ...alongside the existing routes:
router.post('/api/quiz/start', requireAuth, quizController.start);
router.post('/api/quiz/submit', requireAuth, quizController.submit);
```

---

## 6. Ingestion — outside the app path

### `packages/server/data/textbooks/manifest.json`

```json
[
  {
    "file": "ostep.pdf",
    "title": "Operating Systems: Three Easy Pieces",
    "author": "Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau",
    "license": "CC BY-NC-SA 4.0"
  }
]
```

The PDFs sit next to this file and are gitignored (§2). The manifest is the only checked-in record
of what the corpus contains and under what license.

### `packages/server/scripts/ingestTextbooks.ts`

Run manually: `bun run packages/server/scripts/ingestTextbooks.ts`. **Never imported by the
server** — same posture as `quiz-feature.md:506`.

```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { OpenAIEmbeddings } from '@langchain/openai';
import { textbookRepository, type TextbookChunkInput } from '../repositories/textbook.repository';

type ManifestEntry = {
    file: string;
    title: string;
    author?: string;
    license: string;
};

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data/textbooks');
const EMBED_BATCH = 100;

const embeddings = new OpenAIEmbeddings({ model: 'text-embedding-3-small' });

const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
});

async function loadPdfPages(filePath: string): Promise<Document[]> {
    const parser = new PDFParse({ data: new Uint8Array(readFileSync(filePath)) });
    try {
        const { pages } = await parser.getText();
        return pages.map(
            (page) => new Document({
                pageContent: page.text,
                metadata: { page: page.num },
            }),
        );
    } finally {
        // Without this the parser's worker keeps the process alive.
        await parser.destroy();
    }
}

async function ingest(entry: ManifestEntry): Promise<void> {
    console.log(`\n[${entry.file}] parsing…`);
    const pages = await loadPdfPages(join(DATA_DIR, entry.file));

    const textLength = pages.reduce((sum, page) => sum + page.pageContent.trim().length, 0);
    if (textLength < 1000) {
        // A scanned PDF has no text layer and yields near-empty pages. Silently
        // ingesting it would produce a corpus that retrieves nothing.
        throw new Error(
            `${entry.file} produced only ${textLength} characters across ${pages.length} pages — ` +
            `it is probably a scanned PDF with no text layer.`,
        );
    }

    const splits = await splitter.splitDocuments(pages);
    console.log(`[${entry.file}] ${pages.length} pages → ${splits.length} chunks, embedding…`);

    const chunks: TextbookChunkInput[] = [];

    for (let i = 0; i < splits.length; i += EMBED_BATCH) {
        const batch = splits.slice(i, i + EMBED_BATCH);
        const vectors = await embeddings.embedDocuments(batch.map((doc) => doc.pageContent));

        batch.forEach((doc, offset) => {
            chunks.push({
                sourceFile: entry.file,
                title: entry.title,
                author: entry.author ?? null,
                license: entry.license,
                page: (doc.metadata.page as number | undefined) ?? null,
                chunkIndex: i + offset,
                content: doc.pageContent,
                embedding: vectors[offset]!,
            });
        });

        console.log(`[${entry.file}] embedded ${Math.min(i + EMBED_BATCH, splits.length)}/${splits.length}`);
    }

    await textbookRepository.replaceChunks(entry.file, chunks);
    console.log(`[${entry.file}] stored ${chunks.length} chunks`);
}

const manifest: ManifestEntry[] = JSON.parse(
    readFileSync(join(DATA_DIR, 'manifest.json'), 'utf-8'),
);

for (const entry of manifest) {
    await ingest(entry);
}

console.log('\nDone.');
```

**Why `chunkSize: 1000` / `chunkOverlap: 200`:** a chunk needs to hold a complete idea for a
question to be answerable from it, and ~1000 characters is roughly a textbook paragraph or two.
The 200-character overlap keeps a concept that straddles a boundary retrievable from both sides.
These are the values LangChain's own RAG docs use, and they're the first knob to tune if retrieval
quality disappoints.

**Why page-level Documents before splitting:** it preserves `page` in metadata through the split,
so a generated question can be traced to a page number. Splitting the whole book as one string
would lose that.

**Why the scanned-PDF guard:** it's the single most likely ingestion failure, it's silent, and by
the time you notice, the symptom is "quiz generation says no coverage for everything." One cheap
assertion turns a confusing debugging session into an error message at ingest.

**Why `embedDocuments` in batches of 100:** the embeddings endpoint has per-request input limits,
and batching amortizes round trips. `embedDocuments` returns vectors positionally aligned with the
input array, which is what the `forEach` offset relies on.

Top-level `await` in the loop is fine — Bun runs this file as an ES module.

---

## 7. Client

All calls are plain JSON, so the existing axios instance in `src/lib/api.ts` is used directly — its
interceptor already injects `Authorization: Bearer <token>`. No raw `fetch` + `ReadableStream`
reader is needed (the pattern at `ChatBot.tsx:97-165` exists only for SSE).

### `src/lib/quizApi.ts`

```ts
import { api } from "@/lib/api";

export type Difficulty = "beginner" | "intermediate" | "advanced";

export type QuizQuestion = {
  question: string;
  choices: string[];
};

export type QuizStartResponse = {
  sessionId: string;
  questions: QuizQuestion[];
};

export type QuizResultResponse = {
  score: number;
  total: number;
  perQuestion: {
    question: string;
    choices: string[];
    selectedIndex: number | null;
    correctIndex: number;
    explanation: string;
  }[];
};

export async function startQuiz(
  query: string,
  difficulty: Difficulty,
  count: number,
): Promise<QuizStartResponse> {
  const { data } = await api.post<QuizStartResponse>("/api/quiz/start", {
    query,
    difficulty,
    count,
  });
  return data;
}

export async function submitQuiz(
  sessionId: string,
  answers: number[],
): Promise<QuizResultResponse> {
  const { data } = await api.post<QuizResultResponse>("/api/quiz/submit", {
    sessionId,
    answers,
  });
  return data;
}
```

Note `QuizQuestion` has no `correctIndex` — the client-side type mirrors the server's stripped
shape, so referencing an answer key before submit is a compile error.

### `src/components/quiz/TopicPicker.tsx`

```tsx
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Difficulty } from "@/lib/quizApi";

// Hardcoded to reflect what is actually ingested. Deriving these from the corpus
// is a later refinement; a wrong chip is worse than no chip, so this list must be
// updated alongside data/textbooks/manifest.json.
const SUGGESTED_TOPICS = [
  "Virtual memory and paging",
  "CPU scheduling policies",
  "Concurrency and locks",
  "File system journaling",
];

const DIFFICULTIES: Difficulty[] = ["beginner", "intermediate", "advanced"];

type Props = {
  onStart: (query: string, difficulty: Difficulty, count: number) => void;
  loading: boolean;
  error: string | null;
};

export function TopicPicker({ onStart, loading, error }: Props) {
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("intermediate");
  const [count, setCount] = useState(5);

  const submit = (topic: string) => {
    const trimmed = topic.trim();
    if (!trimmed || loading) return;
    onStart(trimmed, difficulty, count);
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(query);
        }}
        className="flex flex-col gap-4"
      >
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What do you want to be quizzed on?"
          aria-label="Quiz topic"
          className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg border border-border p-1">
            {DIFFICULTIES.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setDifficulty(level)}
                className={`rounded-md px-3 py-1.5 text-xs capitalize transition-colors ${
                  difficulty === level
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {level}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Questions
            <select
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none"
            >
              {[3, 5, 8, 10].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>

          <Button type="submit" disabled={loading || !query.trim()} className="ml-auto">
            {loading ? "Generating…" : "Start quiz"}
          </Button>
        </div>
      </form>

      <div className="mt-6">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles size={13} />
          Topics covered by the current textbooks
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SUGGESTED_TOPICS.map((topic) => (
            <button
              key={topic}
              type="button"
              disabled={loading}
              onClick={() => {
                setQuery(topic);
                submit(topic);
              }}
              className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground disabled:opacity-50"
            >
              {topic}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
```

The chips both fill the input *and* submit, so they're one click rather than two. They pass the
topic explicitly to `submit` rather than relying on `setQuery` — React state updates are
asynchronous, so reading `query` right after `setQuery` would submit the previous value.

### `src/components/quiz/QuizRunner.tsx`

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { QuizQuestion } from "@/lib/quizApi";

type Props = {
  questions: QuizQuestion[];
  onSubmit: (answers: number[]) => void;
  submitting: boolean;
};

export function QuizRunner({ questions, onSubmit, submitting }: Props) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(
    () => questions.map(() => null),
  );

  const question = questions[index]!;
  const selected = answers[index];
  const isLast = index === questions.length - 1;

  const choose = (choiceIndex: number) => {
    setAnswers((previous) =>
      previous.map((value, i) => (i === index ? choiceIndex : value)),
    );
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Question {index + 1} of {questions.length}</span>
        <span className="tabular-nums">
          {answers.filter((answer) => answer !== null).length} answered
        </span>
      </div>

      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${((index + 1) / questions.length) * 100}%` }}
        />
      </div>

      <h2 className="mt-6 text-lg font-medium leading-relaxed">{question.question}</h2>

      <div className="mt-4 flex flex-col gap-2">
        {question.choices.map((choice, choiceIndex) => (
          <button
            key={choiceIndex}
            type="button"
            onClick={() => choose(choiceIndex)}
            className={`rounded-xl border p-3.5 text-left text-sm transition-colors ${
              selected === choiceIndex
                ? "border-primary bg-primary/5"
                : "border-border hover:border-foreground/20"
            }`}
          >
            <span className="mr-2 text-muted-foreground">
              {String.fromCharCode(65 + choiceIndex)}.
            </span>
            {choice}
          </button>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          size="sm"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          Previous
        </Button>

        {isLast ? (
          <Button
            disabled={answers.some((answer) => answer === null) || submitting}
            onClick={() => onSubmit(answers as number[])}
          >
            {submitting ? "Grading…" : "Submit quiz"}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setIndex(index + 1)}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}
```

**No per-question feedback:** the client doesn't have the answer key, by design. Correctness is
revealed only in the submit response. The submit button is gated on every question being answered
so a partially-filled `answers` array can't quietly score zeros.

### `src/components/quiz/QuizResult.tsx`

```tsx
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QuizResultResponse } from "@/lib/quizApi";

type Props = {
  result: QuizResultResponse;
  topic: string;
  onRestart: () => void;
};

export function QuizResult({ result, topic, onRestart }: Props) {
  const percentage = Math.round((result.score / result.total) * 100);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="rounded-xl border border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">{topic}</p>
        <p className="mt-2 text-4xl font-semibold tabular-nums">
          {result.score}
          <span className="text-2xl text-muted-foreground">/{result.total}</span>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{percentage}% correct</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRestart}>
          New quiz
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {result.perQuestion.map((item, index) => {
          const correct = item.selectedIndex === item.correctIndex;
          return (
            <article
              key={index}
              className={`rounded-xl border p-4 ${
                correct
                  ? "border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/10"
                  : "border-destructive/30 bg-destructive/5"
              }`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 shrink-0 rounded-full p-1 ${
                    correct
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-destructive/15 text-destructive"
                  }`}
                >
                  {correct ? <Check size={13} /> : <X size={13} />}
                </span>
                <h3 className="text-sm font-medium">{item.question}</h3>
              </div>

              {!correct && item.selectedIndex !== null && (
                <p className="mt-3 text-sm text-muted-foreground">
                  <span className="text-destructive">Your answer:</span>{" "}
                  {item.choices[item.selectedIndex]}
                </p>
              )}

              <p className="mt-1.5 text-sm">
                <span className="text-muted-foreground">Correct:</span>{" "}
                {item.choices[item.correctIndex]}
              </p>

              <p className="mt-2 border-t border-border/60 pt-2 text-xs leading-relaxed text-muted-foreground">
                {item.explanation}
              </p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
```

### `src/pages/QuizPage.tsx`

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import axios from "axios";
import { TopicPicker } from "@/components/quiz/TopicPicker";
import { QuizRunner } from "@/components/quiz/QuizRunner";
import { QuizResult } from "@/components/quiz/QuizResult";
import {
  startQuiz,
  submitQuiz,
  type Difficulty,
  type QuizStartResponse,
  type QuizResultResponse,
} from "@/lib/quizApi";

export function QuizPage() {
  const [quiz, setQuiz] = useState<QuizStartResponse | null>(null);
  const [result, setResult] = useState<QuizResultResponse | null>(null);
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onStart = async (query: string, difficulty: Difficulty, count: number) => {
    setLoading(true);
    setError(null);
    try {
      const started = await startQuiz(query, difficulty, count);
      setTopic(query);
      setQuiz(started);
    } catch (caught) {
      // 404 here means the corpus has no coverage — a distinct, expected outcome
      // rather than a failure, so it gets its own message.
      setError(
        axios.isAxiosError(caught) && caught.response?.status === 404
          ? `No textbook content covers "${query}" yet. Try one of the suggested topics.`
          : "Something went wrong generating your quiz.",
      );
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = async (answers: number[]) => {
    if (!quiz) return;
    setSubmitting(true);
    try {
      setResult(await submitQuiz(quiz.sessionId, answers));
    } catch {
      setError("Something went wrong grading your quiz.");
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    setQuiz(null);
    setResult(null);
    setTopic("");
    setError(null);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-5">
          <Link
            to="/"
            className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={15} />
            Back to lab
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              <span className="bg-[linear-gradient(transparent_62%,var(--primary)_62%)] px-1 -mx-1">
                Quiz
              </span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {quiz && !result
                ? topic
                : "Test yourself on any topic from the textbook library"}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
        {result ? (
          <QuizResult result={result} topic={topic} onRestart={restart} />
        ) : quiz ? (
          <QuizRunner
            questions={quiz.questions}
            onSubmit={onSubmit}
            submitting={submitting}
          />
        ) : (
          <TopicPicker onStart={onStart} loading={loading} error={error} />
        )}
      </main>
    </div>
  );
}
```

Three phases held in one component's state (`picking` → `answering` → `result`), derived from
which of `quiz` / `result` is set rather than an explicit phase enum — there are only three states
and they're totally ordered, so a separate enum would be a second source of truth. This matches
how `NotesPage.tsx` derives its own view states.

### `src/App.tsx` — new route

```tsx
import { QuizPage } from "./pages/QuizPage";

// ...alongside the existing /notes route:
<Route
  path="/quiz"
  element={
    <ProtectedRoute>
      <QuizPage />
    </ProtectedRoute>
  }
/>
```

Add a link to `/quiz` in `src/components/UserMenu.tsx` next to the existing Notes link so the page
is reachable.

---

## 8. Build order

1. Migrations §1 → verify with `mcp__supabase__list_extensions` and `list_tables`.
2. Deps §2 + `.gitignore` line.
3. `textbook.repository.ts` §3a + `ingestTextbooks.ts` §6 → ingest one PDF.
4. `quiz.repository.ts` §3b + `quiz.service.ts` §4 → exercise from a scratch script before
   wiring HTTP.
5. Controller + routes §5.
6. Client §7.
7. Replace `quiz-feature.md` with this document.

---

## 9. Verification

**Ingest.** After running the script:

```sql
select source_file, count(*), min(length(content)), max(length(content))
from textbook_chunks group by source_file;
```

Expect hundreds of chunks per textbook and no near-zero minimum length. Re-run the script on the
same file and confirm the count is unchanged — that proves `replaceChunks` is idempotent rather
than duplicating the corpus.

**Retrieval.** Confirm the HNSW index is actually used, since ordering by the wrong expression
silently falls back to a sequential scan:

```sql
explain analyze
select id from textbook_chunks
order by embedding <=> (select embedding from textbook_chunks limit 1)
limit 8;
```

Look for `Index Scan using textbook_chunks_embedding_idx`, not `Seq Scan`.

Then call `match_textbook_chunks` with an embedding for a covered topic and read the returned
chunks — they should be topically right, with `similarity` comfortably above `0.3`. Repeat with a
topic clearly outside the corpus and confirm similarity drops below the threshold so
`NoCoverageError` fires. **Tune `MIN_SIMILARITY` from these two numbers**, not from the default.

**Generation.** `POST /api/quiz/start` with a covered topic, then:

- Grep the raw response JSON for `correctIndex` and `explanation` — **both must be absent.** This
  is the security property the entire session design exists to provide.
- Read the stored `quiz_sessions.questions` row yourself. Because first-pass validation is
  structural only, question *correctness* is verified by eye at this stage. If you find wrong
  answer keys, add the grounding-quote guard described at the end of §4c.
- Check that distractors are plausible rather than filler. If they aren't, the exemplars in §4a
  are the lever, not the rules list.

**Grading.**

- Submit a known-correct answer set → `score === total`.
- Submit a wrong set → returned `correctIndex` values match the stored row.
- Submit the same `sessionId` twice → second attempt returns **409**.

**Auth and ownership.** RLS is off, so ownership scoping is application code and must be tested:

- Both endpoints with no `Authorization` header → 401.
- `submit` with another user's `sessionId` → **404, not 200.**

**End to end.** `bun run dev` in both packages, visit `/quiz`, run a full quiz through the UI, and
confirm a Langfuse trace named `quiz-generation` appears with a `generate-quiz` span nested under
it.
