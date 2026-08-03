# What `ingestTextbooks.ts` does — line by line

> Note: this diverges from `quiz-feature-rag.md` §6 in two ways. There is no
> `manifest.json` — the script discovers PDFs on disk and reads each book's title
> and author out of the PDF's own metadata — and there is no `license` field,
> since nothing in the app consumes it. Code blocks below are copied verbatim from
> `packages/server/scripts/ingestTextbooks.ts`.

## The big picture, first

The quiz feature needs an AI to write quiz questions grounded in real textbook
content instead of making things up. For the AI to pull "the relevant part of the
textbook" for a topic like "CPU scheduling," the textbook first has to be broken
into small searchable pieces and stored somewhere searchable.

`ingestTextbooks.ts` is that one-time (or run-when-you-add-a-book) setup script.
You run it by hand from your terminal — `bun run packages/server/scripts/ingestTextbooks.ts`
— it is never imported or called by the live server. It's like building a
searchable index for a book before anyone can look things up in it.

Now, block by block.

---

## 1. Imports

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { OpenAIEmbeddings } from '@langchain/openai';
import { textbookRepository, type TextbookChunkInput } from '../repositories/textbook.repository';
```

- `readFileSync` — reads a file from disk synchronously (blocks until done). Used
  to load a PDF's raw bytes.
- `readdirSync` — lists the filenames inside a directory. This is what replaces a
  hand-maintained list of books: whatever `.pdf` files are sitting in
  `data/textbooks` *are* the corpus.
- `join`, `dirname` — Node's path helpers. `join('/a', 'b')` → `/a/b`. `dirname('/a/b/c.ts')` → `/a/b`.
  Used to build a path to the `data/textbooks` folder regardless of what directory
  you happen to run the script from.
- `basename` — strips a path down to the filename, and with a second argument
  strips that extension too: `basename('/x/ostep.pdf', '.pdf')` → `ostep`. Used as
  the fallback book title.
- `fileURLToPath` — converts the special `import.meta.url` (a `file://...` URL
  every ES module has, pointing at its own file) into a normal filesystem path
  string, so `dirname` can use it.
- `PDFParse` — the class from the `pdf-parse` library that actually opens a PDF
  and extracts text from it.
- `Document` — a small LangChain data structure: just `{ pageContent: string, metadata: {...} }`.
  It's the standard "unit of text" that LangChain's tools (like the splitter below)
  expect and produce.
- `RecursiveCharacterTextSplitter` — a LangChain utility that cuts long text into
  smaller overlapping chunks.
- `OpenAIEmbeddings` — a LangChain wrapper around OpenAI's embedding API. Handles
  calling the API and getting back lists of numbers.
- `textbookRepository`, `TextbookChunkInput` — your own repository (§3a of the
  spec) and the TypeScript type describing what one row to insert looks like.
  This is the *only* place the script touches Supabase — it never calls
  `supabase` directly, matching the project's "repositories are the only layer
  that talks to Supabase" rule from `CLAUDE.md`.

## 2. The parsed-PDF type

```ts
type ParsedPdf = {
    title: string;
    author: string | null;
    pages: Document[];
};
```

This is what step 4 hands back for one book: everything the rest of the pipeline
needs, all of it extracted from the PDF file itself. `author` is `string | null`
rather than optional because plenty of PDFs record no author, and `null` is what
the database column wants.

> **Why no manifest file?** An earlier design listed every book in a
> `data/textbooks/manifest.json` with its title, author and license typed by hand.
> That's worth doing when your sources are heterogeneous (scraped web pages, say)
> and carry no metadata of their own. For a folder of PDFs it's redundant data
> entry that can silently drift out of sync with the actual files — so the script
> reads the folder and reads each PDF's embedded metadata instead.

## 3. Constants

```ts
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data/textbooks');
const EMBED_BATCH = 100;

const embeddings = new OpenAIEmbeddings({ model: 'text-embedding-3-small' });

const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
});
```

- `DATA_DIR` — computes the absolute path to `packages/server/data/textbooks`,
  starting from *this script's own location* and going up one directory then into
  `data/textbooks`. Using the script's own location (rather than assuming a
  current working directory) means the script works no matter where you run
  `bun run` from.
- `EMBED_BATCH = 100` — how many chunks to send to OpenAI per embedding request.
  Explained more in step 6.
- `embeddings` — one shared instance of the embedding client, created once and
  reused for every book, every chunk. Model `text-embedding-3-small` produces
  1536-number vectors — that number matters later because the database column
  storing these is fixed at that exact size.
- `splitter` — one shared instance of the text splitter, configured to produce
  ~1000-character chunks with 200 characters of overlap between consecutive
  chunks (so an idea that falls across a chunk boundary still appears whole in at
  least one chunk).

## 4. `loadPdf` — turn a PDF file into metadata + per-page text

```ts
async function loadPdf(filePath: string): Promise<ParsedPdf> {
    const parser = new PDFParse({ data: new Uint8Array(readFileSync(filePath)) });
    try {
        // The PDF /Info dictionary, typed `any` by pdf-parse since its contents
        // are whatever the producing tool wrote.
        const { info } = await parser.getInfo() as { info?: { Title?: string; Author?: string } };
        const { pages } = await parser.getText();

        return {
            // LaTeX-produced PDFs often carry an empty or junk /Info Title, so the
            // filename is the fallback — it is what shows up in quiz citations.
            title: info?.Title?.trim() || basename(filePath, '.pdf'),
            author: info?.Author?.trim() || null,
            pages: pages.map(
                (page) => new Document({
                    pageContent: page.text,
                    metadata: { page: page.num },
                }),
            ),
        };
    } finally {
        // Without this the parser's worker keeps the process alive.
        await parser.destroy();
    }
}
```

Step by step:

1. `readFileSync(filePath)` reads the whole PDF file into memory as raw bytes.
   `new Uint8Array(...)` just wraps those bytes in the format `PDFParse` expects.
2. `new PDFParse({ data: ... })` creates a parser instance for that specific PDF.
3. `await parser.getInfo()` reads the PDF's **/Info dictionary** — a small block of
   metadata every PDF carries, holding whatever the program that produced the file
   chose to write there: `Title`, `Author`, `Creator`, dates. This is where the
   book's title and author come from instead of a hand-typed manifest.
   - `pdf-parse` types `info` as `any` (its contents are entirely up to the
     producing tool), so the `as { info?: ... }` cast just tells TypeScript which
     two fields we intend to read.
   - `info?.Title?.trim() || basename(filePath, '.pdf')` — use the embedded title
     if there is one, otherwise fall back to the filename. The `||` (not `??`) is
     deliberate: an *empty* embedded title should also fall through to the
     filename, and `??` would only catch `null`/`undefined`.
   - This fallback matters in practice. LaTeX-produced textbooks frequently ship
     with a blank `Title`, or a useless one like `"main"` (the `.tex` filename).
     The script logs the title it resolved for each book, so if a book comes out
     with a bad name, rename the PDF to what you want the citation to read —
     you control the filename directly.
4. `await parser.getText()` does the actual work of reading the PDF's internal
   structure and pulling out the text, returning `{ pages: [...] }` — one entry
   per page, each with `.text` (the page's text) and `.num` (the page number).
5. `pages.map(...)` converts each raw page into a LangChain `Document`: the text
   goes into `pageContent`, and the page number goes into `metadata.page`. Storing
   the page number here means it survives into the database later, so a quiz
   question can eventually be traced back to "page 214."
6. `finally { await parser.destroy() }` — this always runs, whether or not an
   error happened above. It's cleanup: the PDF parser apparently starts an
   internal worker/thread that would otherwise keep the whole Node/Bun process
   running forever, even after the script "finishes." Destroying it lets the
   script actually exit.

## 5. `ingest` — the per-book pipeline

This is the core function; it does everything for one book. Let's break it into
its own sub-steps.

### 5a. Parse the PDF and sanity-check it

```ts
async function ingest(file: string): Promise<void> {
    console.log(`\n[${file}] parsing…`);
    const { title, author, pages } = await loadPdf(join(DATA_DIR, file));
    console.log(`[${file}] title: "${title}"${author ? ` — ${author}` : ''}`);

    const textLength = pages.reduce((sum, page) => sum + page.pageContent.trim().length, 0);
    if (textLength < 1000) {
        // A scanned PDF has no text layer and yields near-empty pages. Silently
        // ingesting it would produce a corpus that retrieves nothing.
        throw new Error(
            `${file} produced only ${textLength} characters across ${pages.length} pages — ` +
            `it is probably a scanned PDF with no text layer.`,
        );
    }
```

- `ingest` now takes just a filename string — everything else about the book is
  discovered, not passed in.
- `join(DATA_DIR, file)` builds the full path to this book's PDF, e.g.
  `.../data/textbooks/ostep.pdf`, and hands it to `loadPdf` from step 4. The
  `const { title, author, pages } = ...` is destructuring: pull those three fields
  out of the returned `ParsedPdf` into three local variables.
- The second `console.log` prints the resolved title and author so you can spot a
  book that picked up junk metadata on the very first run, rather than discovering
  it later in a quiz citation.
- `pages.reduce((sum, page) => sum + page.pageContent.trim().length, 0)` adds up
  the total character count across every page — `reduce` is just "walk the list,
  keep a running total." `.trim()` strips whitespace first so blank padding
  doesn't count.
- The `if (textLength < 1000)` check is a **sanity guard**: some PDFs are just
  scanned images of pages (like a photocopy) with no real, selectable text
  underneath — extracting "text" from one of those yields almost nothing. Without
  this check, the script would happily continue with a nearly-empty book, and you
  wouldn't find out until later, when quiz generation mysteriously says "no
  coverage" for every topic in that book. Throwing here fails loudly and
  immediately, with a message that tells you exactly which file and why.

### 5b. Split each page into chunks

```ts
    const splits = await splitter.splitDocuments(pages);
    console.log(`[${file}] ${pages.length} pages → ${splits.length} chunks, embedding…`);

    const chunks: TextbookChunkInput[] = [];
```

- `splitter.splitDocuments(pages)` takes the list of page-sized `Document`s and
  runs each one through the splitter configured in step 3 (1000 chars per chunk,
  200 char overlap). One page might turn into 2-3 chunks; the splitter also
  copies each page's `metadata` (including `page` number) onto every chunk it
  produces from that page, so page tracking survives the split.
- `chunks` is just an empty array we'll fill in as we go — this is what
  eventually gets handed to the database.

### 5c. Embed the chunks in batches

```ts
    for (let i = 0; i < splits.length; i += EMBED_BATCH) {
        const batch = splits.slice(i, i + EMBED_BATCH);
        const vectors = await embeddings.embedDocuments(batch.map((doc) => doc.pageContent));

        batch.forEach((doc, offset) => {
            chunks.push({
                sourceFile: file,
                title,
                author,
                page: (doc.metadata.page as number | undefined) ?? null,
                chunkIndex: i + offset,
                content: doc.pageContent,
                embedding: vectors[offset]!,
            });
        });

        console.log(`[${file}] embedded ${Math.min(i + EMBED_BATCH, splits.length)}/${splits.length}`);
    }
```

This is the "turn text into meaning-vectors" step, done in batches instead of all
at once.

- `for (let i = 0; i < splits.length; i += EMBED_BATCH)` — a loop that walks
  through `splits` 100 items at a time (`i` goes `0, 100, 200, ...`). Batching
  exists because the OpenAI embeddings API has a limit on how much text you can
  send per request — you can't just throw a whole textbook's worth of chunks at
  it in one call.
- `splits.slice(i, i + EMBED_BATCH)` grabs the current 100-item slice, e.g. items
  0–99, then 100–199, etc.
- `embeddings.embedDocuments(batch.map((doc) => doc.pageContent))` is the actual
  API call: it sends the text of every chunk in this batch and gets back a
  `vectors` array — one 1536-number list per chunk, **in the same order** the
  text was sent in. That ordering guarantee is what makes the next line safe.
- `batch.forEach((doc, offset) => { chunks.push({...}) })` — for every chunk in
  this batch, build the final object that will be inserted into the database:
  - `sourceFile`, `title`, `author` — the book-level facts from step 4, the same
    for every chunk in this book. (`title,` with no value is shorthand for
    `title: title` — the local variable destructured above.)
  - `page` — pulled from this chunk's metadata (set back in step 4/5b);
    `?? null` again normalizes a missing value to `null`.
  - `chunkIndex: i + offset` — a running position number for this chunk within
    the whole book (batch start `i` plus this chunk's position `offset` inside
    the batch), so chunks can be ordered/identified later.
  - `content: doc.pageContent` — the actual chunk text.
  - `embedding: vectors[offset]!` — the matching vector from the API response,
    at the same position (`offset`) as this chunk was in the batch. The `!` tells
    TypeScript "trust me, this is definitely not undefined."
- The final `console.log` just prints progress, e.g. `embedded 200/438`, so you
  can see the script is alive during a long-running ingest.

### 5d. Save to the database

```ts
    await textbookRepository.replaceChunks(file, chunks);
    console.log(`[${file}] stored ${chunks.length} chunks`);
}
```

- All the accumulated `chunks` for this one book get handed to
  `textbookRepository.replaceChunks`. Per the repository's implementation (§3a),
  this first **deletes** any existing rows for `file`, then **inserts** the
  new ones (in its own smaller sub-batches of 200, for request-size reasons).
- "Replace" instead of "insert" matters because you'll re-run this script
  whenever you tweak chunk size or re-ingest a fixed PDF — deleting-then-inserting
  keeps re-runs safe (idempotent) instead of piling up duplicate chunks every time.

## 6. Find the PDFs and run everything

```ts
const files = readdirSync(DATA_DIR).filter((file) => file.toLowerCase().endsWith('.pdf'));

if (files.length === 0) {
    throw new Error(`No PDFs found in ${DATA_DIR} — drop textbook PDFs there and re-run.`);
}

for (const file of files) {
    await ingest(file);
}

console.log('\nDone.');
```

- `readdirSync(DATA_DIR)` lists every filename in `data/textbooks`; `.filter(...)`
  keeps only the ones ending in `.pdf` (lowercased first, so `OSTEP.PDF` counts
  too). Adding a book to the corpus is therefore just "copy the PDF into that
  folder and re-run" — no file to edit.
- The `files.length === 0` guard exists because the alternative is the script
  printing `Done.` instantly and looking like it succeeded, when really it found
  nothing to do.
- `for (const file of files) { await ingest(file); }` — runs the whole
  pipeline from step 5 for each book, one at a time (sequentially, not in
  parallel — simpler, and avoids blasting the OpenAI API with many books' worth
  of requests simultaneously).
- Top-level `await` in a loop like this is only legal because Bun runs this file
  as an ES module, which supports top-level `await` natively (no wrapping
  `async function main() { ... }` needed).
- Prints `Done.` once every book has been processed.

---

## How this connects to the rest of the quiz feature

Once this script has run and the `textbook_chunks` table is populated, the live
quiz flow (`quizService.generateQuiz`) does the mirror-image operation at request
time:

1. Embeds the *user's* topic query with the same `text-embedding-3-small` model.
2. Calls `textbookRepository.matchChunks`, which asks Postgres (via the
   `match_textbook_chunks` RPC and the `pgvector` extension) for the stored
   chunks whose embeddings are closest to the query's embedding.
3. Hands those chunks to the AI as the only material it's allowed to write quiz
   questions from.

So this script is entirely offline prep work; nothing about it runs while a user
is using the app.
