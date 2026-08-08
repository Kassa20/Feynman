import { createMCPClient } from '@ai-sdk/mcp';
import { openai } from '@ai-sdk/openai';
import { generateText, isStepCount, type ToolSet } from 'ai';
import type { LabContent } from './labGeneration.service';

const RESEARCH_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
    `You are a build engineer who verifies dependencies before a project is scaffolded. ` +
    `You have tools that read current library documentation. Use them — never rely on ` +
    `your own recollection of package names or version numbers, which is out of date.`;


export const researchService = {
    /**
     * Looks up current documentation for the libraries this lab needs and returns
     * a plain-text brief for the starter-code prompt.
     *
     * Never throws. Returns null when research is unavailable (no API key, the
     * docs server is down, the timeout fires), in which case starter-code
     * generation proceeds exactly as it did before this feature existed.
     */

    async research(
        topicText: string,
        labContent: LabContent,
        abortSignal: AbortSignal,
    ): Promise<string | null> {
        if (!process.env.CONTEXT7_API_KEY) return null;

        let mcpClient;
        try {
            mcpClient = await createMCPClient({
                transport: {
                    type: 'http',
                    url: 'https://mcp.context7.com/mcp',
                    headers: {Authorization: `Bearer ${process.env.CONTEXT7_API_KEY}` },
                }
            });

            const steps = labContent.steps
                .map((s, i) => `${i + 1}. ${s.title}\n ${s.description}`)
                .join('\n');
            
            const { text } = await generateText({
                model: openai('gpt-5.6-luna'),
                tools: (await mcpClient.tools()) as ToolSet,
                stopWhen: isStepCount(8),
                abortSignal: AbortSignal.any([
                    abortSignal, 
                    AbortSignal.timeout(RESEARCH_TIMEOUT_MS),
                ]),
                telemetry: {functionId: 'MCP-tool-call'},
                system: SYSTEM_PROMPT,
                prompt:
                    `A starter-code project is about to be scaffolded for this lab:\n\n` +
                    `Topic: ${topicText}\n` +
                    `Title: ${labContent.title}\n` +
                    `Steps:\n${steps}\n\n` +
                    `Identify every library, framework and runtime this project must ` +
                    `install. For each one, use the tools to resolve it and read its ` +
                    `installation and setup documentation.\n\n` +
                    `Then report:\n` +
                    `- the exact package name as published to its registry\n` +
                    `- the version the current documentation demonstrates\n` +
                    `- the install command\n` +
                    `- any peer or companion package the docs say is also required ` +
                    `(database drivers, type packages, build plugins)\n\n` +
                    `If you could not verify something, say so explicitly instead of ` +
                    `guessing. An honest "unverified" is more useful than a wrong version.`,

            })

            return text;
        } catch (error) {
            console.error('[docs-research] lookup failed, continuing without it:', error);
            return null;
        } finally {
            await mcpClient?.close();
        }
    }
}