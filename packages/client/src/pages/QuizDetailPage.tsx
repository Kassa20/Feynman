import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import { QuizResult } from "@/components/quiz/QuizResult";
import { getQuizResult, type QuizDetailResponse } from "@/lib/quizApi";

export function QuizDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [quiz, setQuiz] = useState<QuizDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getQuizResult(id).catch(() => null).then((data) => {
      if (!data) {
        setError("This quiz couldn't be found.");
        return;
      }
      setQuiz(data);
    });
  }, [id]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-5">
          <Link
            to="/quizzes"
            className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={15} />
            Back to previous quizzes
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="bg-[linear-gradient(transparent_62%,var(--primary)_62%)] px-1 -mx-1">
              Quiz Review
            </span>
          </h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {!quiz && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {quiz && (
          <QuizResult
            result={quiz}
            topic={quiz.query}
            onRestart={() => navigate("/quiz")}
          />
        )}
      </main>
    </div>
  );
}
