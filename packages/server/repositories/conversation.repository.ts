import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import {supabase} from '../lib/supabase'

export type ConversationRow = { id: string, created_at: string}

export type MessageRow = {
    role: string;
    content: string;
}

export const conversationRepository = {
    async ensureConversation(conversationId: string, userId: string): Promise<void> {
        const {error} = await supabase
            .from('conversations')
            .upsert(
                {id: conversationId, user_id: userId},
                { onConflict: 'id', ignoreDuplicates: true },
            )
        if (error) throw new Error(`ensureConversation failed: ${error.message}`)
    },

    async addMessages(
        conversationId: string,
        humanText: string,
        aiText: string
    ): Promise<void> {
        const {error} = await supabase
            .from('messages')
            .insert([
                {conversation_id: conversationId, role: 'user', content: humanText},
                {conversation_id: conversationId, role: 'ai', content: aiText}
            ]);
        if (error) throw new Error(`addMessages failed: ${error.message}`);
    }

}