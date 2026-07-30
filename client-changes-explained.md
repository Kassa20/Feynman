# The client-side regenerate changes, explained from scratch

This assumes you know very little about how the pieces fit together. It builds up the concepts
first, then walks the code. Companion to `regenerate-lab.md`, which is the terse version.

---

## 1. What we're building

Right now a lab is generated once and that's it. If the AI gives you something you didn't want, your
only option is "New chat" — you lose the window and get a dead conversation left in the sidebar.

We want a **Regenerate** button that:

1. Takes the settings the lab was originally made with (topic, skill level, environment, starter-code
   checkbox).
2. Drops them back into the form on the left so you can *edit* them — usually the topic wording was
   the problem.
3. When you submit, replaces the lab **in the same window**: same URL, same conversation, old chat
   and old notes wiped, new lab in their place.

Three files change: the form, the chat, and the page that holds them both.

---

## 2. The shape of the screen

```
┌───────────┬────────────────────┬─────────────────────────────┐
│           │                    │                             │
│  sidebar  │  LabGeneratorForm  │         ChatBot             │
│           │  (the form)        │  (the lab + conversation)   │
│           │                    │                             │
└───────────┴────────────────────┴─────────────────────────────┘
                    └──────── both live inside HomePage ────────┘
```

**This layout is the source of most of the complexity.**

The Regenerate button lives in `ChatBot` — that's where you're looking when you decide you don't like
the lab. But the settings need to end up in `LabGeneratorForm`, which is a completely separate
component sitting next to it.

In React, components can only pass data **downward**, to their own children. `ChatBot` and
`LabGeneratorForm` are siblings. Neither is the other's parent, so neither can hand the other
anything.

> **Analogy.** Two kids in separate bedrooms. They can't pass notes through the wall. But both can
> talk to the parent in the hallway. So the note goes: kid A → parent → kid B.

`HomePage` is the parent in the hallway. That's why it gains new state it doesn't obviously need:
it's holding the note in transit.

---

## 3. Four concepts you need before the code makes sense

### 3.1 State, and why the form can't just be handed values

Most React data flows down as "props" — a parent gives a child a value, the child displays it.

But this form doesn't work that way. It uses a library called react-hook-form, and its inputs are
**uncontrolled**. That means the text you type doesn't live in React at all — it lives inside the
library's own private storage.

> **Analogy.** Imagine the form keeps its answers in a locked filing cabinet in the corner. You can't
> change what's in the cabinet by shouting new values at the room. You have to hand the cabinet a new
> folder and say "replace everything with this." That command is called `reset()`.

So filling the form from outside isn't a matter of passing a prop. We pass the values down, and then
separately *tell* the form to load them:

```tsx
useEffect(() => {
  if (prefill) reset(prefill.values);
}, [prefill, reset]);
```

`useEffect` means "run this code after rendering, whenever the listed things change." Here: whenever
a new `prefill` shows up, load it into the cabinet.

You might ask why we don't just set the form's starting values. Because the form is *already on
screen* by the time you click Regenerate. Starting values only apply the very first time a component
appears. This form appeared when you loaded the page, long before you clicked anything.

### 3.2 `key`, and how React decides a component is "the same one"

This is the concept that trips people up most, and it's central to what's going on here.

When React re-renders, it needs to decide: is this the *same* `ChatBot` as before (keep everything it
remembers — the messages, the scroll position), or is it a *different* `ChatBot` (throw all that away
and start clean)?

It decides using the `key`.

- **Same key as last time** → same component. It keeps all its memory.
- **Different key** → React destroys the old one entirely and builds a brand-new one that remembers
  nothing.

> **Analogy.** Think of the key as an employee badge number. If the badge number is unchanged, it's
> the same employee — they still remember everything about the job. If the badge number changes,
> that person is let go and a new hire walks in who knows nothing and starts fresh.

The code already used this:

```tsx
<ChatBot key={conversationId} />
```

Conversation id changes when you click a different conversation → different key → fresh `ChatBot`.
That's why switching conversations doesn't leave the previous conversation's messages on screen.

**Here's the problem for us.** Regenerating deliberately stays in the *same* conversation. Same
conversation id. So the key wouldn't change, React would keep the existing `ChatBot`, and it would
still be holding the old lab's messages, the old settings, and the old starter-code download link.
You'd watch the new lab stream in underneath the old one.

The fix is to add a random value to the key that changes on every generation:

```tsx
<ChatBot key={`${conversationId}:${runId}`} />
```

`runId` is a fresh random id created each time you submit the form. So the key goes from `abc:r1` to
`abc:r2` — different badge number, new hire, clean slate. Same conversation, fresh component.

### 3.3 `location.state`, and why reloading the page was dangerous

When you submit the form, it does this:

```tsx
navigate(`/chat/${conversationId}`, { state: { labData, regenerate, runId } });
```

It changes the URL *and* attaches a little bundle of data to the navigation. `ChatBot` reads that
bundle and thinks: "there's lab settings here, so I've just been sent from the form — time to
generate."

The catch is **where that bundle is stored**. It isn't a React variable. React Router hands it to the
browser, which stores it on the history entry — the same record that holds the URL.

> **Analogy.** Picture the browser's history as a book, one page per place you've visited. The URL is
> written on the page. `location.state` is a sticky note attached to that same page. Close the book
> and reopen it later and the sticky note is still there.

That means it **survives a page reload**. So:

1. You reload `/chat/abc`.
2. The browser reopens that history page — sticky note and all.
3. `ChatBot` reads the sticky note, sees lab settings, and concludes it was just sent from the form.
4. It generates all over again.

This bug already exists today. Reloading after generating quietly makes you a second, duplicate lab.
Nobody noticed because a spare lab is harmless.

**But it stops being harmless.** Once the sticky note also says `regenerate: true`, that same reload
tells the server to wipe the conversation first. Every reload would destroy your chat and notes.

So the fix has two steps:

```tsx
// 1. Copy the sticky note's contents into this component's own memory.
const [labData] = useState(() => location.state?.labData);

// 2. Then peel the sticky note off the history page.
useEffect(() => {
  if (location.state) navigate(location.pathname, { replace: true, state: null });
}, []);
```

Copy first, then erase. The component still knows what to generate, because it took a photocopy. But
the history page is now blank, so reloading finds nothing and does nothing.

`useState(() => ...)` is the "take a photocopy" part — that function runs exactly once, when the
component is born, and never again. `replace: true` means "rewrite this history page" rather than
"add a new one," so the back button still behaves normally.

### 3.4 Why the copy also has to be *stable*

There's a second, subtler reason for the photocopy.

The generation code is wrapped in a `useEffect` that watches `labData`. React compares the value each
render: if it looks like a new one, the effect re-runs — and its cleanup fires first, which **aborts
the in-flight network request**.

The trap is that React compares objects by identity, not by contents. Two objects with identical
contents still count as different.

> **Analogy.** Two photocopies of the same page have the same words on them, but they're still two
> separate sheets of paper. React is checking "is this literally the same sheet I saw last time?",
> not "does it say the same thing?"

Reading `location.state?.labData` fresh on every render can hand back a different sheet each time.
React sees "new value," restarts the effect, and kills the request that was mid-stream. Taking one
photocopy and holding onto it means it's the same sheet forever, so the effect stays put.

---

## 4. The changes, file by file

### 4.1 `LabGeneratorForm.tsx` — the form

**It now accepts two things from its parent:**

```tsx
type Props = {
  prefill: Prefill | null;      // settings to load in, or null for a blank form
  onSubmitted: () => void;      // "I've used the prefill, you can throw it away"
};
```

`Prefill` bundles the settings together with the conversation they came from:

```tsx
export type Prefill = {
  values: LabGeneratorFormData;   // topic, skill level, environment, starter code
  conversationId: string;         // which conversation to replace
};
```

They travel together on purpose. The conversation id is what makes this a *replacement* rather than a
new lab, so keeping them in one object makes it impossible to accidentally set one without the other.

**It fills itself in when a prefill arrives** — the `reset()` effect from §3.1.

Worth noting: a *new object* arrives each time you click Regenerate, even if the settings are
identical. React notices the new object and re-runs the effect, which wipes out any half-finished
edits from a previous Regenerate you abandoned. That's intentional — clicking Regenerate should give
you a clean copy of the original settings, not your leftovers.

**The submit handler is where the real decision happens:**

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

Line by line:

- `prefill?.conversationId ?? crypto.randomUUID()` reads as: "use the prefill's conversation id if
  there is one, otherwise invent a brand-new id." **This single line is what keeps a regeneration in
  the same window.** Invent a new id here and you'd get a second conversation in the sidebar instead
  of replacing the one you're looking at.
- `Boolean(prefill)` — if there's a prefill, this is a regeneration. We don't track that separately;
  the presence of the prefill *is* the signal, so there's no second flag to keep in sync.
- `onSubmitted()` tells the parent to throw the prefill away now that it's been used. Without it the
  form would stay stuck in "replace that conversation" mode forever — your *next* Generate, meant to
  be a fresh lab, would overwrite the same conversation again.
- `runId: crypto.randomUUID()` is the fresh badge number from §3.2.

**The button text** now reads "Regenerate" instead of "Generate" when a prefill is loaded, so it's
clear what's about to happen.

### 4.2 `HomePage.tsx` — the parent in the hallway

Two pieces of state:

```tsx
const [prefill, setPrefill] = useState<Prefill | null>(null);
const [runId, setRunId] = useState("");
```

`prefill` is the note being passed from chat to form. `runId` is the badge number.

**Catching the runId:**

```tsx
const stateRunId = (location.state as { runId?: string } | null)?.runId;
if (stateRunId && stateRunId !== runId) setRunId(stateRunId);
```

This looks odd, so here's what it's doing and why it can't be simpler.

`runId` arrives on that sticky note (§3.3) — and `ChatBot` peels the sticky note off as soon as it
starts up. If `HomePage` read the runId directly off the note:

```tsx
key={`${conversationId}:${location.state?.runId ?? ""}`}   // ✗ this breaks everything
```

then the moment `ChatBot` peels the note off, the runId vanishes, the key changes back, and React
fires the `ChatBot` that just started generating. Its cleanup aborts the request. The replacement
starts up with no settings (you just erased them), so it doesn't restart. **Generation would die
milliseconds after it began, every single time.**

So `HomePage` copies the runId into its own memory and only ever accepts a *real* value. That's what
`if (stateRunId && ...)` does — an empty note is ignored. Once it has `r2`, it keeps `r2`, no matter
what happens to the sticky note.

> **Analogy.** You write the badge number down in your own notebook the moment you see it. Later
> someone erases the whiteboard it was written on — doesn't matter, you have it in your notebook.

Why the check sits in the middle of the render rather than in a `useEffect`: this is React's official
pattern for "update state when your inputs change." Doing it in an effect would mean rendering once
with the *old* key and then again with the new one — a wasted round trip — and the project's linter
rejects it outright with *"Calling setState synchronously within an effect can trigger cascading
renders."* Doing it during render means the correct key is used immediately.

**Filtering the prefill:**

```tsx
const activePrefill = prefill?.conversationId === conversationId ? prefill : null;
```

Read as: "only use this prefill if it belongs to the conversation we're actually looking at."

Here's the disaster it prevents:

1. You're in conversation **A**. You click Regenerate. The form fills with A's topic.
2. You don't submit — you're still thinking.
3. You click conversation **B** in the sidebar.
4. The prefill is still sitting there, still pointing at **A**.
5. You type a new topic and hit Generate, thinking you're making something fresh.
6. It replaces **A** — wiping a conversation you're not even looking at — and yanks you back to
   `/chat/A`.

The check makes step 4 harmless: the prefill's conversation is A, you're viewing B, so it's ignored
and the form behaves like a normal blank form.

Filtering rather than deleting has a small bonus: if you wander back to A, the pending prefill is
still there waiting for you instead of having been silently thrown out.

**Wiring it up:**

```tsx
<LabGeneratorForm prefill={activePrefill} onSubmitted={() => setPrefill(null)} />
<ChatBot key={`${conversationId}:${runId}`} onRegenerate={setPrefill} />
```

`onRegenerate={setPrefill}` is the hallway. `ChatBot` calls it, the note lands in `HomePage`, and it
flows straight back down into the form.

### 4.3 `ChatBot.tsx` — the chat window

**It now receives the original settings from the server.** The messages endpoint was widened to
include `labParams` — the topic, skill level, environment, and starter-code flag the lab was built
with. `ChatBot` stores them:

```tsx
const [labParams, setLabParams] = useState<LabParams | null>(null);
```

This does double duty: it's the data to prefill *and*, being empty until a lab exists, it's the
switch that decides whether the Regenerate button is visible at all. No separate flag needed.

Important detail: this gets set in **two** places — when the conversation first loads, and again when
a generation finishes. Miss the second one and the button stays hidden until you reload the page.

**It sends the flag when generating:**

```tsx
body: JSON.stringify({ ...labData, conversationId, regenerate }),
```

That `regenerate` is what tells the server to take the destructive path — wipe the messages and notes
and repoint the conversation — instead of the normal create path.

**The button handler:**

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

The thing to understand: **clicking Regenerate doesn't generate anything.** It only sends the
settings over to the form. You then edit them and press submit, and *that* is what starts the
generation. This is deliberate — "this lab isn't what I wanted" usually means the wording needs
changing, so a one-click reroll of the identical prompt would just hand you a very similar lab.

The middle bit is the confirmation. `messages.length > 1` means "there's more here than just the lab
itself" — that is, you've actually had a conversation about it worth losing. If it's just the lab and
nothing else, there's nothing to warn about, so it skips straight through rather than nagging you.

The `!confirming` part lets one function handle both clicks: the first click arms the warning and
stops, the second click (from the "Replace" button) sails past and proceeds.

**The header row** used to be two separate bars — one for Download, one for Stop. Adding Regenerate
would have made three stacked bars, so they're merged into one row. When the confirmation is armed,
that whole row is swapped for the warning message plus Cancel and Replace, so nothing on the page
shifts around.

Two conditions worth calling out:

- Regenerate only shows when `phase === "idle"` — you can't kick off a second generation while one is
  streaming. Stop it first. This is also why Regenerate and Stop never appear at the same time.
- The whole row is hidden when there's nothing in it, so an empty conversation doesn't render a
  pointless bordered strip.

---

## 5. A full regeneration, start to finish

You're in conversation `abc`, looking at a lab you don't like. Current badge number: `r1`.

| Step | What happens |
|---|---|
| 1 | You click **Regenerate** in the chat. |
| 2 | `ChatBot` sees you've chatted, so it swaps the button row for *"Replacing this lab clears this chat and its notes"* with Cancel / Replace. |
| 3 | You click **Replace**. `ChatBot` calls `onRegenerate({ values, conversationId: "abc" })`. |
| 4 | The note lands in `HomePage` as `prefill`. It points at `abc`, and you're viewing `abc`, so it passes the filter and reaches the form. |
| 5 | The form's effect fires and `reset()` loads the old settings into the fields. The button now reads "Regenerate". |
| 6 | You reword the topic and hit submit. |
| 7 | The form reuses conversation id `abc`, sets `regenerate: true`, mints badge `r2`, tells `HomePage` to drop the prefill, and navigates to `/chat/abc` with all of it on a sticky note. |
| 8 | `HomePage` renders, spots badge `r2` on the note, and writes it into its notebook. The key becomes `abc:r2`. |
| 9 | Different key → React fires the old `ChatBot` and hires a new one. Empty messages, no stale lab. |
| 10 | The new `ChatBot` photocopies the sticky note — settings and the regenerate flag — then peels the note off the history page. |
| 11 | `HomePage` sees the note is now blank, ignores it, and **keeps badge `r2`**. The key holds steady, so nothing is torn down. |
| 12 | The generate request goes out with `regenerate: true`. The lab streams onto the screen. |
| 13 | The server finishes the new lab, *then* wipes the old messages and notes and repoints the conversation. |
| 14 | `ChatBot` refetches, showing the new lab and its settings. Same URL, same sidebar entry, one lab. |

Step 11 is the one that took the most care to get right.

---

## 6. Problems the code is quietly guarding against

| Guard | What would happen without it |
|---|---|
| `runId` in the key | The new lab would stream in underneath the old one, which never cleared. |
| Sticky `runId` in `HomePage` | Generation would be aborted milliseconds after starting, every time. |
| Photocopying `labData` | Reloading the page would wipe your conversation and regenerate. |
| Stable copy, not a live read | The in-flight request would abort itself on an unrelated re-render. |
| `activePrefill` filter | Regenerating a conversation you're not looking at. |
| `onSubmitted()` | The form gets stuck replacing the same conversation forever. |
| `messages.length > 1` | Being nagged for confirmation when there's nothing to lose. |
| `phase === "idle"` | Starting a second generation on top of one already streaming. |

---

## 7. What's deliberately left imperfect

- **The sidebar title lags.** It's taken from a conversation's first message, and the sidebar only
  refreshes when you switch conversations. After regenerating it still shows the old lab's title
  until you click elsewhere and come back. It corrects itself; wiring up a refresh signal wasn't
  worth the plumbing.
- **The starter-code checkbox is a guess.** Nothing records whether you *asked* for starter code —
  only whether it exists. If starter-code generation failed last time, the box comes back unchecked
  even though you'd ticked it.
- **A ~5ms reload window remains.** Between the form navigating and `ChatBot` peeling off the sticky
  note, a reload would still replay. You'd have to hit refresh inside a few milliseconds.
- **Nothing is transactional.** The server does the repoint, the wipe, and the new message as three
  separate database calls. A crash between them could leave a conversation with no lab message. The
  window is tiny and the new lab row survives, so it's accepted rather than engineered around.
