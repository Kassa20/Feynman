import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Difficulty } from "@/lib/quizApi";

// Hardcoded to reflect what is actually ingested. Deriving these from the corpus
// is a later refinement; a wrong chip is worse than no chip, so this list must be
// updated alongside data/textbooks/manifest.json.
const SUGGESTED_TOPICS = [
  "Distributed systems",
  "Data structures and algorithms",
];

const DIFFICULTIES: Difficulty[] = ["beginner", "intermediate", "advanced"];

type Props = {
  initialQuery: string;
  onStart: (query: string, difficulty: Difficulty, count: number) => void;
  loading: boolean;
  error: string | null;
};

export function TopicPicker({ initialQuery, onStart, loading, error }: Props) {
  const [query, setQuery] = useState(initialQuery);
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
                <option key={n} value={n}>
                  {n}
                </option>
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
              // Passes the topic explicitly rather than relying on setQuery —
              // React state updates are async, so reading `query` right after
              // would submit the previous value.
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
