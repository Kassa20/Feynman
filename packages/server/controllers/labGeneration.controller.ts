import z from 'zod';
import type { Request, Response } from 'express';
import { labGenerationService } from '../services/labGeneration.service';

const generateSchema = z.object({
    topic: z
        .string()
        .trim()
        .min(1, { message: 'Topic cannot be empty' })
        .max(500, { message: 'Topic cannot exceed 500 characters' }),
    skillLevel: z.enum(['beginner', 'intermediate', 'advanced']),
    environment: z.enum(['macos', 'linux', 'windows']),
})

export const labGenerationController = {
    async generate(req: Request, res: Response) {
        const parseResult = generateSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        try {
            const { topic, skillLevel, environment } = parseResult.data;
            const result = await labGenerationService.generate(topic, skillLevel, environment)
            res.json(result)
        }
        catch (error) {
            console.error('[labs] error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    }
}
