import { ChatOpenAI } from '@langchain/openai';
import z from 'zod';
import {
    labGenerationRepository,
    type SkillLevel,
    type TargetEnvironment,
} from '../repositories/labGeneration.repository';

const labContentSchema = z.object({
    title: z.string(),
    steps: z.array(
        z.object({
            title: z.string(),
            description: z.string(),
            code: z.string().optional(),
        }),
    ),
})

export type LabContent = z.infer<typeof labContentSchema>;

const llm = new ChatOpenAI({ model: 'gpt-4o', maxTokens: 2000 }).withStructuredOutput(labContentSchema)

export const labGenerationService = {
    async generate(
        topicText: string,
        skillLevel: SkillLevel,
        environment: TargetEnvironment,
    ): Promise<{ id: string; content: LabContent }> {
        const cached = await labGenerationRepository.findCached(topicText, skillLevel, environment)
        if (cached) {
            return { id: cached.id, content: cached.content as LabContent }
        }

        const content = await llm.invoke(
            `Write a hands-on, step-by-step lab for the topic "${topicText}", ` +
            `targeting a ${skillLevel} skill level, for a user working on ${environment}. ` +
            `Each step should have a title, a description, and optionally a shell code snippet to run.`,
        )

        const created = await labGenerationRepository.create(topicText, skillLevel, environment, content)
        return { id: created.id, content: created.content as LabContent }
    },
}
