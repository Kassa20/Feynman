import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { OpenAIEmbeddings } from '@langchain/openai';
import { textbookRepository, type TextbookChunkInput } from '../repositories/textbook.repository';

type ParsedPdf = {
    title: string;
    author: string | null;
    pages: Document[];
};

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data/textbooks');
const EMBED_BATCH = 100;

const embeddings = new OpenAIEmbeddings({ model: 'text-embedding-3-small' });

const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
});

// PDF text layers often contain NUL bytes, which Postgres `text` columns cannot
// store — PostgREST rejects them as "unsupported Unicode escape sequence".
const stripNulls = (text: string): string => text.replace(/\u0000/g, '');

async function loadPdf(filePath: string): Promise<ParsedPdf> {
    const parser = new PDFParse({ data: new Uint8Array(readFileSync(filePath)) });
    try {
        // The PDF /Info dictionary, typed `any` by pdf-parse since its contents
        // are whatever the producing tool wrote.
        const { info } = await parser.getInfo() as { info?: { Title?: string; Author?: string } };
        const { pages } = await parser.getText();

        return {
            // LaTeX-produced PDFs often carry an empty or junk /Info Title, so the
            // filename is the fallback — it is what shows up in quiz citations.
            title: stripNulls(info?.Title?.trim() || '') || basename(filePath, '.pdf'),
            author: stripNulls(info?.Author?.trim() || '') || null,
            pages: pages.map(
                (page) => new Document({
                    pageContent: stripNulls(page.text),
                    metadata: { page: page.num },
                }),
            ),
        };
    } finally {
        // Without this the parser's worker keeps the process alive.
        await parser.destroy();
    }
}

async function ingest(file: string): Promise<void> {
    console.log(`\n[${file}] parsing…`);
    const { title, author, pages } = await loadPdf(join(DATA_DIR, file));
    console.log(`[${file}] title: "${title}"${author ? ` — ${author}` : ''}`);

    const textLength = pages.reduce((sum, page) => sum + page.pageContent.trim().length, 0);
    if (textLength < 1000) {
        // A scanned PDF has no text layer and yields near-empty pages. Silently
        // ingesting it would produce a corpus that retrieves nothing.
        throw new Error(
            `${file} produced only ${textLength} characters across ${pages.length} pages — ` +
            `it is probably a scanned PDF with no text layer.`,
        );
    }

    const splits = await splitter.splitDocuments(pages);
    console.log(`[${file}] ${pages.length} pages → ${splits.length} chunks, embedding…`);

    const chunks: TextbookChunkInput[] = [];

    for (let i = 0; i < splits.length; i += EMBED_BATCH) {
        const batch = splits.slice(i, i + EMBED_BATCH);
        const vectors = await embeddings.embedDocuments(batch.map((doc) => doc.pageContent));

        batch.forEach((doc, offset) => {
            chunks.push({
                sourceFile: file,
                title,
                author,
                page: (doc.metadata.page as number | undefined) ?? null,
                chunkIndex: i + offset,
                content: doc.pageContent,
                embedding: vectors[offset]!,
            });
        });

        console.log(`[${file}] embedded ${Math.min(i + EMBED_BATCH, splits.length)}/${splits.length}`);
    }

    await textbookRepository.replaceChunks(file, chunks);
    console.log(`[${file}] stored ${chunks.length} chunks`);
}

const files = readdirSync(DATA_DIR).filter((file) => file.toLowerCase().endsWith('.pdf'));

if (files.length === 0) {
    throw new Error(`No PDFs found in ${DATA_DIR} — drop textbook PDFs there and re-run.`);
}

for (const file of files) {
    await ingest(file);
}

console.log('\nDone.');
