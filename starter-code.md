# Feature: Generate Starter Code (downloadable .zip)

## Context

Today the app produces step-by-step lab *instructions* only. `LabGeneratorForm` posts
`{topic, skillLevel, environment, conversationId}` to `/api/labs/generate`, one `gpt-4o` agent writes
the lab, and the markdown is dropped into the conversation as an AI message. The learner has to
hand-create every file the lab tells them to make.

This feature adds an opt-in **"Generate starter code"** checkbox below *Target environment*. When
checked, a second LLM agent produces a small scaffold project — commented stub files plus a
dependency manifest — which the user downloads as a `.zip` from the chat view.

### Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Language | LLM picks the language that fits the topic, and emits the **matching** manifest (`requirements.txt` for Python, `package.json` for Node, `go.mod` for Go…) | Lab topics are free text and range across stacks. A hardcoded `requirements.txt` on a React lab is worse than useless. |
| Download UI | Button above the chat thread | Always visible, survives reload, doesn't get buried under a long lab. |
| Zipping | Server-side with `fflate` | Files are stored once and re-downloadable forever; keeps the client dep-free (`fflate` is ~8KB and works under Bun). |
| When generated | Synchronously, inside `/api/labs/generate` | The user is already waiting on that request. Async would mean polling + a button that pops in late. |

---

## 1. Database migration

Apply via `mcp__supabase__apply_migration` (name it `add_starter_code_to_lab_generations`). Schema
lives only in remote Supabase — there is no migrations folder, same as the notes feature.

```sql
ALTER TABLE public.lab_generations ADD COLUMN starter_code jsonb;
```

**Design note:** nullable, not `DEFAULT '{}'`. `NULL` is the unambiguous signal for "no starter code
was requested" and is what the download button keys off of. Existing rows stay valid.

Shape stored in the column:

```jsonc
{
  "language": "python",
  "files": [
    { "path": "app/main.py",      "content": "# TODO: ..." },
    { "path": "requirements.txt", "content": "fastapi==0.115.0\nuvicorn==0.32.0\n" },
    { "path": "README.md",        "content": "..." }
  ]
}
```

**Design note:** a flat `files[]` array rather than a nested tree. Zip entries are flat paths anyway
(`app/main.py` creates the folder implicitly), so a tree would be structure with no payoff.

---

## 2. Server

### 2.0 Dependency

```bash
cd packages/server && bun add fflate
```

### 2.1 NEW — `packages/server/services/starterCode.service.ts`

```ts
import { ChatOpenAI } from '@langchain/openai';
import z from 'zod';
import type { SkillLevel, TargetEnvironment } from '../repositories/labGeneration.repository';
import type { LabContent } from './labGeneration.service';

const starterCodeSchema = z.object({
    language: z.string(),
    files: z.array(
        z.object({
            path: z.string(),
            content: z.string(),
        }),
    ),
})

export type StarterCode = z.infer<typeof starterCodeSchema>;

const llm = new ChatOpenAI({ model: 'gpt-4o', maxTokens: 3000 }).withStructuredOutput(starterCodeSchema)

// Model output becomes zip entry names. Reject anything that could escape the archive root
// or overwrite files outside it when the user unzips.
function isSafePath(path: string): boolean {
    return (
        path.length > 0 &&
        !path.startsWith('/') &&
        !path.includes('..') &&
        !path.includes('\\') &&
        !/^[a-zA-Z]:/.test(path)
    )
}

export const starterCodeService = {
    async generate(
        topicText: string,
        skillLevel: SkillLevel,
        environment: TargetEnvironment,
        labContent: LabContent,
    ): Promise<StarterCode> {
        const stepTitles = labContent.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')

        const result = await llm.invoke(
            `A learner is about to work through this hands-on lab:\n\n` +
            `Title: ${labContent.title}\n` +
            `Topic: ${topicText}\n` +
            `Steps:\n${stepTitles}\n\n` +
            `Generate a small starter-code project for them, targeting a ${skillLevel} skill level ` +
            `on ${environment}.\n\n` +
            `Rules:\n` +
            `- Choose the language and stack the lab actually uses.\n` +
            `- Write STUB files, not a finished solution. Every file should be heavily commented, ` +
            `with TODO comments describing what the learner must implement at each point.\n` +
            `- Always include a dependency manifest idiomatic to the language you chose ` +
            `(requirements.txt for Python, package.json for Node, go.mod for Go, Cargo.toml for Rust, etc.) ` +
            `listing every dependency the lab needs, with pinned versions. Omit it only if the stack ` +
            `genuinely has no dependencies.\n` +
            `- Always include a README.md with the exact install and run commands for ${environment}.\n` +
            `- Use relative paths only. No leading slash, no "..", no absolute paths.\n` +
            `- Keep it under 8 files.`,
        )

        return { ...result, files: result.files.filter((f) => isSafePath(f.path)) }
    },
}
```

**Design notes**
- Follows the existing one-agent-per-service pattern (`notes.service.ts`, `chat.service.ts`): a
  module-level `ChatOpenAI` with `.withStructuredOutput(zodSchema)`. No new abstraction.
- The prompt is fed the *generated lab's* title and step titles, not just the raw topic, so the
  scaffold matches the steps the learner will actually follow. This is why it runs **after** the lab
  agent, not in parallel.
- `maxTokens: 3000` (vs. 2000 for the lab) — file contents are verbose.
- `isSafePath` is not paranoia theatre: LLM output is untrusted input, and these strings become
  archive entry names. A `../../.ssh/authorized_keys` entry is a real zip-slip on extraction.
  Filtering (rather than throwing) means one bad path doesn't lose the whole scaffold.

### 2.2 MODIFIED — `packages/server/repositories/labGeneration.repository.ts`

```ts
import { supabase } from '../lib/supabase'

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';
export type TargetEnvironment = 'macos' | 'linux' | 'windows';

export type LabGenerationRow = {
    id: string;
    content: unknown;
}

export type StarterCodeRow = {
    topicText: string;
    starterCode: { language: string; files: { path: string; content: string }[] };
}

export const labGenerationRepository = {
    async create(
        topicText: string,
        skillLevel: SkillLevel,
        environment: TargetEnvironment,
        content: unknown,
        starterCode: unknown | null,          // <-- new
    ): Promise<LabGenerationRow> {
        const { data, error } = await supabase
            .from('lab_generations')
            .insert({
                topic_text: topicText,
                skill_level: skillLevel,
                environment,
                content,
                starter_code: starterCode,     // <-- new
            })
            .select('id, content')
            .single()

        if (error) throw new Error(`create failed: ${error.message}`)
        return data
    },

    // lab_generations has no user_id, so ownership is enforced by joining through
    // conversations (which does). !inner + the eq filter makes this a single query.
    async getStarterCode(labGenerationId: string, userId: string): Promise<StarterCodeRow | null> {
        const { data, error } = await supabase
            .from('lab_generations')
            .select('topic_text, starter_code, conversations!inner(user_id)')
            .eq('id', labGenerationId)
            .eq('conversations.user_id', userId)
            .maybeSingle()

        if (error) throw new Error(`getStarterCode failed: ${error.message}`)
        if (!data?.starter_code) return null

        return {
            topicText: data.topic_text,
            starterCode: data.starter_code as StarterCodeRow['starterCode'],
        }
    },
}
```

**Design note:** `getStarterCode` returns `null` for both "doesn't exist" and "not yours". The
controller turns both into a 404 — a distinct 403 would leak which lab IDs exist.

### 2.3 MODIFIED — `packages/server/services/labGeneration.service.ts`

Only `generate()` changes; `labContentSchema`, `LabContent`, `llm`, and `formatLabAsMarkdown` stay
exactly as they are. Add the import and replace the function body:

```ts
import { starterCodeService } from './starterCode.service';   // <-- new import

export const labGenerationService = {
    async generate(
        topicText: string,
        skillLevel: SkillLevel,
        environment: TargetEnvironment,
        conversationId: string,
        userId: string,
        starterCode: boolean,                                  // <-- new param
    ): Promise<{ id: string; content: LabContent }> {
        const labContent = await llm.invoke(
            `Write a hands-on, step-by-step lab for the topic "${topicText}", ` +
            `targeting a ${skillLevel} skill level, for a user working on ${environment}. ` +
            `Each step should have a title, a description, and optionally a shell code snippet to run.`,
        )

        // Starter code is best-effort: a failure here must not cost the user their lab.
        let starterCodeContent = null
        if (starterCode) {
            try {
                starterCodeContent = await starterCodeService.generate(
                    topicText, skillLevel, environment, labContent,
                )
            } catch (error) {
                console.error('[labs] starter code generation failed:', error)
            }
        }

        const created = await labGenerationRepository.create(
            topicText, skillLevel, environment, labContent, starterCodeContent,
        )

        await conversationRepository.ensureConversation(conversationId, userId, created.id)
        await conversationRepository.addMessages(conversationId, null, formatLabAsMarkdown(labContent))

        return { id: created.id, content: labContent }
    },
}
```

**Design note:** the response shape is unchanged. The client doesn't need to know the outcome — it
navigates to `/chat/:id`, and the download button is driven by what `GET .../messages` reports (2.6).
That keeps a page reload and a fresh generation on the same code path.

### 2.4 MODIFIED — `packages/server/controllers/labGeneration.controller.ts`

```ts
import z from 'zod';
import type { Request, Response } from 'express';
import { zipSync, strToU8 } from 'fflate';                                   // <-- new
import { labGenerationService } from '../services/labGeneration.service';
import { labGenerationRepository } from '../repositories/labGeneration.repository';  // <-- new

const generateSchema = z.object({
    topic: z
        .string()
        .trim()
        .min(1, { message: 'Topic cannot be empty' })
        .max(500, { message: 'Topic cannot exceed 500 characters' }),
    skillLevel: z.enum(['beginner', 'intermediate', 'advanced']),
    environment: z.enum(['macos', 'linux', 'windows']),
    conversationId: z.string().uuid(),
    starterCode: z.boolean().default(false),          // <-- new; default keeps old clients working
})

const paramsSchema = z.object({ id: z.string().uuid() })

function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'lab'
}

export const labGenerationController = {
    async generate(req: Request, res: Response) {
        const parseResult = generateSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        try {
            const { topic, skillLevel, environment, conversationId, starterCode } = parseResult.data;
            const result = await labGenerationService.generate(
                topic, skillLevel, environment, conversationId, req.user!.id, starterCode,
            )
            res.json(result)
        }
        catch (error) {
            console.error('[labs] error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    },

    async downloadStarterCode(req: Request, res: Response) {
        const parseResult = paramsSchema.safeParse(req.params);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        try {
            const row = await labGenerationRepository.getStarterCode(parseResult.data.id, req.user!.id)
            if (!row) {
                return res.status(404).json({ message: 'Starter code not found' })
            }

            const entries = Object.fromEntries(
                row.starterCode.files.map((file) => [file.path, strToU8(file.content)]),
            )
            const zipped = zipSync(entries, { level: 9 })

            res.setHeader('Content-Type', 'application/zip')
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${slugify(row.topicText)}-starter.zip"`,
            )
            res.send(Buffer.from(zipped))
        }
        catch (error) {
            console.error('[labs] starter code download error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    },
}
```

**Design notes**
- `zipSync` (not `zip`) — these archives are a handful of small text files; the async callback API
  buys nothing and complicates the handler.
- `slugify` guarantees the filename is header-safe. Topic text is free-form user input and could
  otherwise contain a quote or newline that breaks the `Content-Disposition` header.
- `.default(false)` on `starterCode` rather than requiring it — the field is genuinely optional and
  an old cached client bundle shouldn't start 400ing.

### 2.5 MODIFIED — `packages/server/routes.ts`

Add one line below the existing labs route:

```ts
router.get('/api/labs/:id/starter-code', requireAuth, labGenerationController.downloadStarterCode);
```

### 2.6 MODIFIED — `packages/server/repositories/conversation.repository.ts`

The chat view needs to know whether a download exists. Extend the **existing** `getMessages` call
rather than adding a second endpoint — `ChatBot` already makes this request on mount.

```ts
export type ConversationMessages = {
    messages: MessageRow[];
    starterCodeLabId: string | null;
}

    async getMessages(conversationId: string, userId: string): Promise<ConversationMessages | null> {
        const { data, error } = await supabase
            .from('conversations')
            .select('id, lab_generation_id, messages(role, content, created_at), lab_generations(starter_code)')
            .eq('id', conversationId)
            .eq('user_id', userId)
            .order('created_at', { referencedTable: 'messages', ascending: true })
            .maybeSingle()

        if (error) throw new Error(`getMessages failed: ${error.message}`)
        if (!data) return null

        const lab = data.lab_generations as { starter_code: unknown } | null

        return {
            messages: (data.messages as MessageRow[] | null) ?? [],
            // Only expose the id when there is actually something to download.
            starterCodeLabId: lab?.starter_code ? data.lab_generation_id : null,
        }
    },
```

> ⚠️ `lab_generations` is a to-one embed here, but supabase-js sometimes types it as an array
> depending on how it infers the relationship. If TypeScript complains, cast through
> `as unknown as { starter_code: unknown } | null` or take `[0]`. Verify the runtime shape once with
> a `console.log` before finalizing.

### 2.7 MODIFIED — `packages/server/controllers/conversation.controller.ts`

`getMessages` now spreads the repository result:

```ts
        try {
            const result = await conversationRepository.getMessages(parseResult.data.id, req.user!.id);
            if (!result) {
                return res.status(404).json({ message: 'Conversation not found' })
            }
            res.json(result)   // { messages, starterCodeLabId }
        }
```

**Design note:** `res.json(result)` keeps the existing `{ messages }` key intact, so `ChatBot`'s
current parsing keeps working; `starterCodeLabId` is purely additive.

---

## 3. Client

### 3.1 MODIFIED — `packages/client/src/components/lab/LabGeneratorForm.tsx`

**Schema** (line 11–21) — add the field:

```ts
const labGeneratorSchema = z.object({
  topic: z.string().trim().min(1, "Topic is required").max(500, "Topic cannot exceed 500 characters"),
  skillLevel: z.enum(["beginner", "intermediate", "advanced"], { message: "Select a skill level" }),
  environment: z.enum(["macos", "linux", "windows"]),
  starterCode: z.boolean(),                                   // <-- new
});
```

**Defaults** (line 50):

```ts
    defaultValues: { topic: "", environment: "macos", starterCode: false },
```

**Submit** (lines 57–73) — destructure and forward:

```ts
  const onSubmit = async ({
    topic,
    skillLevel,
    environment,
    starterCode,                                              // <-- new
  }: LabGeneratorFormData) => {
    setGenerating(true);
    setError(null);

    const conversationId = crypto.randomUUID();

    try {
      await api.post<LabResponse>("/api/labs/generate", {
        topic,
        skillLevel,
        environment,
        starterCode,                                          // <-- new
        conversationId,
      });
      reset();
      navigate(`/chat/${conversationId}`);
    } catch {
      setError("Something went wrong generating your lab. Please try again.");
    } finally {
      setGenerating(false);
    }
  };
```

**Markup** — insert directly after the closing `</div>` of the Target environment block (after
line 150, still inside the scrolling `flex flex-1 flex-col gap-6` container):

```tsx
        <div>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              {...register("starterCode")}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>
              <span className="text-sm font-semibold text-muted-foreground">
                Generate starter code
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground/70">
                Downloadable project scaffold with dependencies listed
              </span>
            </span>
          </label>
        </div>
```

**Design notes**
- Native `<input type="checkbox">` styled with Tailwind, matching how the *Target environment*
  `<select>` is done in this file. No new shadcn/base-ui primitive for one checkbox.
- `register()` on a single checkbox already yields a boolean, so no `setValue` dance like
  `skillLevel` needs.
- `reset()` on success restores `starterCode: false` from `defaultValues` for free.
- Wrapping in `<label>` makes the hint text clickable — better hit target than the 16px box.

### 3.2 MODIFIED — `packages/client/src/components/chat/ChatBot.tsx`

```tsx
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { ChatInput, type ChatFormData } from "./ChatInput";
import { api } from "@/lib/api";
import { ChatMessages, type Message } from "./ChatMessages";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "../ui/button";

type ChatResponse = {
  message: string;
};

type MessagesResponse = {
  messages: Message[];
  starterCodeLabId: string | null;
};

export const ChatBot = () => {
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [starterCodeLabId, setStarterCodeLabId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    api
      .get<MessagesResponse>(`/api/conversations/${conversationId}/messages`)
      .then(({ data }) => {
        setMessages(data.messages);
        setStarterCodeLabId(data.starterCodeLabId);
      })
      .catch(() => {
        setMessages([]);
        setStarterCodeLabId(null);
      });
  }, [conversationId]);

  const onDownload = async () => {
    if (!starterCodeLabId) return;
    setDownloading(true);
    setError(null);

    try {
      // Must go through `api` — the axios interceptor attaches the Supabase bearer
      // token. A plain <a href> would hit requireAuth and 401.
      const { data, headers } = await api.get<Blob>(
        `/api/labs/${starterCodeLabId}/starter-code`,
        { responseType: "blob" },
      );

      const match = /filename="(.+)"/.exec(
        String(headers["content-disposition"] ?? ""),
      );
      const url = URL.createObjectURL(data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "starter-code.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Something went wrong downloading your starter code.");
    } finally {
      setDownloading(false);
    }
  };

  const onSubmit = async ({ prompt }: ChatFormData) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      navigate("/login");
      return;
    }

    setError(null);
    setMessages((prev) => [...prev, { content: prompt, role: "user" }]);

    try {
      const { data } = await api.post<ChatResponse>("/api/chat", {
        prompt,
        conversationId,
      });

      setMessages((prev) => [...prev, { content: data.message, role: "ai" }]);
    } catch {
      setMessages((prev) => prev.slice(0, -1));
      setError("Something went wrong sending your message. Please try again.");
    }
  };

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
        Generate a lab to start a new conversation.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {starterCodeLabId && (
        <div className="flex shrink-0 justify-end border-b border-border pb-3">
          <Button
            type="button"
            variant="outline"
            onClick={onDownload}
            disabled={downloading}
            className="rounded-xl"
          >
            <Download className="size-4" />
            {downloading ? "Preparing…" : "Download starter code"}
          </Button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <ChatMessages messages={messages} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ChatInput onSubmit={onSubmit} />
    </div>
  );
};
```

**Design notes**
- The button lives **outside** the `overflow-y-auto` container with `shrink-0`, so it stays pinned
  while the lab scrolls.
- Rendered conditionally on `starterCodeLabId`, which comes from the database — so it appears after
  a fresh generation *and* after a page reload, with no extra state plumbing.
- Reuses the existing `error` state rather than adding a second one; both are transient inline
  messages in the same spot.
- `lucide-react` and the shadcn `Button` are already dependencies — nothing new on the client.

---

## Implementation order

1. Apply the migration → verify the column exists.
2. `bun add fflate` in `packages/server`.
3. Server: `starterCode.service.ts` → repository → service → controller → routes.
4. Server: conversation repository + controller (the `hasStarterCode` signal).
5. Client: `LabGeneratorForm` checkbox.
6. Client: `ChatBot` download button.

---

## Verification

1. Start both: `bun run dev` in `packages/server` and in `packages/client`.
2. **Column exists** — `mcp__supabase__execute_sql`:
   `select column_name from information_schema.columns where table_name = 'lab_generations';`
3. **Regression, box unchecked** — generate a lab with the checkbox off. Lab renders exactly as
   before, `starter_code` is `NULL` in the row, **no** download button.
4. **Happy path** — generate *"Build a FastAPI todo API"* with the box checked. Button appears above
   the thread. Click it, unzip, and confirm:
   - `requirements.txt` exists and lists the deps the lab's steps actually use;
   - `pip install -r requirements.txt` resolves;
   - source files are commented stubs with `TODO:`s, not a finished app;
   - `README.md` has install/run commands for the chosen environment.
5. **Language selection** — generate a Node/Express topic. Manifest must be `package.json`, not
   `requirements.txt`.
6. **Auth** — `curl` the download URL with no `Authorization` header → 401. With a *different*
   user's token → 404 (not 403, not 200).
7. **Persistence** — hard-reload `/chat/:conversationId`. Button is still there.
8. **Failure isolation** — temporarily throw at the top of `starterCodeService.generate`. The lab
   should still generate and render; only the button is absent.

## Follow-ups not in scope

- `lab_generations` (and every other table) still has **RLS disabled** while the anon key ships to
  the browser. This feature's ownership check happens in the repository layer, which is consistent
  with the rest of the codebase — but it's worth a separate pass.
- No size cap on generated files beyond `maxTokens` and the "under 8 files" prompt instruction.
