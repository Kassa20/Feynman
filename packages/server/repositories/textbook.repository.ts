import { supabase } from "../lib/supabase";

export type TextbookChunkInput = {
    sourceFile: string;
    title: string;
    author: string | null;
    page: number | null;
    chunkIndex: number;
    content: string;
    embedding: number[];
}

export type MatchedChunk = {
    id: string;
    content: string;
    title: string;
    page: number | null;
    similarity: number;
}


export const textbookRepository = {
    // Delete-then-insert so re-running ingestion for a file replaces it wholesale.
    // Chunk boundaries move when chunkSize changes, so there is no stable per-chunk
    // identity to upsert against.
    async replaceChunks(sourceFile: string, chunks: TextbookChunkInput[]): Promise<void> {
        const { error: deleteError } = await supabase
            .from('textbook_chunks')
            .delete()
            .eq('source_file', sourceFile)

        if (deleteError) throw new Error(`replaceChunks delete failed: ${deleteError.message}`)

        for (let i = 0; i < chunks.length; i += 200) {
            const { error } = await supabase
                .from('textbook_chunks')
                .insert(
                    chunks.slice(i, i + 200).map((chunk) => ({
                        source_file: chunk.sourceFile,
                        title: chunk.title,
                        author: chunk.author,
                        page: chunk.page,
                        chunk_index: chunk.chunkIndex,
                        content: chunk.content,
                        embedding: chunk.embedding,
                    })),
                )

            if (error) throw new Error(`replaceChunks insert failed: ${error.message}`)
        }
    },

    async matchChunks(embedding: number[], matchCount: number): Promise<MatchedChunk[]> {
    const { data, error } = await supabase.rpc('match_textbook_chunks', {
        query_embedding: embedding,
        match_count: matchCount,
    })

    if (error) throw new Error(`matchChunks failed: ${error.message}`)

    return (data ?? []).map((row: {
        id: string; content: string; title: string; page: number | null; similarity: number;
    }) => ({
        id: row.id,
        content: row.content,
        title: row.title,
        page: row.page,
        similarity: row.similarity,
    }))
},
}

