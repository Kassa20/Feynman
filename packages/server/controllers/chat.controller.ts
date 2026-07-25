import z from 'zod';
import type { Request, Response } from 'express';
import { chatService, ConversationNotFoundError } from '../services/chat.service';

const chatSchema = z.object({
    prompt: z
        .string()
        .trim()
        .min(1, { message: 'Prompt cannot be empty'})
        .max(1000, {message: 'Prompt cannot exceed 1000 characters'}),
    conversationId: z.string().uuid(),
    labGenerationId: z.string().uuid(),
})

export const chatController = {
    async sendMessage(req: Request, res: Response) {
        const parseResult = chatSchema.safeParse(req.body);
        {
            if(!parseResult.success) {
                return res.status(400).json(parseResult.error.format());
            }
        }

        try {
            const {prompt, conversationId, labGenerationId} = parseResult.data;
            const response = await chatService.sendMessage(prompt, conversationId, req.user!.id, labGenerationId)
            res.json({message: response.message})
        }
        catch (error) {
            if (error instanceof ConversationNotFoundError) {
                return res.status(404).json({ message: 'Conversation not found' })
            }
            console.error('[chat] error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    }
}