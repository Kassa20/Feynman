import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import z from 'zod';
import type { TargetEnvironment } from '../repositories/labGeneration.repository';
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

const SYSTEM_PROMPT = `You are an expert computer science tutor that generates bare bone starter code\n.` +  
                       `You do not give direct code implementations, but generate starter code 
                       to ease the burden of having to create a new project manually.`


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
        skillLevel: string,
        environment: TargetEnvironment,
        labContent: LabContent,
        mcpResult: string | null,
        abortSignal: AbortSignal,
    ): Promise<starterCode> {

        const steps = labContent.steps
            .map((s, i) => `${i + 1}. ${s.title}\n   ${s.description}`)
            .join('\n')

        const mcpToolCall = mcpResult 
            ?   `Verified dependency documentation, retrieved from the libraries' current ` +
                `docs just now. Prefer this over your own recollection of package names and ` +
                `version numbers:\n\n${mcpResult}\n\n`
            : ''

        const { output } = await generateText({
            model: openai('gpt-5.6-luna'),
            output: Output.object({ schema: starterCodeSchema }),
            maxOutputTokens: 20000,
            abortSignal,
            telemetry: { functionId: 'generate-starter-code' },
            system: SYSTEM_PROMPT,
            prompt:
                    `A learner is about to work through this hands-on lab:\n\n` +
                    `Title: ${labContent.title}\n` +
                    `Topic: ${topicText}\n` +
                    `Steps:\n${steps}\n\n` +
                    `Generate a small starter-code project for them, targeting a ${skillLevel} skill level ` +
                    `on ${environment}.\n\n` +
                    `dependency ${mcpToolCall}.\n\n` + 
                    `Rules:\n` +
                    `- Choose the language and stack the lab actually uses.\n` +
                    `- Do not write any css unless explictly stated` +
                    `- Write the bare-bones of the code. 
                     - Every file should be heavily commented.\n` +
                    `with TODO comments describing what the learner must implement at each point.\n` +
                    `- Always include a dependency manifest idiomatic to the language you chose ` +
                    `(requirements.txt for Python, package.json for Node, go.mod for Go, Cargo.toml ` +
                    `for Rust, etc.) listing every dependency the lab needs.\n` +
                    `- Pin a version ONLY when it appears in the verified documentation above. For ` +
                    `anything unverified, use an unpinned or minimum-bound requirement rather than ` +
                    `inventing a number. A wrong pin breaks the install; a loose one does not.\n` +
                    `- Always include a README.md with the exact install and run commands for ${environment}.\n` +
                    `- Use relative paths only. No leading slash, no "..", no absolute paths.\n`,
        })

        return { ...output, files: output.files.filter((f) => isSafePath(f.path))}
    }
}