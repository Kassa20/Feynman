import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import {supabase} from '../lib/supabase'

export type ConversationRow = { id: string, created_at: string}

export type MessageRow = {
    role: string;
    content: string;
}

export type ConversationSummary = {
    id: string;
    createdAt: string;
    title: string;
}

export const conversationRepository = {
    async listByUser(userId: string): Promise<ConversationSummary[]> {
        const { data, error } = await supabase
            .from('conversations')
            .select('id, created_at, messages(content, created_at)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .order('created_at', { referencedTable: 'messages', ascending: true })
            .limit(1, { foreignTable: 'messages' })

        if (error) throw new Error(`listByUser failed: ${error.message}`)

        return (data ?? []).map((row) => {
            const firstMessage = (row.messages as { content: string }[] | null)?.[0]
            const title = firstMessage?.content?.trim().slice(0, 60) || 'New conversation'
            return { id: row.id, createdAt: row.created_at, title }
        })
    },

    async getMessages(conversationId: string, userId: string): Promise<MessageRow[] | null> {
        const { data, error } = await supabase
            .from('conversations')
            .select('id, messages(role, content, created_at)')
            .eq('id', conversationId)
            .eq('user_id', userId)
            .order('created_at', { referencedTable: 'messages', ascending: true })
            .maybeSingle()

        if (error) throw new Error(`getMessages failed: ${error.message}`)
        if (!data) return null

        return (data.messages as MessageRow[] | null) ?? []
    },

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