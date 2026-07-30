import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  MessageCircleQuestion,
  NotebookPen,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

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

const PAGE_SIZE = 4;

// Sticky-note accents, cycled by position so every page of results is varied.
const noteAccents = [
  {
    bar: "border-t-sky-500",
    icon: "text-sky-600 dark:text-sky-400",
    tint: "bg-sky-50/60 dark:bg-sky-500/10",
  },
  {
    bar: "border-t-amber-400",
    icon: "text-amber-600 dark:text-amber-400",
    tint: "bg-amber-50/60 dark:bg-amber-500/10",
  },
  {
    bar: "border-t-emerald-500",
    icon: "text-emerald-600 dark:text-emerald-400",
    tint: "bg-emerald-50/60 dark:bg-emerald-500/10",
  },
  {
    bar: "border-t-orange-500",
    icon: "text-orange-600 dark:text-orange-400",
    tint: "bg-orange-50/60 dark:bg-orange-500/10",
  },
];

function formatDate(iso: string) {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function NotesPage() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    api
      .get<NotesResponse>("/api/notes")
      .then(({ data }) => setNotes(data.notes))
      .catch(() => setError("Something went wrong loading your notes."));
  }, []);

  const filtered = useMemo(() => {
    if (!notes) return [];
    const term = query.trim().toLowerCase();
    if (!term) return notes;
    return notes.filter((note) =>
      [note.title, note.content, note.question, note.topic].some((field) =>
        field.toLowerCase().includes(term),
      ),
    );
  }, [notes, query]);

  const labCount = useMemo(
    () => (notes ? new Set(notes.map((note) => note.labGenerationId)).size : 0),
    [notes],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamped rather than reset in an effect, so a shrinking result set can never
  // leave the view stranded on a page that no longer exists.
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageNotes = filtered.slice(start, start + PAGE_SIZE);

  const onSearch = (value: string) => {
    setQuery(value);
    setPage(1);
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

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                <span className="bg-[linear-gradient(transparent_62%,var(--primary)_62%)] px-1 -mx-1">
                  Notes
                </span>
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {notes
                  ? notes.length === 0
                    ? "Key takeaways from your lab conversations"
                    : `${notes.length} ${notes.length === 1 ? "note" : "notes"} across ${labCount} ${labCount === 1 ? "lab" : "labs"}`
                  : "Loading your notes…"}
              </p>
            </div>

            {notes && notes.length > 0 && (
              <div className="relative w-full sm:w-64">
                <Search
                  size={15}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => onSearch(event.target.value)}
                  placeholder="Search notes"
                  aria-label="Search notes"
                  className="h-9 w-full rounded-lg border border-input bg-background pr-8 pl-9 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
                />
                {query && (
                  <button
                    onClick={() => onSearch("")}
                    aria-label="Clear search"
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-6">
        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {!notes && !error && (
          <div className="grid gap-4 sm:grid-cols-2" aria-hidden>
            {[0, 1, 2, 3].map((index) => (
              <div
                key={index}
                className="animate-pulse rounded-xl border border-border p-4"
              >
                <div className="h-3 w-1/4 rounded bg-muted" />
                <div className="mt-3 h-4 w-2/3 rounded bg-muted" />
                <div className="mt-3 h-3 w-full rounded bg-muted" />
                <div className="mt-2 h-3 w-4/5 rounded bg-muted" />
              </div>
            ))}
          </div>
        )}

        {notes && notes.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
            <div className="rounded-full bg-primary p-3 text-primary-foreground">
              <NotebookPen size={20} />
            </div>
            <h2 className="text-base font-medium">No notes yet</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Ask a question while working through a lab and the key takeaways
              will be saved here automatically.
            </p>
            <Button render={<Link to="/" />} className="mt-2">
              Go to a lab
            </Button>
          </div>
        )}

        {notes && notes.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
            <div className="rounded-full bg-sky-100 p-3 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400">
              <Search size={20} />
            </div>
            <h2 className="text-base font-medium">No matching notes</h2>
            <p className="text-sm text-muted-foreground">
              Nothing found for “{query.trim()}”.
            </p>
            <Button variant="outline" onClick={() => onSearch("")}>
              Clear search
            </Button>
          </div>
        )}

        {pageNotes.length > 0 && (
          <>
            <div className="grid items-stretch gap-4 sm:grid-cols-2">
              {pageNotes.map((note, index) => {
                const accent = noteAccents[index % noteAccents.length];
                return (
                <article
                  key={note.id}
                  className={`flex h-full flex-col rounded-xl border border-border border-t-4 ${accent.bar} ${accent.tint} p-4 transition-colors hover:border-foreground/20`}
                >
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <FlaskConical size={12} className={`shrink-0 ${accent.icon}`} />
                    <span className="truncate">{note.topic}</span>
                    <time
                      dateTime={note.createdAt}
                      className="ml-auto shrink-0 pl-2"
                    >
                      {formatDate(note.createdAt)}
                    </time>
                  </div>

                  <h2 className="mt-2.5 font-medium">{note.title}</h2>
                  <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                    {note.content}
                  </p>

                  <div className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-xs text-muted-foreground/80">
                    <MessageCircleQuestion
                      size={14}
                      className="mt-px shrink-0"
                    />
                    <span className="italic">{note.question}</span>
                  </div>
                </article>
                );
              })}
            </div>

            <nav
              aria-label="Notes pagination"
              className="mt-6 flex items-center justify-between gap-4 border-t border-border pt-4"
            >
              <p className="text-xs text-muted-foreground">
                Showing {start + 1}–{start + pageNotes.length} of{" "}
                {filtered.length}
              </p>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  <ChevronLeft />
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next
                  <ChevronRight />
                </Button>
              </div>
            </nav>
          </>
        )}
      </main>
    </div>
  );
}
