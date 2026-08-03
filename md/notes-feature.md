# Notes Feature: Auto-capture key Q&A from lab chat

## Context

Users chat with an LLM while working through a generated lab (`chat.service.ts` → `POST /api/chat`). Right now nothing from that conversation is retained beyond the raw `messages` table, and the `/notes` page (`NotesPage.tsx`) is an empty placeholder shell. The ask: when a user asks a question during a lab, run a second, lightweight LLM pass that decides whether the exchange is worth remembering, distills it into a short note, and stores it against that lab so the user can review "key notes" later on the Notes page.

This also finally makes use of the `labGenerationId` parameter that `chatService.sendMessage` already accepts but currently ignores.

**Decisions:**
- **Selective saving** — the note-extraction LLM returns `{ shouldSave, title, note }`; only substantive exchanges are persisted.
- **Fire-and-forget** — note extraction runs after the chat response is sent, not awaited, wrapped so failures only log server-side and never affect the chat UX.
- **Notes page scope** — `/notes` shows all of a user's notes across every lab, grouped by lab (using the lab's `topic_text` as the section heading).

---

## 1. Database migration

Apply via `mcp__supabase__apply_migration` (no Drizzle/Prisma in this repo — schema lives directly in Supabase):

```sql
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  lab_generation_id uuid not null references public.lab_generations(id),
  conversation_id uuid references public.conversations(id),
  question text not null,
  title text not null,
  content text not null,
  created_at timestamptz not null default now()
);
```

RLS stays disabled, matching every other table (`conversations`, `messages`, `lab_generations`) — the server only ever accesses Postgres via the service-role key.

---

## 2. `packages/server/repositories/notes.repository.ts`

```ts
import { supabase } from '../lib/supabase'

export type Note = {
    id: string;
    labGenerationId: string;
    topic: string;
    question: string;
    title: string;
    content: string;
    createdAt: string;
}

export const notesRepository = {
    async create(
        userId: string,
        labGenerationId: string,
        conversationId: string,
        question: string,
        title: string,
        content: string,
    ): Promise<void> {
        const { error } = await supabase
            .from('notes')
            .insert({
                user_id: userId,
                lab_generation_id: labGenerationId,
                conversation_id: conversationId,
                question,
                title,
                content,
            })
        if (error) throw new Error(`create failed: ${error.message}`)
    },

    async listByUser(userId: string): Promise<Note[]> {
        const { data, error } = await supabase
            .from('notes')
            .select('id, lab_generation_id, question, title, content, created_at, lab_generations(topic_text)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })

        if (error) throw new Error(`listByUser failed: ${error.message}`)

        return (data ?? []).map((row) => ({
            id: row.id,
            labGenerationId: row.lab_generation_id,
            topic: (row.lab_generations as { topic_text: string }[] | null)?.[0]?.topic_text ?? 'Untitled lab',
            question: row.question,
            title: row.title,
            content: row.content,
            createdAt: row.created_at,
        }))
    },
}
```

---

## 3. `packages/server/services/notes.service.ts`

Same `.withStructuredOutput()` technique as `labGeneration.service.ts`:

```ts
import { ChatOpenAI } from '@langchain/openai';
import z from 'zod';
import { notesRepository, type Note } from '../repositories/notes.repository';

const noteSchema = z.object({
    shouldSave: z.boolean(),
    title: z.string(),
    note: z.string(),
});

const llm = new ChatOpenAI({ model: 'gpt-4o', maxTokens: 150 }).withStructuredOutput(noteSchema);

export const notesService = {
    async extractAndSave(
        question: string,
        answer: string,
        userId: string,
        labGenerationId: string,
        conversationId: string,
    ): Promise<void> {
        const result = await llm.invoke(
            `A user asked the following question while working through a hands-on lab, and received this answer.\n\n` +
            `Question: "${question}"\n\nAnswer: "${answer}"\n\n` +
            `Decide if this exchange contains a key learning worth saving as a study note ` +
            `(set shouldSave to false for small talk, acknowledgements, or trivial exchanges). ` +
            `If it should be saved, write a short title (max 8 words) and a concise note ` +
            `(2-4 sentences) that distills the explanation for later review.`,
        )

        if (!result.shouldSave) return

        await notesRepository.create(userId, labGenerationId, conversationId, question, result.title, result.note)
    },

    async listForUser(userId: string): Promise<Note[]> {
        return notesRepository.listByUser(userId)
    },
}
```

---

## 4. Wire into `packages/server/services/chat.service.ts`

Full file, with the new call added (fire-and-forget, `.catch` guards against an unhandled rejection):

```ts
import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { conversationRepository } from '../repositories/conversation.repository';
import { notesService } from './notes.service';

type chatResponse = {
    message: string;
}

const llm = new ChatOpenAI({ model: 'gpt-4o', maxTokens: 500 })

export class ConversationNotFoundError extends Error {}

export const chatService = {
    async sendMessage(
        prompt: string,
        conversationId: string,
        userId: string,
        labGenerationId: string,
    ): Promise<chatResponse> {
        const chatHistory = await conversationRepository.getMessages(conversationId, userId);
        if (chatHistory === null) {
            throw new ConversationNotFoundError(`Conversation ${conversationId} not found`);
        }
        const response = await llm.invoke([new HumanMessage(prompt), ...chatHistory]);

        await conversationRepository.addMessages(conversationId, prompt, response.content as string)

        notesService
            .extractAndSave(prompt, response.content as string, userId, labGenerationId, conversationId)
            .catch((err) => console.error('[notes] extraction failed:', err));

        return { message: response.content as string }
    }
}
```

(Only two lines changed from the current file: the `notesService` import and the `notesService.extractAndSave(...).catch(...)` call.)

---

## 5. `packages/server/controllers/notes.controller.ts`

```ts
import type { Request, Response } from 'express';
import { notesService } from '../services/notes.service';

export const notesController = {
    async list(req: Request, res: Response) {
        try {
            const notes = await notesService.listForUser(req.user!.id)
            res.json({ notes })
        }
        catch (error) {
            console.error('[notes] error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    }
}
```

---

## 6. `packages/server/routes.ts`

Add the import and route (diff against current file):

```ts
import { notesController } from './controllers/notes.controller';
// ...
router.get('/api/notes', requireAuth, notesController.list);
```

Full route list after the change:

```ts
router.post('/api/chat', requireAuth, chatController.sendMessage);
router.get('/api/conversations', requireAuth, conversationController.list);
router.get('/api/conversations/:id/messages', requireAuth, conversationController.getMessages);
router.post('/api/labs/generate', requireAuth, labGenerationController.generate);
router.get('/api/notes', requireAuth, notesController.list);
```

---

## 7. `packages/client/src/pages/NotesPage.tsx`

Full replacement of the placeholder, grouping notes by lab topic:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";

type Note = {
  id: string;
  labGenerationId: string;
  topic: string;
  question: string;
  title: string;
  content: string;
  createdAt: string;
};

type NotesResponse = {
  notes: Note[];
};

function groupByLab(notes: Note[]): { labGenerationId: string; topic: string; notes: Note[] }[] {
  const groups = new Map<string, { labGenerationId: string; topic: string; notes: Note[] }>();
  for (const note of notes) {
    const existing = groups.get(note.labGenerationId);
    if (existing) {
      existing.notes.push(note);
    } else {
      groups.set(note.labGenerationId, {
        labGenerationId: note.labGenerationId,
        topic: note.topic,
        notes: [note],
      });
    }
  }
  return Array.from(groups.values());
}

export function NotesPage() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<NotesResponse>("/api/notes")
      .then(({ data }) => setNotes(data.notes))
      .catch(() => setError("Something went wrong loading your notes."));
  }, []);

  const groups = notes ? groupByLab(notes) : [];

  return (
    <div className="relative flex h-full flex-col gap-6 overflow-y-auto p-6">
      <Link
        to="/"
        className="absolute bottom-3 left-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Back to lab
      </Link>

      <h1 className="text-lg font-semibold">Notes</h1>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {notes && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No notes yet — ask a question while working through a lab.
        </p>
      )}

      {groups.map((group) => (
        <section key={group.labGenerationId} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{group.topic}</h2>
          <div className="flex flex-col gap-2">
            {group.notes.map((note) => (
              <div key={note.id} className="rounded-lg border p-3">
                <p className="text-sm font-medium">{note.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{note.content}</p>
                <p className="mt-2 text-xs text-muted-foreground/70">Asked: {note.question}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

No changes needed to `ChatBot.tsx` — it already sends `labGenerationId` with every chat request.

---

## Verification

1. Apply the migration, confirm `notes` table exists via `list_tables`.
2. `bun run` the server, log in, generate a lab, and ask a substantive question in chat (e.g. "why do we use a virtual environment here?"):
   - Chat response still returns normally and promptly (fire-and-forget shouldn't add latency).
   - A row appears in `notes` for that user + lab.
3. Ask a trivial message (e.g. "ok thanks") — confirm no note is created (`shouldSave: false` path).
4. Visit `/notes` — confirm the note appears grouped under the correct lab's topic heading, and a second lab/question produces a second group.
5. Temporarily throw inside `extractAndSave` — confirm the chat response is unaffected and the error is only logged server-side.
