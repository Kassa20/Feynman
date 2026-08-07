import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ListChecks, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listQuizzes, type QuizListItem } from "@/lib/quizApi";

function formatDate(iso: string) {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function PreviousQuizzesPage() {
  const [quizzes, setQuizzes] = useState<QuizListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listQuizzes()
      .then(setQuizzes)
      .catch(() => setError("Something went wrong loading your quizzes."));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-5">
          <Link
            to="/quiz"
            className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={15} />
            Back to quiz
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              <span className="bg-[linear-gradient(transparent_62%,var(--primary)_62%)] px-1 -mx-1">
                Previous Quizzes
              </span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {quizzes
                ? quizzes.length === 0
                  ? "Quizzes you've completed will show up here"
                  : `${quizzes.length} ${quizzes.length === 1 ? "quiz" : "quizzes"} completed`
                : "Loading your quizzes…"}
            </p>
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

        {!quizzes && !error && (
          <div className="flex flex-col gap-3" aria-hidden>
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-center gap-4 rounded-xl border border-border p-4">
                <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="mt-2 h-3 w-1/4" />
                </div>
                <Skeleton className="h-6 w-12" />
              </div>
            ))}
          </div>
        )}

        {quizzes && quizzes.length === 0 && !error && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
            <div className="rounded-full bg-primary p-3 text-primary-foreground">
              <ListChecks size={20} />
            </div>
            <h2 className="text-base font-medium">No quizzes yet</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Take a quiz on any topic from the textbook library and it'll show
              up here once you finish it.
            </p>
            <Button render={<Link to="/quiz" />} className="mt-2">
              Take a quiz
            </Button>
          </div>
        )}

        {quizzes && quizzes.length > 0 && (
          <div className="flex flex-col gap-3">
            {quizzes.map((quiz) => {
              const percentage = Math.round((quiz.score / quiz.total) * 100);
              return (
                <Link
                  key={quiz.id}
                  to={`/quizzes/${quiz.id}`}
                  className="flex items-center gap-4 rounded-xl border border-border p-4 transition-colors hover:border-foreground/20"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{quiz.query}</span>
                    <span className="mt-1 text-xs text-muted-foreground capitalize">
                      {quiz.difficulty} · {formatDate(quiz.submittedAt)}
                    </span>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {quiz.score}/{quiz.total}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      ({percentage}%)
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
