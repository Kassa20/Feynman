import { openai } from '@ai-sdk/openai';
import { embed, generateText, Output } from 'ai';
import z from 'zod';
import { textbookRepository } from '../repositories/textbook.repository';
import { quizRepository, type StoredQuestion } from '../repositories/quiz.repository';
import type { SkillLevel } from '../repositories/labGeneration.repository';
import { judgeAnswerKeys } from './quizJudge.service';


const quizSchema = z.object({
    questions: z.array(
        z.object({
            question: z.string(),
            choices: z.array(z.string()).length(4),
            correctIndex: z.number().int().min(0).max(3),
            explanation: z.string(),
        }),
    ),
})

const RETRIEVAL_COUNT = 8;
const MIN_SIMILARITY = 0.3;

export class NoCoverageError extends Error {}
export class SessionNotFoundError extends Error {}
export class AlreadySubmittedError extends Error {}

const QUESTION_EXEMPLARS = `
Example 1 — tests a causal mechanism, not a definition:
{
  "question": "A process calls fork() and the child immediately calls execve(). Why does copy-on-write make this sequence cheap?",
  "choices": [
    "The parent's pages are never physically copied before execve() replaces the address space",
    "fork() is optimized to skip creating a new process descriptor",
    "execve() runs in the parent's address space, so no new memory is needed",
    "The kernel caches the child's page table from a previous fork()"
  ],
  "correctIndex": 0,
  "explanation": "COW defers the copy until a write. execve() discards the address space first, so the copy never happens."
}

Example 2 — applies a rule to a concrete scenario:
{
  "question": "A disk scheduler receives requests for cylinders 98, 183, 37 while the head sits at 53 moving upward. Under SCAN, which is serviced first?",
  "choices": ["98", "183", "37", "53"],
  "correctIndex": 0,
  "explanation": "SCAN continues in the current direction, so it services 98 and 183 on the way up before reversing for 37."
}

Example 3 — distinguishes two commonly confused concepts:
{
  "question": "Which condition distinguishes deadlock from livelock?",
  "choices": [
    "In deadlock the processes are blocked; in livelock they keep changing state without progressing",
    "Deadlock involves exactly two processes; livelock involves three or more",
    "Livelock can only occur on multiprocessor systems",
    "Deadlock is always resolved by the scheduler; livelock never is"
  ],
  "correctIndex": 0,
  "explanation": "Both stall progress, but livelocked processes are actively running and changing state."
}
`.trim();


export const quizService = {
    async generateQuiz(
            userId: string,
            query: string,
            difficulty: SkillLevel,
            count: number,
        ): Promise<{ sessionId: string; questions: { question: string; choices: string[] }[] }> {
            const { embedding: queryEmbedding } = await embed({
                model: openai.embedding('text-embedding-3-small'),
                value: query,
                telemetry: { functionId: 'embed-quiz-query' },
            });
            const chunks = await textbookRepository.matchChunks(queryEmbedding, RETRIEVAL_COUNT);


            if (chunks.length === 0 || chunks[0]!.similarity < MIN_SIMILARITY) {
                throw new NoCoverageError(query);
            }

            const passages = chunks
                .map((chunk, index) =>
                    `[${index + 1}] ${chunk.title}${chunk.page !== null ? `, p.${chunk.page}` : ''}\n${chunk.content}`,
                )
                .join('\n\n---\n\n');

            const { output } = await generateText({
                model: openai('gpt-5.6-luna'),
                output: Output.object({ schema: quizSchema }),
                maxOutputTokens: 10000,
                telemetry: { functionId: 'generate-quiz' },
                prompt:
                `You are writing a ${difficulty}-level multiple-choice quiz on the topic "${query}".\n\n` +
                `Write exactly ${count} questions using ONLY the passages below. Every question must be ` +
                `answerable from these passages alone.\n\n` +
                `Rules:\n` +
                `- Exactly 4 choices, exactly one unambiguously correct.\n` +
                `- Distractors must be plausible to someone who half-understands the material — ` +
                `common misconceptions, adjacent concepts, right idea applied to the wrong case. ` +
                `Never filler.\n` +
                `- Never use "all of the above", "none of the above", or "both A and B".\n` +
                `- Do not reference "the passage" or "the text" — the reader will not see them.\n` +
                `- Do not repeat the same fact across two questions.\n` +
                `- The explanation states why the correct choice is right in one or two sentences.\n` +
                `- Calibrate to ${difficulty}: beginner tests core concepts, intermediate tests ` +
                `application, advanced tests edge cases and interactions between concepts.\n\n` +
                `Here are examples of the KIND of question to write. Copy their form, not their subject:\n\n` +
                `${QUESTION_EXEMPLARS}\n\n` +
                `Passages:\n\n${passages}`,
            });

            const valid = output.questions.filter(isStructurallyValid);

            if (valid.length === 0) {
                throw new Error('Model returned no structurally valid questions');
            }

            const questions: StoredQuestion[] = valid.slice(0, count);

            const session = await quizRepository.createSession(
                userId,
                query,
                difficulty,
                questions,
                chunks.map((chunk) => chunk.id),
            );

            // Fire-and-forget. The user must not wait on the judge, which means a
            // mis-keyed question still reaches this user — the point is finding out.
            judgeAnswerKeys(questions).catch((error) =>
                console.error('[quiz] answer-key judge failed:', error),
            );

            // Strip the key before it leaves the server. This is the whole point of
            // persisting the session.
            return {
                sessionId: session.id,
                questions: questions.map(({ question, choices }) => ({ question, choices })),
            };
        },

    async submitQuiz(
        userId: string,
        sessionId: string,
        answers: number[],
    ): Promise<{
        score: number;
        total: number;
        perQuestion: {
            question: string;
            choices: string[];
            selectedIndex: number | null;
            correctIndex: number;
            explanation: string;
        }[];
    }> {
        const session = await quizRepository.getSession(sessionId, userId);
        if (!session) throw new SessionNotFoundError(sessionId);
        if (session.submittedAt) throw new AlreadySubmittedError(sessionId);

        const perQuestion = session.questions.map((question, index) => {
            const selectedIndex = answers[index] ?? null;
            return {
                question: question.question,
                choices: question.choices,
                selectedIndex,
                correctIndex: question.correctIndex,
                explanation: question.explanation,
            };
        });

        const score = perQuestion.filter((q) => q.selectedIndex === q.correctIndex).length;
        const total = session.questions.length;

        await quizRepository.recordResult(sessionId, score, total, answers);

        return { score, total, perQuestion };
    },
}

// Structural checks only, by decision. This catches questions that are
// unanswerable or self-evidently broken; it does NOT verify that correctIndex is
// actually the right answer.
function isStructurallyValid(question: {
    question: string; choices: string[]; correctIndex: number; explanation: string;
}): boolean {
    if (question.question.trim().length === 0) return false;
    if (question.choices.length !== 4) return false;
    if (question.choices.some((choice) => choice.trim().length === 0)) return false;

    // Duplicate choices mean two correct answers or a wasted slot.
    const normalized = question.choices.map((choice) => choice.trim().toLowerCase());
    if (new Set(normalized).size !== normalized.length) return false;

    if (question.correctIndex < 0 || question.correctIndex >= question.choices.length) return false;

    // The prompt bans these; the model occasionally does it anyway, and they make
    // the single-correct-answer assumption false.
    if (normalized.some((choice) => choice.startsWith('all of the above')
        || choice.startsWith('none of the above'))) return false;

    return true;
}

