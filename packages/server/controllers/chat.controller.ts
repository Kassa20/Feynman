import z from 'zod';
import type { Request, Response } from 'express';
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import { chatService, ConversationNotFoundError } from '../services/chat.service';

const chatSchema = z.object({
    prompt: z
        .string()
        .trim()
        .min(1, { message: 'Prompt cannot be empty'})
        .max(1000, {message: 'Prompt cannot exceed 1000 characters'}),
    conversationId: z.string().uuid(),
})

export const chatController = {
    async sendMessage(req: Request, res: Response) {
        const parseResult = chatSchema.safeParse(req.body);
        {
            if(!parseResult.success) {
                return res.status(400).json(parseResult.error.format());
            }
        }

        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) controller.abort();
        })

        const {prompt, conversationId} = parseResult.data;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`)

        await propagateAttributes(
            {
                traceName: 'chat',
                userId: req.user!.id,
                sessionId: conversationId,
                tags: ['chat'],
            },
            () => startActiveObservation('chat-request', async (span) => {
                span.updateOtelSpanAttributes({ input: { prompt } });

                try {
                    for await (const event of chatService.sendMessage(
                        prompt, conversationId, req.user!.id, controller.signal,
                    )) {
                        send(event);
                    }
                } catch (error) {
                    if (error instanceof ConversationNotFoundError) {
                        send({ type: 'error', message: 'Conversation not found' })
                    } else {
                        console.error('[chat] error:', error)
                        span.updateOtelSpanAttributes({ level: 'ERROR', statusMessage: String(error) })
                        send({ type: 'error', message: 'Something went wrong' })
                    }
                } finally {
                    res.end();
                }
            }),
        );
    }
}
