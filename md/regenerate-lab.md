# Regenerate a lab in place — implementation spec

> Written for you to implement by hand. No project files were changed.
> If you want this in the repo alongside `streaming-migration.md` / `starter-code.md` /
> `notes-feature.md`, copy it to `Feynman/regenerate-lab.md`.

---

## 1. Context

Today a lab is generated exactly once per conversation. `LabGeneratorForm` mints a client-side
`conversationId`, navigates to `/chat/:id` with the form values in router state, and `ChatBot`
streams `POST /api/labs/generate`. If the result isn't what the user wanted, their only recourse is
"New chat" — which loses the window and leaves a dead conversation in the sidebar.

**Goal:** a Regenerate affordance on an existing lab that prefills the generator form with the
original inputs, lets the user edit them, and replaces the lab **in the same `conversation_id`**,
wiping the prior chat and notes so the window reads as one lab, not two.

---

## 2. Architectural decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Prefill the form for editing**, not a blind reroll | "Not what I wanted" almost always means the *prompt* needs changing. A same-prompt reroll of `gpt-4o` produces a similar lab and wouldn't fix the user's problem. Params are fully recoverable from the `lab_generations` row. |
| D2 | **Same `conversation_id`; wipe `messages` + `notes`** | Matches the "replaces in the same window" intent. Appending instead would stack two labs in one thread and pin the sidebar title (derived from the conversation's *first* message) to the dead lab forever. |
| D3 | **Leave the superseded `lab_generations` row orphaned** | Deleting it risks FK trouble and destroys all record. Orphaning is free and self-cleaning in the way that matters: `getStarterCode` gates on `conversations!inner(user_id)`, so once the conversation repoints away, the old zip is automatically unreachable. |
| D4 | **Reuse `POST /api/labs/generate` with a `regenerate` flag** — no new route | The whole generate → persist pipeline is identical; only the persistence tail branches. A second endpoint would duplicate the SSE plumbing and the abort handling. |
| D5 | **Wipe *after* the new lab row is created**, not before | The existing service is already all-or-nothing at the end of the stream. Putting the destructive step after `labGenerationRepository.create` means a failed, aborted, or disconnected generation can never destroy the old lab. This falls out for free — don't reorganize it. |
| D6 | **New `replaceLab` method, don't touch `ensureConversation`** | `ensureConversation` upserts with `ignoreDuplicates: true` and so cannot update `lab_generation_id` on an existing row. Making it update-on-conflict would silently change fresh-lab behaviour. |
| D7 | **Widen `getMessages` rather than add a params endpoint** | The client already refetches `/api/conversations/:id/messages` on load and on `lab-done`. Three extra columns on an existing join beats a new route + a new client fetch. |
| D8 | **Prefill state lifted to `HomePage`, plain `useState`** | `LabGeneratorForm` and `ChatBot` are siblings. There is no React Query / store anywhere in this codebase; two props match the existing style. |
| D9 | **Force a `ChatBot` remount via a `runId` in its `key`** | Regenerate navigates to the *same* `/chat/:id`, so `key={conversationId}` would not remount and `ChatBot` would keep stale `messages` / `starterCodeLabId` / `labParams`. Folding a per-run nonce into the key gives regeneration the exact same clean-component semantics a fresh lab already has. |
| D10 | **Inline confirm, not a modal** | `components/ui/` contains only `button.tsx` and `textarea.tsx`. Pulling `@radix-ui/react-alert-dialog` in for one prompt isn't worth the dependency. |
| D11 | **Fix the reload-duplicates-a-lab bug as part of this change** | It's pre-existing, but regenerate turns it from "you get a spare lab" into "reloading the page wipes your chat". Not optional. |

---

## 3. Server

### 3.1 `packages/server/repositories/conversation.repository.ts`

Add the import for the enum types at the top:

```ts
import type { SkillLevel, TargetEnvironment } from './labGeneration.repository'
```

**Widen the return type:**

```ts
export type LabParams = {
    topic: string;
    skillLevel: SkillLevel;
    environment: TargetEnvironment;
    starterCode: boolean;
}

export type ConversationMessages = {
    messages: MessageRow[];
    starterCodeLabId: string | null;
    labParams: LabParams | null;
}
```

**Rewrite `getMessages`** — only the select list and the return object change:

```ts
async getMessages(conversationId: string, userId: string): Promise<ConversationMessages | null> {
    const { data, error } = await supabase
        .from('conversations')
        .select('id, lab_generation_id, messages(role, content, created_at), lab_generations(topic_text, skill_level, environment, starter_code)')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .order('created_at', { referencedTable: 'messages', ascending: true })
        .maybeSingle()

    if (error) throw new Error(`getMessages failed: ${error.message}`)
    if (!data) return null

    const lab = data.lab_generations as unknown as {
        topic_text: string
        skill_level: SkillLevel
        environment: TargetEnvironment
        starter_code: unknown
    } | null

    return {
        messages: (data.messages as MessageRow[] | null) ?? [],
        // Only expose the id when there is actually something to download.
        starterCodeLabId: lab?.starter_code ? data.lab_generation_id : null,
        // Original inputs, so the client can prefill the generator form on regenerate.
        labParams: lab
            ? {
                topic: lab.topic_text,
                skillLevel: lab.skill_level,
                environment: lab.environment,
                starterCode: Boolean(lab.starter_code),
            }
            : null,
    }
}
```

> **Keep the `.select()` on one line as a single string literal.** Supabase infers the result shape
> from the *literal type* of that string. Split it with `'...' + '...'` and the type widens to
> `string`, the PostgREST type parser gives up, and you get
> `Property 'lab_generations' does not exist on type 'GenericStringError'`. A backtick template
> literal works too, but only with no interpolation and no newlines.

**Add `replaceLab`** next to `ensureConversation`:

```ts
// Repoint an existing conversation at a freshly generated lab and clear the old
// thread. The `user_id` filter is the only authorization gate — RLS is disabled
// on every table, so a missing row here means "not yours" and must throw.
async replaceLab(conversationId: string, userId: string, labGenerationId: string): Promise<void> {
    const { data, error } = await supabase
        .from('conversations')
        .update({ lab_generation_id: labGenerationId })
        .eq('id', conversationId)
        .eq('user_id', userId)
        .select('id')
        .maybeSingle()

    if (error) throw new Error(`replaceLab failed: ${error.message}`)
    if (!data) throw new Error('replaceLab failed: conversation not found')

    const { error: deleteError } = await supabase
        .from('messages')
        .delete()
        .eq('conversation_id', conversationId)

    if (deleteError) throw new Error(`replaceLab failed: ${deleteError.message}`)
},
```

### 3.2 `packages/server/repositories/notes.repository.ts`

```ts
async deleteByConversation(conversationId: string, userId: string): Promise<void> {
    const { error } = await supabase
        .from('notes')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)

    if (error) throw new Error(`deleteByConversation failed: ${error.message}`)
}
```

Scoped by both columns — `conversation_id` alone would be an unauthenticated delete primitive.

### 3.3 `packages/server/controllers/labGeneration.controller.ts`

Add to `generateSchema`:

```ts
regenerate: z.boolean().default(false),
```

Destructure it and pass it through:

```ts
const { topic, skillLevel, environment, conversationId, starterCode, regenerate } = parseResult.data;
...
for await (const event of labGenerationService.generate(
    topic, skillLevel, environment, conversationId, req.user!.id, starterCode, regenerate, controller.signal,
)) {
```

### 3.4 `packages/server/services/labGeneration.service.ts`

Add the import:

```ts
import { notesRepository } from '../repositories/notes.repository';
```

New parameter in the signature, inserted before `abortSignal`:

```ts
starterCode: boolean,
regenerate: boolean,
abortSignal: AbortSignal,
```

Replace the persistence tail (the block starting at `const labGeneration = await labGenerationRepository.create(...)`):

```ts
const labGeneration = await labGenerationRepository.create(
    topicText,
    skillLevel,
    environment,
    labContent,
    starterCodeContent)

// Destructive work runs only once the replacement lab exists, so an aborted or
// failed generation can never destroy what the user already had.
if (regenerate) {
    await conversationRepository.replaceLab(conversationId, userId, labGeneration.id)
    await notesRepository.deleteByConversation(conversationId, userId)
} else {
    await conversationRepository.ensureConversation(conversationId, userId, labGeneration.id)
}

await conversationRepository.addMessages(conversationId, null, formatLabAsMarkdown(labContent))

yield {type: 'lab-done', labGenerationId: labGeneration.id};
```

### 3.5 Migration — drop the uniqueness constraint

No new columns are needed, but one constraint has to go:

```sql
alter table public.lab_generations
  drop constraint lab_generations_topic_skill_env_key;   -- UNIQUE (topic_text, skill_level, environment)
```
Applied as `drop_lab_generations_topic_skill_env_unique`.

`labGenerationRepository.create` always inserts and no cache-lookup path exists anywhere in the
codebase, so this constraint never deduplicated anything — it only made the *second* generation of a
given triple fail. That was already breaking `main`: generating the same topic/skill/environment
twice threw `duplicate key value violates unique constraint`, and because the constraint is global
rather than per-user, one user claiming a topic locked out everyone else.

It's also incompatible with this feature by definition: regenerating produces a second row for the
same inputs, which is exactly what the constraint forbids — and it bites hardest in the case that
matters most, where the user changes nothing and just wants another attempt.

It appears to be a leftover from the caching design in `implementation-plan.md` (cache key
`(topic, skill_level)`), where it would have backed a reuse lookup that was never built. Reviving
that idea would mean identical inputs returning the identical stored lab, which cannot coexist with
regeneration.

**One-way in practice:** re-adding the constraint later requires deduplicating existing rows first.

---

## 4. Client

> Every block in this section carries the reason it exists. Where a line is non-obvious or looks
> like it could be simplified, the note says what breaks if you simplify it.

### 4.1 `packages/client/src/components/lab/LabGeneratorForm.tsx`

```tsx
export type Prefill = {
  values: LabGeneratorFormData;
  conversationId: string;
};
```
Exported so `HomePage` and `ChatBot` share one definition. `conversationId` travels *with* the values
because it's what makes this a replace rather than a new lab — bundling them makes it impossible to
set one without the other.

```tsx
type Props = {
  prefill: Prefill | null;
  onSubmitted: () => void;
};

export const LabGeneratorForm = ({ prefill, onSubmitted }: Props) => {
```
The form takes no props today. `onSubmitted` is needed because the prefill lives in `HomePage` but
only the form knows when it's been consumed; without it a stale prefill would keep aiming later
submissions at the old conversation.

```tsx
  useEffect(() => {
    if (prefill) reset(prefill.values);
  }, [prefill, reset]);
```
- `register(...)` makes these inputs **uncontrolled** — their values live inside react-hook-form, not
  in React state, so you cannot fill them by passing props. `reset()` is the imperative way in.
- An effect rather than `defaultValues`, because the form is already mounted by the time the user
  clicks Regenerate and `defaultValues` only applies on first render.
- `HomePage` builds a fresh object on each click, so the reference changes and this re-runs even when
  the values are identical — deliberately discarding edits from a previous, abandoned Regenerate.
- `reset` in the deps satisfies the linter and costs nothing: react-hook-form's reference is stable.
- Side benefit: `reset()` also clears dirty/error state and recomputes `isValid`, so the submit button
  comes back enabled instead of staying greyed out.

```tsx
  const onSubmit = (data: LabGeneratorFormData) => {
    const conversationId = prefill?.conversationId ?? crypto.randomUUID();
    const regenerate = Boolean(prefill);
    reset();
    onSubmitted();
    navigate(`/chat/${conversationId}`, {
      state: { labData: data, regenerate, runId: crypto.randomUUID() },
    });
  };
```
- **`prefill?.conversationId ?? crypto.randomUUID()`** — the single line that makes regeneration land
  in the same window. Mint a new id here and you get a second conversation in the sidebar instead.
- **`Boolean(prefill)`** — the presence of a prefill *is* the regenerate signal, so there's no second
  flag that can fall out of sync with it.
- **`onSubmitted()` before `navigate`** — clears the prefill so the next plain submit mints a fresh id.
- **`runId: crypto.randomUUID()`** — the remount nonce (D9). Regenerate navigates to a URL that hasn't
  changed, so without this React keeps the old `ChatBot` instance and its stale state.

Add `useEffect` to the react import. Optional one-liner: make the submit button read
`{prefill ? "Regenerate" : "Generate"}`.

### 4.2 `packages/client/src/pages/HomePage.tsx`

```tsx
  const location = useLocation();
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [runId, setRunId] = useState("");
```
`HomePage` is the nearest common ancestor of the form and the chat, which cannot talk to each other
directly. This is the bridge, and the smallest one that works — no store, matching the codebase.
`useLocation` is new here; it's how the `runId` arrives.

```tsx
  const stateRunId = (location.state as { runId?: string } | null)?.runId;
  if (stateRunId && stateRunId !== runId) setRunId(stateRunId);
```
**The `stateRunId &&` guard is the entire point.** `ChatBot` clears `location.state` on mount (§4.4).
Read the runId live —

```tsx
key={`${conversationId}:${location.state?.runId ?? ""}`}   // ✗ breaks generation
```

— and that clearing flips the key back, React tears down the `ChatBot` that just started streaming,
its cleanup fires `controller.abort()`, and the replacement mounts with no `labData` to restart from.
Generation dies milliseconds after it begins, every time. Copying into state and ignoring `undefined`
makes the key immune to the clearing.

**Why adjusted during render, not in an effect.** This is React's documented "adjusting state when
props change" pattern. An effect would work but has two costs: the project's lint config rejects a
synchronous `setState` in an effect body (*"Calling setState synchronously within an effect can
trigger cascading renders"*), and it would split the update across two commits — one render with the
stale key, then a second with the new one. Adjusting during render lands the new key in the same
commit that receives the navigation.

```tsx
  const activePrefill =
    prefill?.conversationId === conversationId ? prefill : null;
```
A prefill only applies to the conversation it was raised from. Without this check: the user clicks
Regenerate in conversation A (form fills with A's topic), then clicks conversation B in the sidebar
without submitting. The form still holds A's `conversationId`, so hitting Generate replaces **A** —
a lab they aren't even looking at — and bounces them back to `/chat/A`.

Deriving it beats clearing it in an effect: no cascading render, and returning to A restores the
pending prefill instead of silently losing it.

```tsx
    <LabGeneratorForm prefill={activePrefill} onSubmitted={() => setPrefill(null)} />
    <ChatBot key={`${conversationId}:${runId}`} onRegenerate={setPrefill} />
```
`key` gains the `runId` half so a same-URL regenerate still produces a fresh component (D9).
`onRegenerate={setPrefill}` passes the setter directly — no wrapper, since `ChatBot` assembles the
whole `Prefill` object itself.

### 4.3 `packages/client/src/components/chat/ChatBot.tsx` — state and data

```tsx
type LabParams = {
  topic: string;
  skillLevel: LabGeneratorFormData["skillLevel"];
  environment: LabGeneratorFormData["environment"];
  starterCode: boolean;
};

type MessagesResponse = {
  messages: Message[];
  starterCodeLabId: string | null;
  labParams: LabParams | null;
};
```
Mirrors the widened server response (§3.1). Derived from `LabGeneratorFormData` rather than retyped,
so the form schema stays the single source of truth for the enums.

```tsx
type Props = {
  onRegenerate: (prefill: Prefill) => void;
};

export const ChatBot = ({ onRegenerate }: Props) => {
  const [labParams, setLabParams] = useState<LabParams | null>(null);
  const [confirming, setConfirming] = useState(false);
```
- `ChatBot` takes no props today; `onRegenerate` is the channel up to `HomePage`.
- `labParams` does double duty — it holds the values to prefill *and*, being non-null only when a lab
  exists, serves as the "show the Regenerate button" condition. No separate flag.
- `confirming` stays local: it's one component's transient UI state, gone the moment you navigate.

```tsx
setMessages(data.messages);
setStarterCodeLabId(data.starterCodeLabId);
setLabParams(data.labParams);      // ← added
```
Add this everywhere `starterCodeLabId` is already set — the initial-load effect **and** the `lab-done`
refetch. Miss the second one and Regenerate stays hidden until the user reloads the page.

```tsx
body: JSON.stringify({ ...labData, conversationId, regenerate }),
```
`regenerate` is what selects the destructive branch server-side. Omit it and the server takes the
`ensureConversation` path, which silently no-ops on an existing row — you'd get an orphaned lab, a
404ing download, and the notes agent still pointed at the old lab.

### 4.4 `ChatBot` — the reload guard (D11)

**The bug being fixed.** `navigate(..., { state })` doesn't store data in React — React Router hands
it to the History API, so it rides on the history entry alongside the URL and survives reloads.
`ChatBot` treats the presence of `labData` as "go generate a lab". Reload `/chat/abc` and the browser
restores the entry, `labData` reappears, and generation fires again. Today that's a duplicate lab;
with `regenerate: true` also restored, **every reload wipes the conversation.**

Replace the `const labData = location.state?.labData` line with:

```tsx
const [labData] = useState(
  () => location.state?.labData as LabGeneratorFormData | undefined,
);
const [regenerate] = useState(() => Boolean(location.state?.regenerate));
```
- The `useState` initializer runs **once per component instance**, copying the value into component
  state where erasing history can't reach it.
- It also makes `labData` a **stable reference**, which matters twice over: the generate effect's
  `[labData, conversationId]` deps can no longer re-fire, and its cleanup can no longer abort a live
  stream. A plain `location.state?.labData` read would produce a new object identity on every router
  update.

```tsx
useEffect(() => {
  if (location.state) navigate(location.pathname, { replace: true, state: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```
- **`state: null`** — erases the payload so a reload finds nothing and the generate effect returns
  early.
- **`replace: true`** — rewrites the current history entry instead of pushing a new one, so the back
  button still behaves.
- **`[]` deps** — runs once, at mount. Add `location.state` and it would re-run in response to its own
  clearing. The eslint suppression is deliberate for that reason.
- **`if (location.state)`** — skips a pointless navigate when loading an ordinary conversation.
- **Order is load-bearing:** `useState` initializers run during render, effects run after, so the copy
  is always taken before the erase.

> **The hazard this pairs with.** Clearing `location.state` re-renders `HomePage`. If `HomePage`
> read `runId` straight off `location.state`, the key would collapse back to `${conversationId}:`,
> remounting `ChatBot` *without* `labData` and aborting the in-flight generation. The sticky
> `runId` state in §4.2 is what prevents that — don't "simplify" it into a direct read.

Full sequence, regenerating in conversation `abc` with old runId `r1` and new `r2`:

| # | What happens | Key |
|---|---|---|
| 1 | Form submits → `navigate` with `runId: r2` | `abc:r1` |
| 2 | `HomePage` renders; the render-time adjustment sets `runId = r2` | `abc:r2` |
| 3 | Key changed → old `ChatBot` unmounts (idle, nothing to abort), new one mounts | `abc:r2` |
| 4 | New instance's `useState` reads `location.state` → gets `labData` ✓ | `abc:r2` |
| 5 | Its mount effect erases `location.state` | `abc:r2` |
| 6 | `stateRunId` is now `undefined`, guard skips — **key holds** | `abc:r2` |
| 7 | Generate effect runs with the frozen copy, streams to completion | `abc:r2` |

**Caveat:** between steps 1 and 5 there's a few-millisecond window where a reload would still replay.
Not worth engineering around.

### 4.5 `ChatBot` — regenerate handler

```tsx
const onRegenerateClick = () => {
  if (!labParams || !conversationId) return;
  if (messages.length > 1 && !confirming) {
    setConfirming(true);
    return;
  }
  setConfirming(false);
  onRegenerate({ values: labParams, conversationId });
};
```
- **Clicking does not generate anything.** It hands the params up so the form fills in; the user then
  edits and submits, and *that* submit starts generation (D1).
- **`messages.length > 1`** — a lab nobody has discussed is just the one `ai` message, so there's
  nothing to lose and the prompt would be pure friction. Confirm only when there's real chat history.
- **`&& !confirming`** — the same handler serves both clicks: the first arms the prompt, the second
  (from the "Replace" button) falls through and proceeds. One function, no duplicated logic.
- **`!labParams` guard** — defensive; the button can't render without it, but it also narrows the type
  so `labParams` is non-null at the call.

### 4.6 `ChatBot` — header row

Consolidate the two existing bordered rows (Download / Stop) into one, otherwise Regenerate makes a
third stacked bar. This is a deliberate merge of adjacent markup, not a drive-by refactor:

```tsx
{confirming ? (
  <div className="flex shrink-0 items-center gap-2 border-b border-border pb-3">
    <p className="mr-auto text-sm text-muted-foreground">
      Replacing this lab clears this chat and its notes.
    </p>
    <Button type="button" variant="outline" onClick={() => setConfirming(false)} className="rounded-xl">
      Cancel
    </Button>
    <Button type="button" onClick={onRegenerateClick} className="rounded-xl">
      Replace
    </Button>
  </div>
) : (
  (starterCodeLabId || labParams || phase !== "idle") && (
    <div className="flex shrink-0 justify-end gap-2 border-b border-border pb-3">
      {starterCodeLabId && (
        <Button type="button" variant="outline" onClick={onDownload} disabled={downloading} className="rounded-xl">
          <Download className="size-4" />
          {downloading ? "Preparing…" : "Download starter code"}
        </Button>
      )}
      {labParams && phase === "idle" && (
        <Button type="button" variant="outline" onClick={onRegenerateClick} className="rounded-xl">
          <RotateCcw className="size-4" />
          Regenerate
        </Button>
      )}
      {phase !== "idle" && (
        <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()} className="rounded-xl">
          Stop
        </Button>
      )}
    </div>
  )
)}
```

- **`confirming ?` wraps the whole row** — the prompt replaces the buttons in place rather than
  appearing above them, so nothing below reflows when it opens.
- **`(starterCodeLabId || labParams || phase !== "idle") &&`** — without this guard you'd render an
  empty bordered strip on a conversation that has no lab yet.
- **`labParams &&` on Regenerate** — hides the button until a lab exists to regenerate.
- **`phase === "idle"` on Regenerate** — prevents starting a second generation while one is streaming.
  The user must Stop first. Note this is also why Regenerate and Stop never appear together.
- **`type="button"`** on every button — these don't sit inside a `<form>` today, but the attribute is
  free insurance against a future wrapper submitting the page, and it matches the existing buttons.
- Add `RotateCcw` to the `lucide-react` import.

---

## 5. Accepted gaps

- **Stale sidebar title.** `ConversationSidebar` refetches only on `conversationId` change, which
  doesn't change on regenerate. Its title (the conversation's first message) stays stale until the
  user navigates, then self-heals. Not worth prop-drilling a refresh signal.
- **Late note race.** `chatService.sendMessage` fires `notesService.extractAndSave` fire-and-forget.
  A note still in flight when the wipe lands will survive, carrying the *old* `lab_generation_id`,
  and show on `/notes` under a duplicate heading. Narrow window; ignoring it.
- **Orphaned `lab_generations` rows accumulate.** By design (D3). If it ever matters, a periodic
  sweep of rows with no referencing conversation is the cleanup.

---

## 6. Verification

1. `bun run dev` in `packages/server` and `packages/client`.
2. **Fresh lab unchanged** — generate a lab; streaming, persisted markdown, and starter-code
   download all behave as before.
3. **Regenerate happy path** — send two chat messages about the lab, click Regenerate, confirm,
   edit the topic in the prefilled form, submit. Expect: same URL and `conversationId`, chat
   cleared, new lab streams in, exactly one lab message afterwards.
4. **DB check** (`mcp__supabase__execute_sql`) for that `conversation_id`: `lab_generation_id`
   points at the new row; `messages` holds one `ai` row; its `notes` are gone; the old
   `lab_generations` row still exists and is unreferenced.
5. **Starter code** — regenerate with the checkbox on, download, confirm the zip matches the new
   lab; regenerate with it off and confirm the download button disappears. Then confirm the *old*
   lab id 404s on `/api/labs/:id/starter-code`.
6. **Reload guard** — reload `/chat/:id` right after a generation completes. No second lab, nothing
   wiped.
7. **Failure safety** — regenerate and hit Stop mid-stream; reload. Previous lab and chat intact.
8. **Ownership** — `POST /api/labs/generate` with `regenerate: true` and another user's
   `conversationId`; expect the in-band error event and their conversation untouched.
