
import {supabase} from '../lib/supabase'

export type MessageRow = {
    role: string;
    content: string;
}

export type ConversationSummary = {
    id: string;
    createdAt: string;
    title: string;
}

export type ConversationMessages = {
    messages: MessageRow[];
    starterCodeLabId: string | null;
}

export const conversationRepository = {
    async getConversations(userId: string): Promise<ConversationSummary[]> {
        const { data, error } = await supabase
            .from('conversations')
            .select('id, created_at, messages(content, created_at)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .order('created_at', { referencedTable: 'messages', ascending: true })
            .limit(1, { foreignTable: 'messages' })

        if (error) throw new Error(`getConversations failed: ${error.message}`)

        return (data ?? []).map((row) => {
            const firstMessage = (row.messages as { content: string }[] | null)?.[0]
            const title = firstMessage?.content?.trim().slice(0, 60) || 'New conversation'
            return { id: row.id, createdAt: row.created_at, title }
        })
    },

    async getMessages(conversationId: string, userId: string): Promise<ConversationMessages | null> {
        const { data, error } = await supabase
            .from('conversations')
            .select('id, lab_generation_id, messages(role, content, created_at), lab_generations(starter_code)')
            .eq('id', conversationId)
            .eq('user_id', userId)
            .order('created_at', { referencedTable: 'messages', ascending: true })
            .maybeSingle()

        if (error) throw new Error(`getMessages failed: ${error.message}`)
        if (!data) return null

        const lab = data.lab_generations as unknown as { starter_code: unknown } | null

        return {
            messages: (data.messages as MessageRow[] | null) ?? [],
            // Only expose the id when there is actually something to download.
            starterCodeLabId: lab?.starter_code ? data.lab_generation_id : null,
        }
    },

    async ensureConversation(conversationId: string, userId: string, labGenerationId: string): Promise<void> {
        const {error} = await supabase
            .from('conversations')
            .upsert(
                {id: conversationId, user_id: userId, lab_generation_id: labGenerationId},
                { onConflict: 'id', ignoreDuplicates: true },
            )
        if (error) throw new Error(`ensureConversation failed: ${error.message}`)
    },

    async getLabGenerationId(conversationId: string, userId: string): Promise<string | null> {
        const { data, error } = await supabase
            .from('conversations')
            .select('lab_generation_id')
            .eq('id', conversationId)
            .eq('user_id', userId)
            .maybeSingle()

        if (error) throw new Error(`getLabGenerationId failed: ${error.message}`)
        return data?.lab_generation_id ?? null
    },

    async addMessages(
        conversationId: string,
        humanText: string | null,
        aiText: string
    ): Promise<void> {
        const rows = humanText === null
            ? [{conversation_id: conversationId, role: 'ai', content: aiText}]
            : [
                {conversation_id: conversationId, role: 'user', content: humanText},
                {conversation_id: conversationId, role: 'ai', content: aiText}
            ]
        const {error} = await supabase
            .from('messages')
            .insert(rows);
        if (error) throw new Error(`addMessages failed: ${error.message}`);
    }

}