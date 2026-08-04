import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import z from 'zod';
import { notesRepository, type NoteGenerationResult } from '../repositories/notes.repository';


const noteSchema = z.object({
    title: z.string(),
    note: z.string(),
});

export const notesService = {
    async extractAndSave(
        question: string,
        answer: string,
        userId: string,
        labGenerationId: string,
        conversationId: string,
    ): Promise<void> {
        const { output } = await generateText({
            model: openai('gpt-4o'),
            output: Output.object({ schema: noteSchema }),
            maxOutputTokens: 300,
            telemetry: { functionId: 'extract-note' },
            prompt:
                `A user asked the following question while working through a hands-on lab, and received this answer.\n\n` +
                `Question: "${question}"\n\nAnswer: "${answer}"\n\n` +
                `The user asked for this exchange to be saved as a study note. ` +
                `Write a short title (max 8 words) and a concise note ` +
                `(2-4 sentences) that distills the explanation for later review.`,
        })

        await notesRepository.create(userId, labGenerationId, conversationId, question, output.title, output.note)
    },

    async listNotes(userId: string): Promise<NoteGenerationResult[]> {
        return notesRepository.getNotes(userId)
    },
}

