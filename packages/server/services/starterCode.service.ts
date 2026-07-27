import { ChatOpenAI } from '@langchain/openai';
import z from 'zod';
import type { SkillLevel, TargetEnvironment } from '../repositories/labGeneration.repository';
import type { LabContent } from './labGeneration.service';


const starterCodeSchema = z.object({
    language: z.string(),
    files: z.array(
        z.object({
            path: z.string(),
            content: z.string(),
        }),
    ),
})


export type starterCode = z.infer<typeof starterCodeSchema>;
const llm = new ChatOpenAI({model: 'gpt-4o', maxTokens: 3000}).withStructuredOutput(starterCodeSchema)


function isSafePath(path: string): boolean {
    return (
        path.length > 0 && 
        !path.startsWith('/') &&
        !path.includes('..')&&
        !path.includes('\\') &&
        !/^[a-zA-Z]:/.test(path)
    )
}


export const starterCodeService = {
    async generate(
        topicText: string,
        SkillLevel: string,
        environment: TargetEnvironment,
        labContent: LabContent,
    ): Promise<starterCode> {
        const stepTitles = labContent.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')

        const result = await llm.invoke(
            `A learner is about to work through this hands-on lab:\n\n` +
            `Title: ${labContent.title}\n` +
            `Topic: ${topicText}\n` +
            `Steps:\n${stepTitles}\n\n` +
            `Generate a small starter-code project for them, targeting a ${SkillLevel} skill level ` +
            `on ${environment}.\n\n` +
            `Rules:\n` +
            `- Choose the language and stack the lab actually uses.\n` +
            `- Write STUB files, not a finished solution. Every file should be heavily commented, ` +
            `with TODO comments describing what the learner must implement at each point.\n` +
            `- Always include a dependency manifest idiomatic to the language you chose ` +
            `(requirements.txt for Python, package.json for Node, go.mod for Go, Cargo.toml for Rust, etc.) ` +
            `listing every dependency the lab needs, with pinned versions. Omit it only if the stack ` +
            `genuinely has no dependencies.\n` +
            `- Always include a README.md with the exact install and run commands for ${environment}.\n` +
            `- Use relative paths only. No leading slash, no "..", no absolute paths.\n` +
            `- Keep it under 8 files.`,
        )

        return { ...result, files: result.files.filter((f) => isSafePath(f.path))}
    }
}