const fs = require('fs');
const path = require('path');

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

function getApiKey() {
    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY or LLM_API_KEY is required for media and voice processing');
    }
    return apiKey;
}

async function fetchOpenAI(url, options) {
    try {
        return await fetch(url, options);
    } catch (error) {
        const cause = error.cause;
        const detail = cause?.code || cause?.message || error.message;
        throw new Error(`Could not connect to OpenAI: ${detail}`, { cause: error });
    }
}

function getMimeType(filePath, fallbackMimeType) {
    if (fallbackMimeType) return fallbackMimeType;

    const ext = path.extname(filePath).toLowerCase();
    const mimeByExt = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.mp4': 'video/mp4',
        '.m4a': 'audio/mp4',
        '.mpeg': 'audio/mpeg',
        '.mpga': 'audio/mpeg',
        '.webm': 'audio/webm',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac'
    };

    return mimeByExt[ext] || 'application/octet-stream';
}

function isMediaFile(filePath, mimeType, originalName) {
    const filename = originalName || filePath;
    const ext = path.extname(filename).toLowerCase();
    return ['.mp3', '.mp4', '.wav', '.m4a', '.mpeg', '.mpga', '.webm', '.ogg', '.flac'].includes(ext)
        || (mimeType && (mimeType.startsWith('audio/') || mimeType.startsWith('video/')));
}

function getOutputText(responseJson) {
    if (responseJson.output_text) return responseJson.output_text;

    const output = responseJson.output || [];
    const parts = [];
    for (const item of output) {
        for (const content of item.content || []) {
            if (content.text) parts.push(content.text);
        }
    }
    return parts.join('\n').trim();
}

async function transcribeMediaFile(filePath, options = {}) {
    const buffer = fs.readFileSync(filePath);
    const blob = new Blob([buffer], { type: getMimeType(filePath, options.mimeType) });
    const form = new FormData();

    form.append('file', blob, options.originalName || path.basename(filePath));
    form.append('model', process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe');
    form.append('response_format', 'verbose_json');

    if (options.language) {
        form.append('language', options.language);
    }

    const response = await fetchOpenAI(`${OPENAI_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${getApiKey()}`
        },
        body: form
    });

    const bodyText = await response.text();
    if (!response.ok) {
        throw new Error(`OpenAI transcription failed (${response.status}): ${bodyText}`);
    }

    return JSON.parse(bodyText);
}

async function analyzeTranscript({ transcript, filename, mimeType }) {
    if (!transcript || !transcript.trim()) {
        return 'No spoken transcript was detected in this media file.';
    }

    const response = await fetchOpenAI(`${OPENAI_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${getApiKey()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: process.env.OPENAI_MEDIA_ANALYSIS_MODEL || process.env.LLM_MODEL || 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: [
                        {
                            type: 'input_text',
                            text: 'You analyze uploaded audio or video transcripts for a knowledge graph. Produce concise Markdown with summary, topics, entities, decisions, action items, risks, and useful chatbot facts.'
                        }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: `File: ${filename}\nMIME type: ${mimeType || 'unknown'}\n\nTranscript:\n${transcript}`
                        }
                    ]
                }
            ]
        })
    });

    const bodyText = await response.text();
    if (!response.ok) {
        throw new Error(`OpenAI media analysis failed (${response.status}): ${bodyText}`);
    }

    return getOutputText(JSON.parse(bodyText)) || 'Transcript analyzed successfully.';
}

async function createRealtimeClientSecret(options = {}) {
    const instructions = options.instructions || [
        'You are the Company Brain voice assistant.',
        'Answer briefly and naturally.',
        'When the user asks about uploaded knowledge, tell them to use the text chat if live retrieval is required.',
        'Do not claim you have access to private data unless it was provided in the conversation.'
    ].join(' ');

    const response = await fetchOpenAI(`${OPENAI_BASE_URL}/realtime/client_secrets`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${getApiKey()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            expires_after: {
                anchor: 'created_at',
                seconds: Number(process.env.OPENAI_REALTIME_SECRET_TTL || 600)
            },
            session: {
                type: 'realtime',
                model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini',
                output_modalities: ['audio'],
                instructions,
                audio: {
                    input: {
                        transcription: {
                            model: process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe'
                        },
                        turn_detection: {
                            type: 'semantic_vad',
                            create_response: true,
                            interrupt_response: true,
                            eagerness: 'auto'
                        }
                    },
                    output: {
                        speed: options.speed ?? 1,
                        voice: process.env.OPENAI_REALTIME_VOICE || 'marin'
                    }
                }
            }
        })
    });

    const bodyText = await response.text();
    if (!response.ok) {
        throw new Error(`OpenAI realtime client secret failed (${response.status}): ${bodyText}`);
    }

    return JSON.parse(bodyText);
}

module.exports = {
    isMediaFile,
    transcribeMediaFile,
    analyzeTranscript,
    createRealtimeClientSecret
};
