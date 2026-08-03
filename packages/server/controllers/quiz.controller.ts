import type { Request, Response } from 'express';
import z from 'zod';
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import {
    quizService,
    SessionNotFoundError,
    AlreadySubmittedError,
} from '../services/quiz.service';

const startSchema = z.object({
    query: z.string().trim()
        .min(1, { message: 'Topic cannot be empty' })
        .max(500, { message: 'Topic cannot exceed 500 characters' }),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
    count: z.number().int().min(3).max(10).default(5),
});

const submitSchema = z.object({
    sessionId: z.string().uuid(),
    answers: z.array(z.number().int().min(0).max(3)).min(1).max(10),
});

export const quizController = {
    async start(req: Request, res: Response) {
        const parseResult = startSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        const { query, difficulty, count } = parseResult.data;

        await propagateAttributes(
            {
                traceName: 'quiz-generation',
                userId: req.user!.id,
                tags: ['quiz'],
            },
            () => startActiveObservation('quiz-request', async (span) => {
                span.updateOtelSpanAttributes({ input: { query, difficulty, count } });

                try {
                    const quiz = await quizService.generateQuiz(req.user!.id, query, difficulty, count);
                    res.json(quiz);
                } catch (error) {
                    console.error('[quiz] error:', error);
                    span.updateOtelSpanAttributes({ level: 'ERROR', statusMessage: String(error) });
                    res.status(500).json({ message: 'Something went wrong generating your quiz' });
                }
            }),
        );
    },

    async submit(req: Request, res: Response) {
        const parseResult = submitSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        const { sessionId, answers } = parseResult.data;

        try {
            const result = await quizService.submitQuiz(req.user!.id, sessionId, answers);
            res.json(result);
        } catch (error) {
            if (error instanceof SessionNotFoundError) {
                return res.status(404).json({ message: 'Quiz session not found' });
            }
            if (error instanceof AlreadySubmittedError) {
                return res.status(409).json({ message: 'This quiz has already been submitted' });
            }
            console.error('[quiz] error:', error);
            res.status(500).json({ message: 'Something went wrong' });
        }
    },
};
