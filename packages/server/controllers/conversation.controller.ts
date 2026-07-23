import z from 'zod';
import type { Request, Response } from 'express';
import { conversationRepository } from '../repositories/conversation.repository';

const paramsSchema = z.object({
    id: z.string().uuid(),
})

export const conversationController = {
    async list(req: Request, res: Response) {
        try {
            const conversations = await conversationRepository.listByUser(req.user!.id);
            res.json({ conversations })
        }
        catch (error) {
            console.error('[conversations] error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    },

    async getMessages(req: Request, res: Response) {
        const parseResult = paramsSchema.safeParse(req.params);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        try {
            const messages = await conversationRepository.getMessages(parseResult.data.id, req.user!.id);
            if (!messages) {
                return res.status(404).json({ message: 'Conversation not found' })
            }
            res.json({ messages })
        }
        catch (error) {
            console.error('[conversations] error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    }
}
