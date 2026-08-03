import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QuizResultResponse } from "@/lib/quizApi";

type Props = {
  result: QuizResultResponse;
  topic: string;
  onRestart: () => void;
};

export function QuizResult({ result, topic, onRestart }: Props) {
  const percentage = Math.round((result.score / result.total) * 100);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="rounded-xl border border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">{topic}</p>
        <p className="mt-2 text-4xl font-semibold tabular-nums">
          {result.score}
          <span className="text-2xl text-muted-foreground">/{result.total}</span>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{percentage}% correct</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRestart}>
          New quiz
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {result.perQuestion.map((item, index) => {
          const correct = item.selectedIndex === item.correctIndex;
          return (
            <article
              key={index}
              className={`rounded-xl border p-4 ${
                correct
                  ? "border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/10"
                  : "border-destructive/30 bg-destructive/5"
              }`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 shrink-0 rounded-full p-1 ${
                    correct
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-destructive/15 text-destructive"
                  }`}
                >
                  {correct ? <Check size={13} /> : <X size={13} />}
                </span>
                <h3 className="text-sm font-medium">{item.question}</h3>
              </div>

              {!correct && item.selectedIndex !== null && (
                <p className="mt-3 text-sm text-muted-foreground">
                  <span className="text-destructive">Your answer:</span>{" "}
                  {item.choices[item.selectedIndex]}
                </p>
              )}

              <p className="mt-1.5 text-sm">
                <span className="text-muted-foreground">Correct:</span>{" "}
                {item.choices[item.correctIndex]}
              </p>

              <p className="mt-2 border-t border-border/60 pt-2 text-xs leading-relaxed text-muted-foreground">
                {item.explanation}
              </p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
