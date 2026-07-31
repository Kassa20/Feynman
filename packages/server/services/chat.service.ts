import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { conversationRepository } from '../repositories/conversation.repository';
import { notesService } from './notes.service';


const SYSTEM_PROMPT = `You are a study assistant that helps students
                        understand lab material. Answer the users
                        question in a concise manner. Not too verbose.
                        Only answer questions that are relevant to computer science topics.
                        Do not generate any files. Do not generate step by step labs or instructions. 
                        If a user asks, notify them that they can regenerate a new lab. 
                        If a user askes off topic questions, notify the user that you can only 
                        help with general computer science/Software engineering topics.`

type ChatEvent =
    | { type: 'chat-delta'; text: string }
    | { type: 'chat-done' };

export class ConversationNotFoundError extends Error {}

export const chatService = {
    async *sendMessage(
        prompt: string,
        conversationId: string,
        userId: string,
        abortSignal: AbortSignal,
    ): AsyncGenerator<ChatEvent> {
        const chatHistory = await conversationRepository.getMessages(conversationId, userId);
        if (chatHistory === null) {
            throw new ConversationNotFoundError(`Conversation ${conversationId} not found`);
        }

        // The DB stores assistant turns as role 'ai'; the AI SDK expects 'assistant'.
        const history = chatHistory.messages.map((m) => ({
            role: m.role === 'ai' ? ('assistant' as const) : ('user' as const),
            content: m.content,
        }))

        await conversationRepository.addUserMessage(conversationId, prompt)

        const result = streamText({
            model: openai('gpt-4o'),
            system: SYSTEM_PROMPT,
            maxOutputTokens: 500,
            abortSignal,
            messages: [...history, { role: 'user' as const, content: prompt }],
        });

        for await (const delta of result.textStream) {
            yield { type: 'chat-delta', text: delta }
        }

        const responseText = await result.text;
        await conversationRepository.addMessages(conversationId, null, responseText)

        const labGenerationId = await conversationRepository.getLabGenerationId(conversationId, userId)
        if (labGenerationId) {
            notesService
                .extractAndSave(prompt, responseText, userId, labGenerationId, conversationId)
                .catch((err) => console.error('[notes] extraction failed:', err))
        }

        yield { type: 'chat-done' };
    },
}
