import { supabase } from '../lib/supabase'
import type { starterCode } from '../services/starterCode.service';

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';
export type TargetEnvironment = 'macos' | 'linux' | 'windows';

export type LabGenerationRow = {
    id: string;
    content: unknown;
}

export type StarterCodeRow = {
    topicText: string;
    starterCode: { language: string; files: { path: string; content: string }[] };
}


export const labGenerationRepository = {
    async create(
        topicText: string,
        skillLevel: SkillLevel,
        environment: TargetEnvironment,
        content: unknown,
        starterCode: unknown | null,
    ): Promise<LabGenerationRow> {
        const { data, error } = await supabase
            .from('lab_generations')
            .insert({ topic_text: topicText, skill_level: skillLevel, environment, content, starter_code: starterCode, })
            .select('id, content')
            .single()

        if (error) throw new Error(`create failed: ${error.message}`)
        return data
    },

    async getStarterCode(labGenerationId: string, userId: string): Promise<StarterCodeRow | null> {
        const {data, error} = await supabase
            .from('lab_generations')
            .select('topic_text, starter_code, conversations!inner(user_id)')
            .eq('id', labGenerationId)
            .eq('conversations.user_id', userId)
            .maybeSingle()
        if (error) throw new Error(`getStarterCode failed: ${error.message}`)
        if (!data?.starter_code) return null

        return {
            topicText: data.topic_text,
            starterCode: data.starter_code as StarterCodeRow['starterCode'],
        }
    }
}

