import { supabase } from '../lib/supabase'
import type { SkillLevel } from './labGeneration.repository'

// The stored shape — includes the answer key. Never serialized to the client as-is.
export type StoredQuestion = {
    question: string;
    choices: string[];
    correctIndex: number;
    explanation: string;
}

export type QuizSession = {
    id: string;
    query: string;
    difficulty: SkillLevel;
    questions: StoredQuestion[];
    submittedAt: string | null;
}

export const quizRepository = {
    async createSession(
        userId: string,
        query: string,
        difficulty: SkillLevel,
        questions: StoredQuestion[],
        sourceIds: string[],
    ): Promise<{ id: string }> {
        const { data, error } = await supabase
            .from('quiz_sessions')
            .insert({
                user_id: userId,
                query,
                difficulty,
                questions,
                source_ids: sourceIds,
            })
            .select('id')
            .single()

        if (error) throw new Error(`createSession failed: ${error.message}`)
        return data
    },

    // Ownership is filtered here, not by RLS — the service-role client bypasses it.
    async getSession(sessionId: string, userId: string): Promise<QuizSession | null> {
        const { data, error } = await supabase
            .from('quiz_sessions')
            .select('id, query, difficulty, questions, submitted_at')
            .eq('id', sessionId)
            .eq('user_id', userId)
            .maybeSingle()

        if (error) throw new Error(`getSession failed: ${error.message}`)
        if (!data) return null

        return {
            id: data.id,
            query: data.query,
            difficulty: data.difficulty,
            questions: data.questions as StoredQuestion[],
            submittedAt: data.submitted_at,
        }
    },

    async recordResult(
        sessionId: string,
        score: number,
        total: number,
        answers: number[],
    ): Promise<void> {
        const { error } = await supabase
            .from('quiz_sessions')
            .update({ score, total, answers, submitted_at: new Date().toISOString() })
            .eq('id', sessionId)

        if (error) throw new Error(`recordResult failed: ${error.message}`)
    },
}
