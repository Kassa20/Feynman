import { openai } from '@ai-sdk/openai';
import { Output, streamText } from 'ai';
import z from 'zod';
import { starterCodeService } from './starterCode.service';
import {
  labGenerationRepository,
  type SkillLevel,
  type TargetEnvironment,
} from '../repositories/labGeneration.repository';
import { conversationRepository } from '../repositories/conversation.repository';
import { notesRepository } from '../repositories/notes.repository';


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

type LabEvent =
  | { type: 'lab-delta'; partial: unknown }
  | { type: 'lab-done'; labGenerationId: string }
  | { type: 'starter-code-start' }
  | { type: 'starter-code-failed' };


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
    async *generate(
        topicText: string,
        skillLevel: SkillLevel,
        environment: TargetEnvironment,
        conversationId: string,
        userId: string,
        starterCode: boolean,
        regenerate: boolean,
        abortSignal: AbortSignal,
    ): AsyncGenerator<LabEvent> {
        
        const result = streamText({
        model: openai('gpt-4o'),
        output: Output.object({ schema: labContentSchema }),
        maxOutputTokens: 2000,
        abortSignal,
        prompt:
            `Write a hands-on, step-by-step lab for the topic "${topicText}", ` +
            `targeting a ${skillLevel} skill level, for a user working on ${environment}. ` +
            `Each step should have a title, a description, and optionally a shell code snippet to run.`,
        });


        for await (const partial of result.partialOutputStream) {
            yield {type: 'lab-delta', partial}
        }

        //once full lab is resolved
        const labContent = await result.output;


        let starterCodeContent = null
        if (starterCode) {
            yield {type: 'starter-code-start'};
            try {
                starterCodeContent = await starterCodeService.generate(
                    topicText, skillLevel, environment, labContent,
                )
            } catch (error) {
                console.error('[labs] starter code generation failed:', error)
                yield {type: 'starter-code-failed'}
            }
        }

        const labGeneration = await labGenerationRepository.create(
            topicText, 
            skillLevel, 
            environment, 
            labContent,
            starterCodeContent)

        if (regenerate) {
            await conversationRepository.replaceLab(conversationId, userId, labGeneration.id)
            await notesRepository.deleteByConversation(conversationId, userId)
        } else {
            await conversationRepository.ensureConversation(conversationId, userId, labGeneration.id)
        }

        await conversationRepository.addMessages(conversationId, null, formatLabAsMarkdown(labContent))

        yield {type: 'lab-done', labGenerationId: labGeneration.id};
    },
}
