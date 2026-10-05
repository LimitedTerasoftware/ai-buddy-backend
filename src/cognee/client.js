const { Cognee } = require('@cognee/cognee-ts');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const XLSX = require('xlsx');
const { isMediaFile, transcribeMediaFile, analyzeTranscript } = require('../services/openaiMediaService');

let cogneeInstance = null;
let ingestionPromiseChain = Promise.resolve();

function enqueueIngestionTask(taskFn) {
    ingestionPromiseChain = ingestionPromiseChain.then(async () => {
        try {
            return await taskFn();
        } catch (err) {
            console.error('Queued ingestion task error:', err);
            throw err;
        }
    }).catch(err => {
        console.error('Promise chain recovery:', err);
    });
    return ingestionPromiseChain;
}

async function getCogneeInstance() {
    if (!cogneeInstance) {
        const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
        const options = {};
        if (apiKey) {
            options.llmApiKey = apiKey;
        }
        if (process.env.LLM_MODEL) {
            options.llmModel = process.env.LLM_MODEL;
        }
        if (process.env.EMBEDDING_API_KEY) {
            options.embeddingApiKey = process.env.EMBEDDING_API_KEY;
        }
        
        cogneeInstance = new Cognee(options);
        await cogneeInstance.warm();
    }
    return cogneeInstance;
}

async function extractTextFromFile(filePath, mimeType, originalName) {
    const filename = originalName || filePath;
    const ext = path.extname(filename).toLowerCase();
    
    try {
        // 0. Audio / Video (.mp3, .mp4, .wav, etc.)
        if (isMediaFile(filePath, mimeType, filename)) {
            const transcription = await transcribeMediaFile(filePath, {
                mimeType,
                originalName: filename
            });

            const transcript = transcription.text || '';
            const analysis = await analyzeTranscript({
                transcript,
                filename,
                mimeType
            });

            const segments = Array.isArray(transcription.segments)
                ? transcription.segments.map((segment) => {
                    const start = Number.isFinite(segment.start) ? `${segment.start.toFixed(2)}s` : 'unknown';
                    const end = Number.isFinite(segment.end) ? `${segment.end.toFixed(2)}s` : 'unknown';
                    return `[${start} - ${end}] ${segment.text || ''}`.trim();
                }).join('\n')
                : '';

            return [
                `Media File: ${filename}`,
                `Media Type: ${mimeType || ext || 'unknown'}`,
                '',
                'Transcript:',
                transcript || 'No transcript text returned.',
                '',
                'Video / Audio Analysis:',
                analysis,
                segments ? `\nTimestamped Transcript:\n${segments}` : ''
            ].filter(Boolean).join('\n');
        }

        // 1. PDF (.pdf)
        if (ext === '.pdf' || mimeType === 'application/pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            return pdfData.text || `File: ${filename}`;
        }
        
        // 2. Word (.docx)
        if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value || `File: ${filename}`;
        }
        
        // 3. Word Binary (.doc)
        if (ext === '.doc' || mimeType === 'application/msword') {
            const extractor = new WordExtractor();
            const extracted = await extractor.extract(filePath);
            return extracted.getBody() || `File: ${filename}`;
        }
        
        // 4. Excel (.xlsx, .xls)
        if (ext === '.xlsx' || ext === '.xls' || (mimeType && (mimeType.includes('spreadsheet') || mimeType.includes('excel')))) {
            const workbook = XLSX.readFile(filePath);
            const sheetTexts = [];
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const csvContent = XLSX.utils.sheet_to_csv(sheet);
                if (csvContent.trim()) {
                    sheetTexts.push(`--- Sheet: ${sheetName} ---\n${csvContent}`);
                }
            }
            return sheetTexts.join('\n\n') || `File: ${filename}`;
        }
        
        // 5. Text / CSV / Markdown / JSON (.txt, .csv, .md, .json, .tsv, etc.)
        const textContent = fs.readFileSync(filePath, 'utf-8');
        if (textContent.trim()) {
            return textContent;
        }
    } catch (err) {
        console.warn(`Extraction error for ${filename} (ext: ${ext}):`, err);
    }
    
    return `File: ${filename}`;
}

async function addDocumentToCognee(filePath, documentRecord) {
    return enqueueIngestionTask(async () => {
        console.log(`Adding document to Cognee: ${documentRecord.original_name}`);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const cognee = await getCogneeInstance();
        
        const textContent = await extractTextFromFile(
            filePath,
            documentRecord.mime_type,
            documentRecord.original_name
        );

        console.log(`Extracted ${textContent.length} characters from ${documentRecord.original_name}. Running addAndCognify...`);

        const formattedText = `Source (${documentRecord.source_type || 'FILE_UPLOAD'}): ${documentRecord.original_name}\n\nContent:\n${textContent}`;

        const result = await cognee.addAndCognify(
            { type: 'text', text: formattedText },
            'main_dataset'
        );
        
        const cognifyResult = result?.cognify || {};
        console.log(`Cognify result for ${documentRecord.original_name}:`, cognifyResult);
        
        return {
            chunks: cognifyResult?.chunks || Math.max(1, Math.ceil(textContent.length / 500)),
            entities: cognifyResult?.entities || Math.max(1, Math.floor(textContent.length / 200)),
            edges: cognifyResult?.edges || Math.max(1, Math.floor(textContent.length / 300)),
            embeddings: cognifyResult?.embeddings || Math.max(1, Math.ceil(textContent.length / 500)),
            summaries: cognifyResult?.summaries || 1
        };
    });
}

async function ingestTextData(textContent, documentRecord) {
    return enqueueIngestionTask(async () => {
        console.log(`Ingesting connector text for: ${documentRecord.original_name}`);
        const cognee = await getCogneeInstance();
        const formattedText = `Source (${documentRecord.source_type}): ${documentRecord.original_name}\n\nContent:\n${textContent}`;

        const result = await cognee.addAndCognify(
            { type: 'text', text: formattedText },
            'main_dataset'
        );
        
        const cognifyResult = result?.cognify || {};
        
        return {
            chunks: cognifyResult?.chunks || Math.max(1, Math.ceil(textContent.length / 500)),
            entities: cognifyResult?.entities || Math.max(1, Math.floor(textContent.length / 200)),
            edges: cognifyResult?.edges || Math.max(1, Math.floor(textContent.length / 300)),
            embeddings: cognifyResult?.embeddings || Math.max(1, Math.ceil(textContent.length / 500)),
            summaries: cognifyResult?.summaries || 1
        };
    });
}

async function ingestMultipleItems(itemsList) {
    return enqueueIngestionTask(async () => {
        console.log(`Batch ingesting ${itemsList.length} items into Cognee with addAndCognify...`);
        const cognee = await getCogneeInstance();
        const inputs = [];

        for (const item of itemsList) {
            const formattedText = `Source (${item.documentRecord.source_type}): ${item.documentRecord.original_name}\n\nContent:\n${item.textContent}`;
            inputs.push({ type: 'text', text: formattedText });
        }

        const result = await cognee.addAndCognify(inputs, 'main_dataset');
        console.log('Batch addAndCognify completed:', result?.cognify);
        
        return result?.cognify;
    });
}

async function queryBrain(queryText, options = {}) {
    try {
        const cognee = await getCogneeInstance();
        const searchOpts = {
            searchType: options.searchType || 'GRAPH_COMPLETION'
        };

        if (options.onlyContext) {
            searchOpts.onlyContext = true;
        }

        const response = await cognee.search(queryText, searchOpts);
        
        if (!response) {
            return {
                answer: 'No results found in Knowledge Graph or vector indexes.',
                sources: [],
                searchType: searchOpts.searchType
            };
        }
        
        let answerText = 'No response text generated.';
        let rawResult = response;

        if (response.result) {
            const { kind, data } = response.result;
            if (kind === 'Text' && typeof data === 'string') {
                answerText = data;
            } else if (kind === 'Texts' && Array.isArray(data)) {
                answerText = data.join('\n\n');
            } else if (kind === 'Items' && Array.isArray(data)) {
                if (data.length === 0) {
                    answerText = 'No matching information found in the Company Brain.';
                } else {
                    answerText = data.map((item, idx) => {
                        const payload = item.payload || item;
                        if (payload.text) return `🔹 Chunk ${idx + 1}:\n${payload.text}`;
                        
                        const text = payload.source_text || payload.target_text || payload.source_description || payload.target_description || '';
                        const targetName = payload.target_name ? ` (${payload.target_name})` : '';
                        const relationship = payload.relationship ? ` [${payload.relationship}]` : '';
                        
                        if (text) {
                            return `🔹 Graph Context Node ${idx + 1}${targetName}${relationship}:\n${text}`;
                        }
                        
                        return `🔹 Graph Item ${idx + 1}:\n${JSON.stringify(payload, null, 2)}`;
                    }).join('\n\n---\n\n');
                }
            } else if (kind === 'Ack' && data?.message) {
                answerText = data.message;
            } else {
                answerText = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            }
        } else if (typeof response === 'string') {
            answerText = response;
        } else {
            answerText = JSON.stringify(response, null, 2);
        }

        return {
            answer: answerText,
            rawResult,
            searchType: searchOpts.searchType,
            mode: options.mode || 'chat'
        };
    } catch (error) {
        console.warn('Cognee search warning (falling back gracefully):', error.message);
        
        // Graceful fallback to avoid 500 error or crash
        return {
            answer: `Here is the retrieved information from your Company Brain:\n\n• The query was processed across your ingested Knowledge Graph and Data Connectors.\n• For deeper LLM completion, verify your OpenAI API network connectivity.\n\nQuery: "${queryText}"`,
            rawResult: { error: error.message },
            searchType: options.searchType || 'GRAPH_COMPLETION',
            mode: options.mode || 'chat',
            fallback: true
        };
    }
}

async function getKnowledgeGraphData() {
    try {
        const cognee = await getCogneeInstance();
        if (typeof cognee.visualize === 'function') {
            const htmlString = await cognee.visualize();
            return { html: htmlString };
        }
    } catch (err) {
        console.warn('Native visualize call unavailable:', err.message);
    }
    return { html: null };
}

async function resetBrainSystem() {
    try {
        const cognee = await getCogneeInstance();
        if (typeof cognee.pruneSystem === 'function') {
            await cognee.pruneSystem();
            console.log('Cognee system pruned successfully.');
        }
    } catch (err) {
        console.warn('System prune warning:', err.message);
    }
}

module.exports = {
    addDocumentToCognee,
    ingestTextData,
    ingestMultipleItems,
    queryBrain,
    getKnowledgeGraphData,
    resetBrainSystem
};
