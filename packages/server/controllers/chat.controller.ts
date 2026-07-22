import z from 'zod';
import type { Request, Response } from 'express';
import { chatService } from '../services/chat.service';

const chatSchema = z.object({
    prompt: z
        .string()
        .trim()
        .min(1, { message: 'Prompt cannot be empty'})
        .max(1000, {message: 'Prompt cannot exceed 1000 characters'}),
    conversationId: z.string().uuid(),
    labGenerationId: z.string().uuid(),
    userId: z.string().uuid() // TODO: temporary, remove once auth middleware sets req.user
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
            const {prompt, conversationId, labGenerationId, userId} = parseResult.data;
            const response = await chatService.sendMessage(prompt, conversationId, userId, labGenerationId)
            res.json({message: response.message})
        }
        catch (error) {
            console.error('[chat] error:', error)
        }
    }
}