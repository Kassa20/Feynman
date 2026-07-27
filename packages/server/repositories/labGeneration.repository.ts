import { supabase } from '../lib/supabase'

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';
export type TargetEnvironment = 'macos' | 'linux' | 'windows';

export type LabGenerationRow = {
    id: string;
    content: unknown;
}

export const labGenerationRepository = {
    async create(
        topicText: string,
        skillLevel: SkillLevel,
        environment: TargetEnvironment,
        content: unknown,
    ): Promise<LabGenerationRow> {
        const { data, error } = await supabase
            .from('lab_generations')
            .insert({ topic_text: topicText, skill_level: skillLevel, environment, content })
            .select('id, content')
            .single()

        if (error) throw new Error(`create failed: ${error.message}`)
        return data
    },
}
