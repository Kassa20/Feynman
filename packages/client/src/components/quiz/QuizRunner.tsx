import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { QuizQuestion } from "@/lib/quizApi";

type Props = {
  questions: QuizQuestion[];
  onSubmit: (answers: number[]) => void;
  submitting: boolean;
};

export function QuizRunner({ questions, onSubmit, submitting }: Props) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(() =>
    questions.map(() => null),
  );

  const question = questions[index]!;
  const selected = answers[index];
  const isLast = index === questions.length - 1;

  const choose = (choiceIndex: number) => {
    setAnswers((previous) =>
      previous.map((value, i) => (i === index ? choiceIndex : value)),
    );
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Question {index + 1} of {questions.length}
        </span>
        <span className="tabular-nums">
          {answers.filter((answer) => answer !== null).length} answered
        </span>
      </div>

      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${((index + 1) / questions.length) * 100}%` }}
        />
      </div>

      <h2 className="mt-6 text-lg leading-relaxed font-medium">
        {question.question}
      </h2>

      <div className="mt-4 flex flex-col gap-2">
        {question.choices.map((choice, choiceIndex) => (
          <button
            key={choiceIndex}
            type="button"
            onClick={() => choose(choiceIndex)}
            className={`rounded-xl border p-3.5 text-left text-sm transition-colors ${
              selected === choiceIndex
                ? "border-primary bg-primary/5"
                : "border-border hover:border-foreground/20"
            }`}
          >
            <span className="mr-2 text-muted-foreground">
              {String.fromCharCode(65 + choiceIndex)}.
            </span>
            {choice}
          </button>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          size="sm"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          Previous
        </Button>

        {/* Gated on every question being answered so a partially-filled array
            can't quietly score zeros. Correctness isn't shown here — the client
            never holds the answer key. */}
        {isLast ? (
          <Button
            disabled={answers.some((answer) => answer === null) || submitting}
            onClick={() => onSubmit(answers as number[])}
          >
            {submitting ? "Grading…" : "Submit quiz"}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setIndex(index + 1)}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}
