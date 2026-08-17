import type { NextFunction, Request, Response } from 'express';
import { usageRepository, type UsageAction } from '../repositories/usage.repository';

const WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_LIMITS: Record<UsageAction, number> = {
    lab_generate: Number(process.env.LIMIT_LAB_GENERATE ?? 20),
    chat_message: Number(process.env.LIMIT_CHAT_MESSAGE ?? 100),
    quiz_start: Number(process.env.LIMIT_QUIZ_START ?? 20),
};

const LABELS: Record<UsageAction, string> = {
    lab_generate: 'lab generations',
    chat_message: 'chat messages',
    quiz_start: 'quizzes',
};

export function enforceUsageLimit(action: UsageAction) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user!.id;
        const since = new Date(Date.now() - WINDOW_MS);

        try {
            const limit = await usageRepository.getLimit(userId, action) ?? DEFAULT_LIMITS[action];
            const used = await usageRepository.countSince(userId, action, since);

            if (used >= limit) {
                const oldest = await usageRepository.oldestSince(userId, action, since);
                const resetAt = oldest ? new Date(oldest.getTime() + WINDOW_MS) : null;

                return res.status(429).json({
                    message: `You've used all ${limit} ${LABELS[action]} allowed in a 24-hour period.`
                        + (resetAt ? ` Your limit resets at ${resetAt.toLocaleString()}.` : ''),
                    limit,
                    resetAt: resetAt?.toISOString() ?? null,
                });
            }

            // Recorded on entry rather than on success: a failed or aborted request has
            // already spent tokens, and charging up front is what stops retry-spam.
            await usageRepository.record(userId, action);
            next();
        } catch (error) {
            // Fail open — a database blip should degrade the limit, not the product.
            console.error('[usage-limit] error:', error);
            next();
        }
    };
}
