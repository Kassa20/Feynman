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

export type QuizListItem = {
  id: string;
  query: string;
  difficulty: Difficulty;
  score: number;
  total: number;
  submittedAt: string;
  createdAt: string;
};

export type QuizDetailResponse = QuizResultResponse & {
  query: string;
  difficulty: Difficulty;
  submittedAt: string;
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

export async function listQuizzes(): Promise<QuizListItem[]> {
  const { data } = await api.get<{ quizzes: QuizListItem[] }>("/api/quiz");
  return data.quizzes;
}

export async function getQuizResult(id: string): Promise<QuizDetailResponse> {
  const { data } = await api.get<QuizDetailResponse>(`/api/quiz/${id}`);
  return data;
}
