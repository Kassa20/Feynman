import { ChatOpenAI } from '@langchain/openai';
import { starterCodeService } from './starterCode.service';  
import z from 'zod';
import {
    labGenerationRepository,
    type SkillLevel,
    type TargetEnvironment,
} from '../repositories/labGeneration.repository';
import { conversationRepository } from '../repositories/conversation.repository';

const labContentSchema = z.object({
    title: z.string(),
    steps: z.array(
        z.object({
            title: z.string(),
            description: z.string(),
            code: z.string().nullable(),
        }),
    ),
})

export type LabContent = z.infer<typeof labContentSchema>;

const llm = new ChatOpenAI({ model: 'gpt-4o', maxTokens: 2000 }).withStructuredOutput(labContentSchema)

export function formatLabAsMarkdown(content: LabContent): string {
    const stepsMd = content.steps
        .map((step, i) => {
            const codeBlock = step.code ? `\n\n\`\`\`bash\n${step.code}\n\`\`\`` : ''
            return `### ${i + 1}. ${step.title}\n\n${step.description}${codeBlock}`
        })
        .join('\n\n')
    return `# ${content.title}\n\n${stepsMd}`
}

export const labGenerationService = {
    async generate(
        topicText: string,
        skillLevel: SkillLevel,
        environment: TargetEnvironment,
        conversationId: string,
        userId: string,
        starterCode: boolean,
    ): Promise<void> {
        const labContent = await llm.invoke(
            `Write a hands-on, step-by-step lab for the topic "${topicText}", ` +
            `targeting a ${skillLevel} skill level, for a user working on ${environment}. ` +
            `Each step should have a title, a description, and optionally a shell code snippet to run.`,
        )

        let starterCodeContent = null
        if (starterCode) {
            try {
                starterCodeContent = await starterCodeService.generate(
                    topicText, skillLevel, environment, labContent,
                )
            } catch (error) {
                console.error('[labs] starter code generation failed:', error)
            }
        }

        const labGeneration = await labGenerationRepository.create(
            topicText, 
            skillLevel, 
            environment, 
            labContent,
            starterCodeContent)

        await conversationRepository.ensureConversation(conversationId, userId, labGeneration.id)
        await conversationRepository.addMessages(conversationId, null, formatLabAsMarkdown(labContent))
    },
}
