import { ChatOpenAI } from '@langchain/openai';
import z from 'zod';
import { notesRepository, type NoteGenerationResult } from '../repositories/notes.repository';
import { CallbackHandler } from '@langfuse/langchain';


const langfuseHandler = new CallbackHandler();

const noteSchema = z.object({
    title: z.string(),
    note: z.string(),
});

const noteAgent = new ChatOpenAI({ model: 'gpt-4o', maxTokens: 300 }).withStructuredOutput(noteSchema);

export const notesService = {
    async extractAndSave(
        question: string,
        answer: string,
        userId: string,
        labGenerationId: string,
        conversationId: string,
    ): Promise<void> {
        const result = await noteAgent.invoke(
            `A user asked the following question while working through a hands-on lab, and received this answer.\n\n` +
            `Question: "${question}"\n\nAnswer: "${answer}"\n\n` +
            `The user asked for this exchange to be saved as a study note. ` +
            `Write a short title (max 8 words) and a concise note ` +
            `(2-4 sentences) that distills the explanation for later review.`,
            { callbacks: [langfuseHandler], runName: 'extract-note' },
        )

        await notesRepository.create(userId, labGenerationId, conversationId, question, result.title, result.note)
    },

    async listNotes(userId: string): Promise<NoteGenerationResult[]> {
        return notesRepository.getNotes(userId)
    },
}

