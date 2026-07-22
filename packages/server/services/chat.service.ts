import { HumanMessage} from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { conversationRepository } from '../repositories/conversation.repository';


type chatResponse = {
    message: string;
}

const llm = new ChatOpenAI({model: 'gpt-4o', maxTokens: 500})

export const chatService = {
    async sendMessage(
        prompt: string,
        conversationId: string,
        userId: string,
        labGenerationId: string,
    ): Promise<chatResponse> {
        await conversationRepository.ensureConversation(conversationId, userId);
        const response = await llm.invoke([new HumanMessage(prompt)]);

        await conversationRepository.addMessages(conversationId, prompt, response.content as string)

        return { message: response.content as string }
    }


}

