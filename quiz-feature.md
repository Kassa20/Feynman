# Standalone Quiz Section — Full Implementation

> **Note on file location:** plan mode restricts edits to this plan file, so the complete implementation lives here. On approval it can be split into the real source files at the paths given in each section heading.

## Context

The quiz is its **own section**, not attached to a lab. A user opens `/quiz`, picks a curated topic and difficulty, answers multiple-choice questions drawn from a pre-built bank, and sees a graded result. Nothing depends on lab generation.

There is currently **zero quiz code** in the repo — no table, route, service, or component. Everything below is new.

Decisions this design encodes:

- **Retrieval is plain SQL.** With a fixed topic dropdown, selection is `WHERE topic_id = $1 AND difficulty = $2 ORDER BY random()`. pgvector is kept out of the request path entirely and appears only as optional ingest-time dedup (Phase 5).
- **No skill-level persistence.** `user_topic_skill` is not built; attempts record score history only.
- **Open-licensed sources only.** Provenance columns are `not null`, so a question without a recorded source cannot be inserted.

---

## 1. Database migrations

Applied with `mcp__supabase__apply_migration` — this repo keeps no migration files (`notes-feature.md:19`); schema lives in Supabase.

### 1a. `quiz_topics`

A table rather than a Postgres enum. The dropdown needs display labels and ordering, and a table avoids an `ALTER TYPE ADD VALUE` migration every time a topic is added.

```sql
create table public.quiz_topics (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  label      text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);
```

### 1b. `quiz_questions`

```sql
create table public.quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  topic_id       uuid not null references public.quiz_topics(id) on delete cascade,
  difficulty     skill_level not null,
  question       text not null,
  choices        jsonb not null,
  correct_index  int  not null,
  explanation    text,
  source_name    text not null,
  source_url     text not null,
  source_license text not null,
  natural_key    text not null unique,
  created_at     timestamptz not null default now(),

  constraint quiz_questions_choices_is_array
    check (jsonb_typeof(choices) = 'array'),
  constraint quiz_questions_choices_len
    check (jsonb_array_length(choices) between 2 and 6),
  constraint quiz_questions_correct_index_range
    check (correct_index >= 0 and correct_index < jsonb_array_length(choices))
);

create index quiz_questions_topic_difficulty_idx
  on public.quiz_questions (topic_id, difficulty);
```

**Why these details matter:**

- `difficulty skill_level` **reuses the existing enum** already defined for `lab_generations` (`beginner`/`intermediate`/`advanced`). No new type, and it stays consistent with `SkillLevel` in `packages/server/repositories/labGeneration.repository.ts:4`.
- The `correct_index_range` check is the important one. It references `jsonb_array_length(choices)` in the same row, so Postgres itself guarantees the answer key always points at a real choice. A bad ingest row fails at insert instead of producing a question that can never be answered correctly.
- `natural_key` makes ingestion idempotent — see §5.

### 1c. `quiz_attempts`

```sql
create table public.quiz_attempts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  topic_id   uuid not null references public.quiz_topics(id),
  difficulty skill_level not null,
  score      int  not null,
  total      int  not null,
  answers    jsonb not null,
  created_at timestamptz not null default now()
);

create index quiz_attempts_user_idx
  on public.quiz_attempts (user_id, created_at desc);
```

`answers` stores `[{ questionId, selectedIndex, correct }]` — enough to re-render a past attempt without joining back to questions that may since have been edited.

Follow the existing convention: RLS disabled, all access through the service-role client in `packages/server/lib/supabase.ts` (the posture recorded in `notes-feature.md:35`). `quiz_attempts` is per-user data, so it belongs in whatever future pass revisits RLS across all tables — but changing it here alone would be inconsistent with the other four.

### 1d. Random-selection RPC

```sql
create or replace function public.get_quiz_questions(
  p_topic_id   uuid,
  p_difficulty skill_level,
  p_limit      int
)
returns setof public.quiz_questions
language sql
stable
as $$
  select *
  from public.quiz_questions
  where topic_id = p_topic_id
    and difficulty = p_difficulty
  order by random()
  limit p_limit;
$$;
```

**Why an RPC:** `supabase-js` has no query-builder expression for `ORDER BY random()`. The alternatives are fetching every matching row and shuffling in Node (wasteful and gets worse as the bank grows) or generating random offsets (extra round trips, and breaks when rows are deleted). A `stable` SQL function keeps the shuffle in Postgres and stays a single call.

At bank sizes in the low thousands `ORDER BY random()` performs a sort over the filtered subset, which is fine. If the bank ever reaches six figures, revisit with `tablesample`.

---

## 2. Server — repository (`packages/server/repositories/quiz.repository.ts`)

The only layer touching Supabase, mirroring `notes.repository.ts`: destructure `{ data, error }`, throw on error with a prefixed message, and map snake_case → camelCase here so no other layer sees database naming.

```ts
import { supabase } from '../lib/supabase'
import type { SkillLevel } from './labGeneration.repository'

export type QuizTopic = {
    id: string;
    slug: string;
    label: string;
}

/** Full row, answer key included. Never hand this to a controller unfiltered. */
export type QuizQuestion = {
    id: string;
    topicId: string;
    difficulty: SkillLevel;
    question: string;
    choices: string[];
    correctIndex: number;
    explanation: string | null;
}

export type QuizAttemptSummary = {
    id: string;
    topic: string;
    difficulty: SkillLevel;
    score: number;
    total: number;
    createdAt: string;
}

type QuizQuestionRow = {
    id: string;
    topic_id: string;
    difficulty: SkillLevel;
    question: string;
    choices: string[];
    correct_index: number;
    explanation: string | null;
}

const toQuestion = (row: QuizQuestionRow): QuizQuestion => ({
    id: row.id,
    topicId: row.topic_id,
    difficulty: row.difficulty,
    question: row.question,
    choices: row.choices,
    correctIndex: row.correct_index,
    explanation: row.explanation,
})

export const quizRepository = {
    async listTopics(): Promise<QuizTopic[]> {
        const { data, error } = await supabase
            .from('quiz_topics')
            .select('id, slug, label')
            .order('sort_order', { ascending: true })

        if (error) throw new Error(`listTopics failed: ${error.message}`)

        return data ?? []
    },

    async getRandomQuestions(
        topicId: string,
        difficulty: SkillLevel,
        limit: number
    ): Promise<QuizQuestion[]> {
        const { data, error } = await supabase.rpc('get_quiz_questions', {
            p_topic_id: topicId,
            p_difficulty: difficulty,
            p_limit: limit,
        })

        if (error) throw new Error(`getRandomQuestions failed: ${error.message}`)

        return (data ?? []).map(toQuestion)
    },

    async getQuestionsByIds(ids: string[]): Promise<QuizQuestion[]> {
        if (ids.length === 0) return []

        const { data, error } = await supabase
            .from('quiz_questions')
            .select('id, topic_id, difficulty, question, choices, correct_index, explanation')
            .in('id', ids)

        if (error) throw new Error(`getQuestionsByIds failed: ${error.message}`)

        return (data ?? []).map(toQuestion)
    },

    async createAttempt(
        userId: string,
        topicId: string,
        difficulty: SkillLevel,
        score: number,
        total: number,
        answers: unknown
    ): Promise<void> {
        const { error } = await supabase
            .from('quiz_attempts')
            .insert({ user_id: userId, topic_id: topicId, difficulty, score, total, answers })

        if (error) throw new Error(`createAttempt failed: ${error.message}`)
    },

    async listAttempts(userId: string): Promise<QuizAttemptSummary[]> {
        const { data, error } = await supabase
            .from('quiz_attempts')
            .select('id, difficulty, score, total, created_at, quiz_topics(label)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50)

        if (error) throw new Error(`listAttempts failed: ${error.message}`)

        return (data ?? []).map((row) => ({
            id: row.id,
            topic: (row.quiz_topics as { label: string }[] | null)?.[0]?.label ?? 'Unknown topic',
            difficulty: row.difficulty,
            score: row.score,
            total: row.total,
            createdAt: row.created_at,
        }))
    },
}
```

The `quiz_topics(label)` join and the `?.[0]?.label ?? fallback` unwrap deliberately mirror `notes.repository.ts:40,50` — supabase-js types embedded relations as arrays even for many-to-one, so the same defensive shape is used rather than inventing a new one.

---

## 3. Server — service (`packages/server/services/quiz.service.ts`)

No LLM at request time, so this is ordinary async functions — not the async generators used by `labGeneration.service.ts` and `chat.service.ts`, which exist only to stream model output.

```ts
import { quizRepository, type QuizQuestion } from '../repositories/quiz.repository'
import type { SkillLevel } from '../repositories/labGeneration.repository'

const QUESTIONS_PER_QUIZ = 5

/** What the client is allowed to see when a quiz starts: no answer key. */
export type PublicQuizQuestion = {
    id: string;
    question: string;
    choices: string[];
}

export type SubmittedAnswer = {
    questionId: string;
    selectedIndex: number;
}

export type GradedAnswer = {
    questionId: string;
    question: string;
    choices: string[];
    selectedIndex: number;
    correctIndex: number;
    correct: boolean;
    explanation: string | null;
}

const toPublic = (q: QuizQuestion): PublicQuizQuestion => ({
    id: q.id,
    question: q.question,
    choices: q.choices,
})

export const quizService = {
    listTopics() {
        return quizRepository.listTopics()
    },

    async startQuiz(topicId: string, difficulty: SkillLevel): Promise<PublicQuizQuestion[]> {
        const questions = await quizRepository.getRandomQuestions(
            topicId, difficulty, QUESTIONS_PER_QUIZ
        )
        // Whitelist fields rather than deleting them — a future column added to
        // QuizQuestion cannot accidentally leak through this boundary.
        return questions.map(toPublic)
    },

    async submitQuiz(
        userId: string,
        topicId: string,
        difficulty: SkillLevel,
        answers: SubmittedAnswer[]
    ): Promise<{ score: number; total: number; results: GradedAnswer[] }> {
        const ids = answers.map((a) => a.questionId)
        const questions = await quizRepository.getQuestionsByIds(ids)
        const byId = new Map(questions.map((q) => [q.id, q]))

        const results: GradedAnswer[] = answers.map((answer) => {
            const question = byId.get(answer.questionId)
            if (!question) {
                throw new Error(`unknown question id: ${answer.questionId}`)
            }
            // Reject ids that exist but belong to a different quiz than the one
            // claimed, so a client cannot mix in easy questions from elsewhere.
            if (question.topicId !== topicId || question.difficulty !== difficulty) {
                throw new Error(`question ${answer.questionId} does not belong to this quiz`)
            }

            return {
                questionId: question.id,
                question: question.question,
                choices: question.choices,
                selectedIndex: answer.selectedIndex,
                correctIndex: question.correctIndex,
                correct: answer.selectedIndex === question.correctIndex,
                explanation: question.explanation,
            }
        })

        const score = results.filter((r) => r.correct).length

        await quizRepository.createAttempt(
            userId,
            topicId,
            difficulty,
            score,
            results.length,
            results.map((r) => ({
                questionId: r.questionId,
                selectedIndex: r.selectedIndex,
                correct: r.correct,
            }))
        )

        return { score, total: results.length, results }
    },

    listAttempts(userId: string) {
        return quizRepository.listAttempts(userId)
    },
}
```

**The two things that carry real weight here:**

1. **`startQuiz` whitelists instead of deleting.** Building a fresh object with three named fields means the answer key cannot escape even if `QuizQuestion` grows new columns later. A `delete question.correctIndex` approach would silently start leaking the day someone adds a `hint` column.

2. **`submitQuiz` re-reads the questions from the database.** The client sends only `questionId` and `selectedIndex`; correctness is computed server-side against the stored `correct_index`. The extra `topicId`/`difficulty` check closes the gap where a client submits real question ids that belong to a *different* topic or an easier difficulty in order to inflate a score. Nothing the client claims about correctness is ever trusted.

---

## 4. Server — controller and routes

### `packages/server/controllers/quiz.controller.ts`

Validation via zod, matching `labGeneration.controller.ts:10-14`; error handling matching `notes.controller.ts` exactly.

```ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import { quizService } from '../services/quiz.service';

const skillLevelSchema = z.enum(['beginner', 'intermediate', 'advanced'])

const startSchema = z.object({
    topicId: z.string().uuid(),
    difficulty: skillLevelSchema,
})

const submitSchema = z.object({
    topicId: z.string().uuid(),
    difficulty: skillLevelSchema,
    answers: z.array(z.object({
        questionId: z.string().uuid(),
        selectedIndex: z.number().int().min(0).max(5),
    })).min(1).max(20),
})

export const quizController = {
    async listTopics(req: Request, res: Response) {
        try {
            const topics = await quizService.listTopics()
            res.json({ topics })
        } catch (error) {
            console.error('[quiz] listTopics error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    },

    async start(req: Request, res: Response) {
        const parsed = startSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({ message: 'Invalid request' })
        }

        try {
            const questions = await quizService.startQuiz(
                parsed.data.topicId, parsed.data.difficulty
            )
            if (questions.length === 0) {
                return res.status(404).json({ message: 'No questions available for this topic yet' })
            }
            res.json({ questions })
        } catch (error) {
            console.error('[quiz] start error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    },

    async submit(req: Request, res: Response) {
        const parsed = submitSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({ message: 'Invalid request' })
        }

        try {
            const result = await quizService.submitQuiz(
                req.user!.id,
                parsed.data.topicId,
                parsed.data.difficulty,
                parsed.data.answers
            )
            res.json(result)
        } catch (error) {
            console.error('[quiz] submit error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    },

    async listAttempts(req: Request, res: Response) {
        try {
            const attempts = await quizService.listAttempts(req.user!.id)
            res.json({ attempts })
        } catch (error) {
            console.error('[quiz] listAttempts error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    },
}
```

`req.user!.id` is safe because every route below is behind `requireAuth`, which attaches `req.user` — the same assumption `notesController.listNotes` makes.

The `questions.length === 0` case is a real one: a topic row can exist before any questions have been ingested for a given difficulty. Returning 404 with a clear message beats rendering an empty quiz.

### `packages/server/routes.ts` — additions

```ts
import { quizController } from './controllers/quiz.controller';

router.get('/api/quiz/topics', requireAuth, quizController.listTopics);
router.post('/api/quiz/start', requireAuth, quizController.start);
router.post('/api/quiz/submit', requireAuth, quizController.submit);
router.get('/api/quiz/attempts', requireAuth, quizController.listAttempts);
```

`start` is a POST despite being a read, because it takes a body and has the side effect of choosing a random set. Keeping it non-idempotent-by-intent avoids any caching layer serving the same five questions twice.

---

## 5. Content ingestion — outside the app path

### `packages/server/data/quiz-seed/kubernetes.json`

```json
{
  "topic": { "slug": "kubernetes", "label": "Kubernetes", "sortOrder": 1 },
  "questions": [
    {
      "difficulty": "beginner",
      "question": "Which Kubernetes object ensures a specified number of pod replicas are running at any given time?",
      "choices": ["Service", "ReplicaSet", "ConfigMap", "Ingress"],
      "correctIndex": 1,
      "explanation": "A ReplicaSet's controller continuously reconciles actual pod count against its desired replica count.",
      "sourceName": "Kubernetes Documentation — ReplicaSet",
      "sourceUrl": "https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/",
      "sourceLicense": "CC-BY-4.0"
    }
  ]
}
```

### `packages/server/scripts/ingestQuiz.ts`

Run manually: `bun run scripts/ingestQuiz.ts`. Never imported by the server.

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { supabase } from '../lib/supabase'

const SEED_DIR = join(import.meta.dir, '..', 'data', 'quiz-seed')

const questionSchema = z.object({
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
    question: z.string().trim().min(10),
    choices: z.array(z.string().trim().min(1)).min(2).max(6),
    correctIndex: z.number().int().min(0),
    explanation: z.string().trim().min(1).nullable().default(null),
    sourceName: z.string().trim().min(1),
    sourceUrl: z.string().url(),
    sourceLicense: z.string().trim().min(1),
}).refine((q) => q.correctIndex < q.choices.length, {
    message: 'correctIndex is out of range for choices',
    path: ['correctIndex'],
})

const fileSchema = z.object({
    topic: z.object({
        slug: z.string().trim().min(1),
        label: z.string().trim().min(1),
        sortOrder: z.number().int().default(0),
    }),
    questions: z.array(questionSchema).min(1),
})

/** Stable identity for a question so re-running the script updates instead of duplicating. */
const naturalKey = (topicSlug: string, question: string) =>
    createHash('sha256')
        .update(`${topicSlug}::${question.trim().toLowerCase()}`)
        .digest('hex')

async function ingestFile(fileName: string) {
    const raw = await readFile(join(SEED_DIR, fileName), 'utf-8')
    const { topic, questions } = fileSchema.parse(JSON.parse(raw))

    const { data: topicRow, error: topicError } = await supabase
        .from('quiz_topics')
        .upsert(
            { slug: topic.slug, label: topic.label, sort_order: topic.sortOrder },
            { onConflict: 'slug' }
        )
        .select('id')
        .single()

    if (topicError) throw new Error(`upsert topic ${topic.slug} failed: ${topicError.message}`)

    const rows = questions.map((q) => ({
        topic_id: topicRow.id,
        difficulty: q.difficulty,
        question: q.question,
        choices: q.choices,
        correct_index: q.correctIndex,
        explanation: q.explanation,
        source_name: q.sourceName,
        source_url: q.sourceUrl,
        source_license: q.sourceLicense,
        natural_key: naturalKey(topic.slug, q.question),
    }))

    const { error: questionError } = await supabase
        .from('quiz_questions')
        .upsert(rows, { onConflict: 'natural_key' })

    if (questionError) throw new Error(`upsert questions failed: ${questionError.message}`)

    console.log(`${fileName}: ${rows.length} questions -> ${topic.label}`)
}

const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith('.json'))
for (const file of files) {
    await ingestFile(file)
}
console.log(`done: ${files.length} file(s)`)
```

**Why `natural_key`:** without a stable identity, re-running ingestion after fixing one typo would insert every question a second time. Hashing `topic slug + normalized question text` gives a deterministic key that `onConflict` can target, so the script is safe to run repeatedly — the normal workflow while curating content.

The zod `.refine` on `correctIndex` duplicates the SQL check constraint on purpose: it fails fast with a readable path (`questions[3].correctIndex`) instead of a Postgres constraint-violation string.

Aim for ~20–30 questions per topic per difficulty so the random draw has real variety. Start with 3–4 topics.

---

## 6. Client (`packages/client`)

### `src/lib/quizApi.ts`

Thin wrapper over the existing Axios instance, which already injects the Supabase bearer token.

```ts
import api from './api'

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced'

export type QuizTopic = { id: string; slug: string; label: string }
export type QuizQuestion = { id: string; question: string; choices: string[] }
export type GradedAnswer = {
    questionId: string
    question: string
    choices: string[]
    selectedIndex: number
    correctIndex: number
    correct: boolean
    explanation: string | null
}
export type QuizResult = { score: number; total: number; results: GradedAnswer[] }

export const quizApi = {
    async listTopics() {
        const { data } = await api.get<{ topics: QuizTopic[] }>('/api/quiz/topics')
        return data.topics
    },
    async start(topicId: string, difficulty: SkillLevel) {
        const { data } = await api.post<{ questions: QuizQuestion[] }>(
            '/api/quiz/start', { topicId, difficulty }
        )
        return data.questions
    },
    async submit(topicId: string, difficulty: SkillLevel, answers: { questionId: string; selectedIndex: number }[]) {
        const { data} = await api.post<QuizResult>(
            '/api/quiz/submit', { topicId, difficulty, answers }
        )
        return data
    },
}
```

### `src/pages/QuizPage.tsx`

A three-phase state machine. Modeling it as one discriminated union rather than several booleans makes the impossible states unrepresentable — you cannot be "picking" and "showing results" at once.

```tsx
import { useEffect, useState } from 'react'
import { quizApi, type GradedAnswer, type QuizQuestion, type QuizTopic, type SkillLevel } from '../lib/quizApi'
import { TopicPicker } from '../components/quiz/TopicPicker'
import { QuizRunner } from '../components/quiz/QuizRunner'
import { QuizResult } from '../components/quiz/QuizResult'

type Phase =
    | { name: 'picking' }
    | { name: 'loading' }
    | { name: 'answering'; topicId: string; difficulty: SkillLevel; questions: QuizQuestion[] }
    | { name: 'result'; score: number; total: number; results: GradedAnswer[] }

export function QuizPage() {
    const [topics, setTopics] = useState<QuizTopic[]>([])
    const [phase, setPhase] = useState<Phase>({ name: 'picking' })
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        quizApi.listTopics().then(setTopics).catch(() => setError('Could not load topics'))
    }, [])

    async function handleStart(topicId: string, difficulty: SkillLevel) {
        setError(null)
        setPhase({ name: 'loading' })
        try {
            const questions = await quizApi.start(topicId, difficulty)
            setPhase({ name: 'answering', topicId, difficulty, questions })
        } catch {
            setError('No questions available for that topic yet.')
            setPhase({ name: 'picking' })
        }
    }

    async function handleSubmit(answers: { questionId: string; selectedIndex: number }[]) {
        if (phase.name !== 'answering') return
        const { topicId, difficulty } = phase
        setPhase({ name: 'loading' })
        try {
            const result = await quizApi.submit(topicId, difficulty, answers)
            setPhase({ name: 'result', ...result })
        } catch {
            setError('Could not submit your answers.')
            setPhase({ name: 'answering', topicId, difficulty, questions: phase.questions })
        }
    }

    return (
        <div className="mx-auto max-w-2xl px-4 py-8">
            <h1 className="mb-6 text-2xl font-semibold">Quiz</h1>
            {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

            {phase.name === 'picking' && (
                <TopicPicker topics={topics} onStart={handleStart} />
            )}
            {phase.name === 'loading' && (
                <p className="text-muted-foreground text-sm">Loading…</p>
            )}
            {phase.name === 'answering' && (
                <QuizRunner questions={phase.questions} onSubmit={handleSubmit} />
            )}
            {phase.name === 'result' && (
                <QuizResult
                    score={phase.score}
                    total={phase.total}
                    results={phase.results}
                    onRestart={() => setPhase({ name: 'picking' })}
                />
            )}
        </div>
    )
}
```

Note the submit-failure branch restores the previous `questions` array from the captured `phase` — without that, a network error would lose the user's place entirely.

### `src/components/quiz/TopicPicker.tsx`

```tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { QuizTopic, SkillLevel } from '@/lib/quizApi'

const LEVELS: SkillLevel[] = ['beginner', 'intermediate', 'advanced']

export function TopicPicker({
    topics, onStart,
}: {
    topics: QuizTopic[]
    onStart: (topicId: string, difficulty: SkillLevel) => void
}) {
    const [topicId, setTopicId] = useState<string | null>(null)
    const [difficulty, setDifficulty] = useState<SkillLevel>('beginner')

    return (
        <div className="space-y-6">
            <div>
                <p className="mb-2 text-sm font-medium">Topic</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {topics.map((t) => (
                        <button
                            key={t.id}
                            onClick={() => setTopicId(t.id)}
                            className={`rounded-lg border p-3 text-sm transition ${
                                topicId === t.id ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <p className="mb-2 text-sm font-medium">Difficulty</p>
                <div className="flex gap-2">
                    {LEVELS.map((level) => (
                        <button
                            key={level}
                            onClick={() => setDifficulty(level)}
                            className={`rounded-md border px-3 py-1.5 text-sm capitalize transition ${
                                difficulty === level ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                            }`}
                        >
                            {level}
                        </button>
                    ))}
                </div>
            </div>

            <Button disabled={!topicId} onClick={() => topicId && onStart(topicId, difficulty)}>
                Start quiz
            </Button>
        </div>
    )
}
```

### `src/components/quiz/QuizRunner.tsx`

One question at a time, answers held locally until submit.

```tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { QuizQuestion } from '@/lib/quizApi'

export function QuizRunner({
    questions, onSubmit,
}: {
    questions: QuizQuestion[]
    onSubmit: (answers: { questionId: string; selectedIndex: number }[]) => void
}) {
    const [index, setIndex] = useState(0)
    const [selections, setSelections] = useState<Record<string, number>>({})

    const question = questions[index]
    const selected = selections[question.id]
    const isLast = index === questions.length - 1

    function handleNext() {
        if (selected === undefined) return
        if (isLast) {
            onSubmit(
                questions.map((q) => ({ questionId: q.id, selectedIndex: selections[q.id] }))
            )
        } else {
            setIndex(index + 1)
        }
    }

    return (
        <div className="space-y-6">
            <p className="text-muted-foreground text-sm">
                Question {index + 1} of {questions.length}
            </p>
            <p className="text-lg font-medium">{question.question}</p>

            <div className="space-y-2">
                {question.choices.map((choice, i) => (
                    <button
                        key={i}
                        onClick={() => setSelections({ ...selections, [question.id]: i })}
                        className={`block w-full rounded-lg border p-3 text-left text-sm transition ${
                            selected === i ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                        }`}
                    >
                        {choice}
                    </button>
                ))}
            </div>

            <div className="flex gap-2">
                {index > 0 && (
                    <Button variant="outline" onClick={() => setIndex(index - 1)}>Back</Button>
                )}
                <Button disabled={selected === undefined} onClick={handleNext}>
                    {isLast ? 'Submit' : 'Next'}
                </Button>
            </div>
        </div>
    )
}
```

Selections are keyed by `question.id` rather than by position, so going Back and forward preserves answers correctly. Submit maps over `questions` (not `selections`) to guarantee the payload order and length always match the quiz that was served.

### `src/components/quiz/QuizResult.tsx`

```tsx
import { Button } from '@/components/ui/button'
import type { GradedAnswer } from '@/lib/quizApi'

export function QuizResult({
    score, total, results, onRestart,
}: {
    score: number
    total: number
    results: GradedAnswer[]
    onRestart: () => void
}) {
    return (
        <div className="space-y-6">
            <div>
                <p className="text-3xl font-semibold">{score} / {total}</p>
                <p className="text-muted-foreground text-sm">
                    {Math.round((score / total) * 100)}% correct
                </p>
            </div>

            <div className="space-y-4">
                {results.map((r) => (
                    <div key={r.questionId} className="rounded-lg border p-4">
                        <p className="mb-2 text-sm font-medium">{r.question}</p>
                        <p className={`text-sm ${r.correct ? 'text-green-600' : 'text-red-600'}`}>
                            Your answer: {r.choices[r.selectedIndex]}
                        </p>
                        {!r.correct && (
                            <p className="text-sm text-green-600">
                                Correct: {r.choices[r.correctIndex]}
                            </p>
                        )}
                        {r.explanation && (
                            <p className="text-muted-foreground mt-2 text-sm">{r.explanation}</p>
                        )}
                    </div>
                ))}
            </div>

            <Button onClick={onRestart}>Take another quiz</Button>
        </div>
    )
}
```

### `src/App.tsx` — new route

```tsx
import { QuizPage } from "./pages/QuizPage";

<Route
  path="/quiz"
  element={
    <ProtectedRoute>
      <QuizPage />
    </ProtectedRoute>
  }
/>
```

Placed alongside `/notes`, following the same `ProtectedRoute` wrapper pattern. Add a nav link wherever `/notes` is currently linked.

**One assumption to confirm at implementation time:** these components use `@/components/ui/button` and Tailwind utility classes directly rather than shadcn `RadioGroup`/`Card`, since I did not verify which shadcn components are installed. If `RadioGroup` is present, the choice lists are a natural fit for it and would improve keyboard accessibility.

---

## 7. Phase 5 (optional) — pgvector dedup at ingest

Worth doing only once the bank is large enough that manual dedup is annoying. Fully separable: nothing in the request path reads the column.

```sql
create extension if not exists vector;
alter table public.quiz_questions add column embedding vector(1536);
```

In `ingestQuiz.ts`, before inserting: embed the question text, and skip any candidate whose cosine distance to an existing question **in the same topic** falls below a threshold (~0.15 is a reasonable starting point), logging what was skipped so curation stays visible.

Skip the HNSW index initially — at a few thousand rows a sequential scan is faster than maintaining one.

If this phase is dropped, remove the column and the extension; no other file changes.

---

## 8. Build order

1. Migrations §1 → verify with `mcp__supabase__list_tables`.
2. Seed file + ingest script §5 for one topic → verify rows via `mcp__supabase__execute_sql`.
3. Repository, service, controller, routes §2–4 → verify with curl.
4. Client §6 → verify in browser.
5. Optional pgvector dedup §7.

## 9. Verification

- **Answer key never leaks** — the primary check. `curl` `/api/quiz/start` with a valid bearer token; confirm the response contains no `correctIndex`, `correct_index`, or `explanation`.
- **Grading is server-authoritative** — submit deliberately wrong answers and confirm the returned score reflects the stored key.
- **Cross-quiz submission is rejected** — submit a question id belonging to a different topic and confirm a 500 rather than a counted point.
- **Auth** — every `/api/quiz/*` route returns 401 without a token.
- **Attempts persist** — complete a quiz in the UI, then `select * from quiz_attempts order by created_at desc limit 1` and confirm it matches what was displayed.
- **Variety** — start the same topic/difficulty several times; question sets should differ.
- **Empty topic** — a topic with no questions at the chosen difficulty returns 404 with a readable message, not an empty quiz.
- **Ingest idempotency** — run `bun run scripts/ingestQuiz.ts` twice; row count must not change.
- `bun run lint` and `bun run build` in `packages/client`.

No test suite exists in this repo, so verification is manual — curl for the server, browser for the client.
