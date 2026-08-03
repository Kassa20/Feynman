import { api } from "@/lib/api";

export type Difficulty = "beginner" | "intermediate" | "advanced";

export type QuizQuestion = {
  question: string;
  choices: string[];
};

export type QuizStartResponse = {
  sessionId: string;
  questions: QuizQuestion[];
};

export type QuizResultResponse = {
  score: number;
  total: number;
  perQuestion: {
    question: string;
    choices: string[];
    selectedIndex: number | null;
    correctIndex: number;
    explanation: string;
  }[];
};

export async function startQuiz(
  query: string,
  difficulty: Difficulty,
  count: number,
): Promise<QuizStartResponse> {
  const { data } = await api.post<QuizStartResponse>("/api/quiz/start", {
    query,
    difficulty,
    count,
  });
  return data;
}

export async function submitQuiz(
  sessionId: string,
  answers: number[],
): Promise<QuizResultResponse> {
  const { data } = await api.post<QuizResultResponse>("/api/quiz/submit", {
    sessionId,
    answers,
  });
  return data;
}
