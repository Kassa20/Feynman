import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { LangfuseClient } from '@langfuse/client';
import { startActiveObservation, updateActiveObservation } from '@langfuse/tracing';
import z from 'zod';
import type { StoredQuestion } from '../repositories/quiz.repository';
import { langfuseSpanProcessor } from '../lib/instrumentation';

const langfuse = new LangfuseClient();

const verdictSchema = z.object({
    answerIndex: z.number().int().min(0).max(3),
    reasoning: z.string(),
});

const parsedRate = Number(process.env.QUIZ_JUDGE_SAMPLE_RATE ?? 0.2);
const SAMPLE_RATE = Number.isFinite(parsedRate) ? Math.min(1, Math.max(0, parsedRate)) : 0.2;

// Random k-of-n rather than the first k. Judging only the first few questions never
export function sampleQuestions(
    questions: StoredQuestion[],
): { question: StoredQuestion; index: number }[] {
    if (SAMPLE_RATE <= 0) return [];

    const k = Math.min(questions.length, Math.max(1, Math.ceil(questions.length * SAMPLE_RATE)));
    const indices = questions.map((_, index) => index);

    // Partial Fisher-Yates
    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(Math.random() * (indices.length - i));
        [indices[i], indices[j]] = [indices[j]!, indices[i]!];
    }

    return indices.slice(0, k).map((index) => ({ question: questions[index]!, index }));
}

export async function judgeAnswerKeys(questions: StoredQuestion[]): Promise<void> {
    const sample = sampleQuestions(questions);
    if (sample.length === 0) return;

    await Promise.all(sample.map(({ question, index }) =>
        startActiveObservation(`judge-answer-key-${index}`, async (span) => {
            const prompt =
                `Answer this multiple-choice question. Reason from the subject matter, ` +
                `not from how the choices are worded.\n\n` +
                `${question.question}\n\n` +
                question.choices.map((choice, i) => `${i}. ${choice}`).join('\n');

            // Deliberately not gpt-5.6-luna. A judge that shares the author's blind
            // spots agrees with the author's mistakes — the one thing it must not do.
            const { output: verdict } = await generateText({
                model: openai('gpt-4o'),
                output: Output.object({ schema: verdictSchema }),
                maxOutputTokens: 2000,
                telemetry: { functionId: 'judge-answer-key' },
                prompt,
            });

            const agrees = verdict.answerIndex === question.correctIndex;

            updateActiveObservation({
                input: { question: question.question, choices: question.choices },
                output: verdict,
                metadata: { questionIndex: index, storedCorrectIndex: question.correctIndex, agrees },
            });


            langfuse.score.observation({ otelSpan: span.otelSpan }, {
                name: 'answer-key-agreement',
                value: agrees ? 1 : 0,
                dataType: 'BOOLEAN',
                comment: agrees
                    ? undefined
                    : `Judge chose ${verdict.answerIndex}, key says ${question.correctIndex}. ` +
                      verdict.reasoning,
            });
        }),
    ));


    await langfuseSpanProcessor.forceFlush();
    await langfuse.score.flush();
}
