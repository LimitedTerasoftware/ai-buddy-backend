const express = require('express');
const multer = require('multer');
const db = require('../db');
const { addDocumentToCognee, ingestTextData, ingestMultipleItems } = require('../cognee/client');
const connectorService = require('../connectors/connectorService');
const { isMediaFile } = require('../services/openaiMediaService');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Setup Multer for file uploads
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Multi-file Upload handler (Awaited for full Cognify completion)
router.post('/upload', upload.array('files', 10), async (req, res) => {
    const files = req.files || (req.file ? [req.file] : []);
    
    if (files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    try {
        const uploadedRecords = [];

        for (const file of files) {
            const { filename, originalname, mimetype, size } = file;
            const sourceType = isMediaFile(file.path, mimetype, originalname) ? 'MEDIA_UPLOAD' : 'FILE_UPLOAD';

            const result = await db.query(
                `INSERT INTO documents 
                 (filename, original_name, mime_type, size_bytes, source_type, status) 
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [filename, originalname, mimetype, size, sourceType, 'PENDING']
            );
            const documentRecord = result.rows[0];

            try {
                // Await Cognee ingestion and graph extraction
                const stats = await addDocumentToCognee(file.path, documentRecord);
                await db.query(
                    `UPDATE documents SET 
                     status = 'INGESTED', 
                     chunks_count = $1, 
                     entities_count = $2, 
                     edges_count = $3, 
                     embeddings_count = $4,
                     summaries_count = $5
                     WHERE id = $6`,
                    [
                        stats?.chunks || 1,
                        stats?.entities || 1,
                        stats?.edges || 1,
                        stats?.embeddings || 1,
                        stats?.summaries || 1,
                        documentRecord.id
                    ]
                );
                documentRecord.status = 'INGESTED';
                documentRecord.chunks_count = stats?.chunks || 1;
            } catch (err) {
                console.error(`Failed to ingest document ${documentRecord.id}:`, err);
                await db.query('UPDATE documents SET status = $1, error = $2 WHERE id = $3', ['FAILED', err.message, documentRecord.id]);
                documentRecord.status = 'FAILED';
                documentRecord.error = err.message;
            }

            uploadedRecords.push(documentRecord);
        }

        res.status(201).json({
            message: `Successfully uploaded and ingested ${uploadedRecords.length} file(s).`,
            documents: uploadedRecords
        });

    } catch (err) {
        console.error('Error uploading file(s):', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Ingest from Data Connector (OneDrive / Outlook) - Awaited batch ingestion
router.post('/connectors/ingest', async (req, res) => {
    const { sourceType, items, authToken } = req.body;

    if (!sourceType || !['ONEDRIVE', 'OUTLOOK', 'FILE_UPLOAD'].includes(sourceType)) {
        return res.status(400).json({ error: 'Valid sourceType (ONEDRIVE, OUTLOOK) required' });
    }

    try {
        let itemsToIngest = items;

        if (!itemsToIngest || itemsToIngest.length === 0) {
            if (sourceType === 'ONEDRIVE') {
                itemsToIngest = await connectorService.listOneDriveFiles(authToken);
            } else if (sourceType === 'OUTLOOK') {
                itemsToIngest = await connectorService.listOutlookEmails(authToken);
            }
        }

        const batchList = [];
        const ingestedRecords = [];

        for (const item of itemsToIngest) {
            const originalName = item.name || item.subject || `Item-${item.id}`;
            const sourceId = item.id;
            const textContent = item.content || item.body || item.text || `Content for ${originalName}`;
            const sizeBytes = textContent.length;

            const result = await db.query(
                `INSERT INTO documents 
                 (filename, original_name, mime_type, size_bytes, source_type, source_id, status) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [originalName, originalName, 'text/plain', sizeBytes, sourceType, sourceId, 'PENDING']
            );
            const documentRecord = result.rows[0];
            ingestedRecords.push(documentRecord);

            batchList.push({
                textContent,
                documentRecord
            });
        }

        // Await full batch ingestion & cognify into Cognee
        try {
            const cognifyResult = await ingestMultipleItems(batchList);
            const chunks = cognifyResult?.chunks || 1;
            const entities = cognifyResult?.entities || 1;
            const edges = cognifyResult?.edges || 1;
            const embeddings = cognifyResult?.embeddings || 1;
            const summaries = cognifyResult?.summaries || 1;

            for (const doc of ingestedRecords) {
                await db.query(
                    `UPDATE documents SET 
                     status = 'INGESTED', 
                     chunks_count = $1, 
                     entities_count = $2, 
                     edges_count = $3, 
                     embeddings_count = $4,
                     summaries_count = $5
                     WHERE id = $6`,
                    [chunks, entities, edges, embeddings, summaries, doc.id]
                );
                doc.status = 'INGESTED';
            }
        } catch (err) {
            console.error('Batch connector ingestion failed:', err);
            for (const doc of ingestedRecords) {
                await db.query('UPDATE documents SET status = $1, error = $2 WHERE id = $3', ['FAILED', err.message, doc.id]);
                doc.status = 'FAILED';
                doc.error = err.message;
            }
        }

        res.status(200).json({
            message: `Connector ingestion completed for ${ingestedRecords.length} item(s)`,
            documents: ingestedRecords
        });

    } catch (err) {
        console.error('Error during connector ingestion:', err);
        res.status(500).json({ error: err.message || 'Connector ingestion failed' });
    }
});

// List all documents
router.get('/', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM documents ORDER BY created_at DESC');
        res.json({ documents: result.rows });
    } catch (err) {
        console.error('Error fetching documents:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
