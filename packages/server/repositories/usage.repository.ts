import { supabase } from '../lib/supabase'

export type UsageAction = 'lab_generate' | 'chat_message' | 'quiz_start';

export const usageRepository = {
    async countSince(userId: string, action: UsageAction, since: Date): Promise<number> {
        const { count, error } = await supabase
            .from('usage_events')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('action', action)
            .gte('created_at', since.toISOString())

        if (error) throw new Error(`countSince failed: ${error.message}`)
        return count ?? 0
    },

    async getLimit(userId: string, action: UsageAction): Promise<number | null> {
        const { data, error } = await supabase
            .from('user_limits')
            .select('limit_per_window')
            .eq('user_id', userId)
            .eq('action', action)
            .maybeSingle()

        if (error) throw new Error(`getLimit failed: ${error.message}`)
        return data?.limit_per_window ?? null
    },

    async record(userId: string, action: UsageAction): Promise<void> {
        const { error } = await supabase
            .from('usage_events')
            .insert({ user_id: userId, action })

        if (error) throw new Error(`record failed: ${error.message}`)
    },

    async oldestSince(userId: string, action: UsageAction, since: Date): Promise<Date | null> {
        const { data, error } = await supabase
            .from('usage_events')
            .select('created_at')
            .eq('user_id', userId)
            .eq('action', action)
            .gte('created_at', since.toISOString())
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle()

        if (error) throw new Error(`oldestSince failed: ${error.message}`)
        return data ? new Date(data.created_at) : null
    },
}
