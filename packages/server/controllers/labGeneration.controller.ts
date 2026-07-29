import z from 'zod';
import type { Request, Response } from 'express';
import { zipSync, strToU8 } from 'fflate';                            
import { labGenerationService } from '../services/labGeneration.service';
import { labGenerationRepository } from '../repositories/labGeneration.repository';

const generateSchema = z.object({
    topic: z
        .string()
        .trim()
        .min(1, { message: 'Topic cannot be empty' })
        .max(500, { message: 'Topic cannot exceed 500 characters' }),
    skillLevel: z.enum(['beginner', 'intermediate', 'advanced']),
    environment: z.enum(['macos', 'linux', 'windows']),
    conversationId: z.string().uuid(),
    starterCode: z.boolean().default(false),
})

const paramsSchema = z.object({ id: z.string().uuid() })

function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'lab'
}

export const labGenerationController = {
    async generate(req: Request, res: Response) {
        const parseResult = generateSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) controller.abort();
        })
     
        const { topic, skillLevel, environment, conversationId, starterCode } = parseResult.data;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // function to stream messages
        const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`)

        try {
            for await (const event of labGenerationService.generate(
                topic, skillLevel, environment, conversationId, req.user!.id, starterCode, controller.signal,
            )) {
                send(event);
            }
        } catch (error) {
            console.error('[labs] error:', error);
            send({ type: 'error', message: 'Something went wrong generating your lab' });
        } finally {
            res.end();
        }

    },

    async downloadStarterCode(req: Request, res: Response) {
        const parseResult = paramsSchema.safeParse(req.params);
        if (!parseResult.success) {
            return res.status(400).json(parseResult.error.format());
        }

        try {
            const row = await labGenerationRepository.getStarterCode(parseResult.data.id, req.user!.id)
            if (!row) {
                return res.status(404).json({ message: 'Starter code not found' })
            }

            const entries = Object.fromEntries(
                row.starterCode.files.map((file) => [file.path, strToU8(file.content)])
            )
            const zipped = zipSync(entries, {level: 9})

            res.setHeader('Content-Type', 'application/zip')
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${slugify(row.topicText)}-starter.zip"`,
            )
            res.send(Buffer.from(zipped))
        }
        catch (error) {
            console.error('[labs] starter code download error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    },
}
