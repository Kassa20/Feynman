import { HumanMessage} from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { conversationRepository } from '../repositories/conversation.repository';


type chatResponse = {
    message: string;
}

const llm = new ChatOpenAI({model: 'gpt-4o', maxTokens: 500})

export class ConversationNotFoundError extends Error {}

export const chatService = {
    async sendMessage(
        prompt: string,
        conversationId: string,
        userId: string,
        labGenerationId: string,
    ): Promise<chatResponse> {
        const chatHistory = await conversationRepository.getMessages(conversationId, userId);
        if (chatHistory === null) {
            throw new ConversationNotFoundError(`Conversation ${conversationId} not found`);
        }
        const response = await llm.invoke([new HumanMessage(prompt), ...chatHistory]);

        await conversationRepository.addMessages(conversationId, prompt, response.content as string)

        return { message: response.content as string }
    }


}

