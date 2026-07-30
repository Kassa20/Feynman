import { supabase } from '../lib/supabase'

export type NoteGenerationResult = {
    id: string;
    labGenerationId: string;
    topic: string;
    question: string;
    title: string;
    content: string;
    createdAt: string;
}

export const notesRepository = {
    async create(
        userId: string,
        labGenerationId: string,
        conversationId: string,
        question: string,
        title: string,
        content: string
    ): Promise<void> {
        const { error } = await supabase
            .from('notes')
            .insert({
                user_id: userId,
                lab_generation_id: labGenerationId,
                conversation_id: conversationId,
                question,
                title,
                content
            })
        if (error) throw new Error(`create failed: ${error.message}`)
    },

    async getNotes(
        userId: string,
    ): Promise<NoteGenerationResult[]> {
        const {data, error} = await supabase
            .from('notes')
            .select('id, lab_generation_id, question, title, content, created_at, lab_generations(topic_text)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })

        if (error) throw new Error(`find user notes failed: ${error.message}`)


        return (data ?? []).map((row) => ({
            id: row.id,
            labGenerationId: row.lab_generation_id,
            topic: (row.lab_generations as { topic_text: string }[] | null)?.[0]?.topic_text ?? 'Untitled lab',
            question: row.question,
            title: row.title,
            content: row.content,
            createdAt: row.created_at,
        }))

    },

    async deleteByConversation(conversationId: string, userId: string): Promise<void> {
        const { error } = await supabase
            .from('notes')
            .delete()
            .eq('conversation_id', conversationId)
            .eq('user_id', userId)

        if (error) throw new Error(`deleteByConversation failed: ${error.message}`)
    }
}