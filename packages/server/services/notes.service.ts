import { ChatOpenAI } from '@langchain/openai';
import z from 'zod';
import { notesRepository, type NoteGenerationResult } from '../repositories/notes.repository';


const noteSchema = z.object({
    shouldSave: z.boolean(),
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
            `Decide if this exchange contains a key learning worth saving as a study note. ` +
            `Examples of what to save: "What is the use of JWT tokens?", "What is the use of design patterns?" ` +
            `(set shouldSave to false for small talk, acknowledgements, or trivial exchanges). ` +
            `If it should be saved, write a short title (max 8 words) and a concise note ` +
            `(2-4 sentences) that distills the explanation for later review.`,
        )

        if (!result.shouldSave) return

        await notesRepository.create(userId, labGenerationId, conversationId, question, result.title, result.note)
    },

    async listNotes(userId: string): Promise<NoteGenerationResult[]> {
        return notesRepository.getNotes(userId)
    },
}

