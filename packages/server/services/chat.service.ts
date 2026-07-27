import { HumanMessage, SystemMessage} from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { conversationRepository } from '../repositories/conversation.repository';
import { notesService } from './notes.service';


type chatResponse = {
    message: string;
}

const llm = new ChatOpenAI({model: 'gpt-4o', maxTokens: 500})
const SYSTEM_PROMPT = `You are a study assistant that helps students 
                        understand lab material. Answer the users 
                        question in a concise manner. Not too verbose.`

export class ConversationNotFoundError extends Error {}

export const chatService = {
    async sendMessage(
        prompt: string,
        conversationId: string,
        userId: string,
    ): Promise<chatResponse> {
        const chatHistory = await conversationRepository.getMessages(conversationId, userId);
        if (chatHistory === null) {
            throw new ConversationNotFoundError(`Conversation ${conversationId} not found`);
        }
        const response = await llm.invoke([new SystemMessage(SYSTEM_PROMPT),
                                            new HumanMessage(prompt),
                                            ...chatHistory
                                        ]);

        await conversationRepository.addMessages(conversationId, prompt, response.content as string)

        const labGenerationId = await conversationRepository.getLabGenerationId(conversationId, userId)
        if (labGenerationId) {
            notesService
                .extractAndSave(prompt, response.content as string, userId, labGenerationId, conversationId)
                .catch((err) => console.error('[notes] extraction failed:', err))
        }


        return { message: response.content as string }
    }


}

