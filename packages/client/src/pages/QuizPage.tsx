import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, History } from "lucide-react";
import axios, { type AxiosError } from "axios";
import { TopicPicker } from "@/components/quiz/TopicPicker";
import { QuizRunner } from "@/components/quiz/QuizRunner";
import { QuizResult } from "@/components/quiz/QuizResult";
import {
  startQuiz,
  submitQuiz,
  type Difficulty,
  type QuizStartResponse,
  type QuizResultResponse,
} from "@/lib/quizApi";

// Three phases — picking → answering → result — derived from which of `quiz` /
// `result` is set rather than an explicit enum, so there's one source of truth.
export function QuizPage() {
  const location = useLocation();
  // Set when arriving from a lab's "Quiz me" button, so the topic is prefilled.
  const initialQuery = (location.state as { topic?: string } | null)?.topic ?? "";
  const [quiz, setQuiz] = useState<QuizStartResponse | null>(null);
  const [result, setResult] = useState<QuizResultResponse | null>(null);
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onStart = async (
    query: string,
    difficulty: Difficulty,
    count: number,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const started = await startQuiz(query, difficulty, count);
      setTopic(query);
      setQuiz(started);
    } catch (caught) {
      // 404 (no corpus coverage) and 429 (usage limit reached) are expected
      // outcomes rather than failures, so the server's message is shown verbatim.
      const status = axios.isAxiosError(caught)
        ? caught.response?.status
        : undefined;
      const serverMessage = (caught as AxiosError<{ message?: string }>).response
        ?.data?.message;
      setError(
        status === 404
          ? (serverMessage ??
              `No textbook content covers "${query}" yet. Try one of the suggested topics.`)
          : status === 429
            ? (serverMessage ??
                "You've reached your quiz limit. Try again later.")
            : "Something went wrong generating your quiz.",
      );
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = async (answers: number[]) => {
    if (!quiz) return;
    setSubmitting(true);
    try {
      setResult(await submitQuiz(quiz.sessionId, answers));
    } catch {
      setError("Something went wrong grading your quiz.");
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    setQuiz(null);
    setResult(null);
    setTopic("");
    setError(null);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-5">
          <div className="flex items-center justify-between gap-4">
            <Link
              to="/"
              className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft size={15} />
              Back to lab
            </Link>
            <Link
              to="/quizzes"
              className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <History size={15} />
              Previous Quizzes
            </Link>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              <span className="bg-[linear-gradient(transparent_62%,var(--primary)_62%)] px-1 -mx-1">
                Quiz
              </span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {quiz && !result
                ? topic
                : "Test yourself on any topic from the textbook library"}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
        {result ? (
          <QuizResult result={result} topic={topic} onRestart={restart} />
        ) : quiz ? (
          <QuizRunner
            questions={quiz.questions}
            onSubmit={onSubmit}
            submitting={submitting}
          />
        ) : (
          <TopicPicker
            initialQuery={initialQuery}
            onStart={onStart}
            loading={loading}
            error={error}
          />
        )}
      </main>
    </div>
  );
}
