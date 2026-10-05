const express = require('express');
const { queryBrain, getKnowledgeGraphData } = require('../cognee/client');
const db = require('../db');
const dbConnectorService = require('../connectors/dbConnectorService');
const aiQueryService = require('../connectors/aiQueryService');

const router = express.Router();

// Query Brain (Independent Search Mode or Chat / Q&A Mode)
router.post('/query', async (req, res) => {
    const { query, searchType, mode, onlyContext } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Query is required' });
    }

    try {
        // Fetch database connections with credentials for query resolving
        const dbConns = await db.query('SELECT * FROM database_connections ORDER BY created_at DESC');
        const dbDocs = await db.query('SELECT original_name, source_type, status, metadata FROM documents WHERE status = $1 ORDER BY created_at DESC', ['INGESTED']);
        
        const bySource = {};
        dbDocs.rows.forEach(d => {
            const src = d.source_type || 'FILE_UPLOAD';
            if (!bySource[src]) bySource[src] = new Set();
            bySource[src].add(d.original_name);
        });

        const onedriveFiles = Array.from(bySource['ONEDRIVE'] || []);
        const outlookFiles = Array.from(bySource['OUTLOOK'] || []);
        const uploadFiles = Array.from(bySource['FILE_UPLOAD'] || []);
        const mediaFiles = Array.from(bySource['MEDIA_UPLOAD'] || []);
        const databaseTables = Array.from(bySource['DATABASE'] || []);
        const totalUnique = onedriveFiles.length + outlookFiles.length + uploadFiles.length + mediaFiles.length + databaseTables.length;

        const queryLower = query.toLowerCase();

        // 1. Natural Language SQL / AI Analytics Query Resolver (Tickets, Status, Counts, Dates, Aggregations)
        const isDataAnalyticsQuery = /dashboard|ticket|completed|pending|not started|notstarted|ongoing|hold|onhold|yesterday|today|attendance|provider|team|material|stock|how many|count|total|booking|request|downreason|category|relationship|related|foreign key|join|schema/i.test(queryLower) && 
                                     !/how many (files|documents|onedrive|outlook|uploads)|list files|show files/i.test(queryLower);

        const connectedDb = dbConns.rows.find(c => c.status === 'CONNECTED') || dbConns.rows[0];

        if (isDataAnalyticsQuery && connectedDb) {
            try {
                console.log(`[brain.js] Routing query to AIQueryService (NL2SQL) for database: ${connectedDb.name}`);
                const aiResult = await aiQueryService.processNLQuery(connectedDb, query);
                if (aiResult && aiResult.answer) {
                    return res.json({
                        answer: aiResult.answer,
                        tableData: aiResult.tableData,
                        sources: aiResult.sources,
                        searchType: searchType || 'GRAPH_COMPLETION',
                        mode: mode || 'chat',
                        sqlQuery: aiResult.sqlQuery
                    });
                }
            } catch (nlErr) {
                console.warn('[brain.js] NL2SQL processing warning (continuing to fallbacks):', nlErr.message);
            }
        }

        const isInventoryQuery = /^(what documents|what files|which documents|which files|show documents|show files|documents on|files on|what tables|list tables|which tables|connected|what database|database tables|show tables)$/i.test(query.trim()) ||
                                 /overview of company brain|list all sources|show all connected sources/i.test(queryLower);

        let targetSourceType = null;
        if (/onedrive|one\s*drive|drvie|drive/i.test(queryLower)) {
            targetSourceType = 'ONEDRIVE';
        } else if (/outlook|email|mail/i.test(queryLower)) {
            targetSourceType = 'OUTLOOK';
        } else if (/database|table|sql|schema|postgres|mysql|sqlite/i.test(queryLower)) {
            targetSourceType = 'DATABASE';
        } else if (/media|audio|video|mp3|mp4|wav|transcript|recording/i.test(queryLower)) {
            targetSourceType = 'MEDIA_UPLOAD';
        } else if (/upload|file/i.test(queryLower)) {
            targetSourceType = 'FILE_UPLOAD';
        }

        // Build sources list
        const parsedSources = [];
        const seenTitles = new Set();

        if (targetSourceType && bySource[targetSourceType]) {
            Array.from(bySource[targetSourceType]).forEach(title => {
                if (!seenTitles.has(title)) {
                    seenTitles.add(title);
                    parsedSources.push({
                        title,
                        sourceType: targetSourceType,
                        relevance: '0.98'
                    });
                }
            });
        }

        if (parsedSources.length === 0) {
            const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
            let matchingSources = dbDocs.rows.filter(doc => {
                const nameLower = doc.original_name.toLowerCase();
                return queryTerms.some(term => nameLower.includes(term));
            });

            if (matchingSources.length === 0) {
                matchingSources = dbDocs.rows.slice(0, 5);
            }

            matchingSources.slice(0, 5).forEach(doc => {
                if (!seenTitles.has(doc.original_name)) {
                    seenTitles.add(doc.original_name);
                    parsedSources.push({
                        title: doc.original_name,
                        sourceType: doc.source_type || 'FILE_UPLOAD',
                        relevance: '0.92'
                    });
                }
            });
        }

        // 2. Specific Table Records / Data Query Resolver
        const isTableRecordQuery = /record|row|data in|data from|show me|give me|view table|select|sample|find in|list from|shome me|fetch|display|get/i.test(query);
        if (isTableRecordQuery) {
            const limitMatch = query.match(/(\d+)\s*(records?|rows?|items?|entries)?/i);
            const limit = limitMatch ? Math.min(Number(limitMatch[1]), 25) : 5;

            const cleanQuery = queryLower.replace(/[^a-z0-9_ ]/g, ' ');
            const queryWords = cleanQuery.split(/\s+/).filter(Boolean);

            const candidates = [];

            for (const conn of dbConns.rows) {
                try {
                    const tables = await dbConnectorService.listTables(conn);
                    for (const t of tables) {
                        const tName = t.tableName.toLowerCase();
                        const tBase = tName.replace(/s$/, '');
                        let score = 0;

                        if (queryLower.includes(tName)) {
                            score = 100;
                        } else {
                            const matchedWord = queryWords.find(w => {
                                const wBase = w.replace(/s$/, '');
                                return w === tName || (wBase.length > 2 && (wBase === tBase || tName.includes(wBase)));
                            });
                            if (matchedWord) {
                                score = 95;
                            } else if ((queryLower.includes('user') || queryLower.includes('users') || queryLower.includes('account') || queryLower.includes('people')) && 
                                       ['admins', 'users', 'accounts', 'providers', 'admin_users'].includes(tName)) {
                                score = (tName === 'admins' || tName === 'users') ? 92 : 80;
                            } else if (queryLower.includes('admin') && tName === 'admins') {
                                score = 95;
                            } else if (tBase.length > 3 && queryLower.includes(tBase)) {
                                score = 85;
                            }
                        }

                        if (score > 0) {
                            // Give extra weight to tables with actual rows
                            if (t.rowCount > 0) score += 20;
                            candidates.push({ table: t.tableName, conn, score, rowCount: t.rowCount });
                        }
                    }
                } catch (e) {
                    console.warn(`[brain.js] Failed to list tables for ${conn.name}:`, e.message);
                }
            }

            candidates.sort((a, b) => b.score - a.score);

            if (candidates.length > 0) {
                const best = candidates[0];
                try {
                    const rows = await dbConnectorService.getTableRows(best.conn, best.table, limit);
                    let tableMarkdown = '';
                    let displayCols = [];

                    if (rows.length > 0) {
                        const allCols = Object.keys(rows[0]);
                        // Filter out long password hashes/tokens for clean display
                        displayCols = allCols.filter(c => !['password', 'remember_token', 'permissions'].includes(c)).slice(0, 8);
                        
                        const headerRow = `| ${displayCols.join(' | ')} |`;
                        const dividerRow = `| ${displayCols.map(() => '---').join(' | ')} |`;
                        const dataRows = rows.map(r => {
                            const cells = displayCols.map(c => {
                                const val = r[c];
                                if (val === null || val === undefined) return '*NULL*';
                                if (typeof val === 'object') return JSON.stringify(val);
                                const str = String(val);
                                return str.length > 35 ? str.substring(0, 32) + '...' : str;
                            });
                            return `| ${cells.join(' | ')} |`;
                        }).join('\n');

                        tableMarkdown = `### 📋 Retrieved ${rows.length} Record(s) from \`${best.table}\` Table\n` +
                            `**Database Source:** ${best.conn.name} (${best.conn.db_type.toUpperCase()})\n\n` +
                            `${headerRow}\n${dividerRow}\n${dataRows}\n\n` +
                            `*(Showing top ${rows.length} record(s) from ${best.table})*`;
                    } else {
                        tableMarkdown = `### 📋 Table: \`${best.table}\`\n` +
                            `**Database Source:** ${best.conn.name} (${best.conn.db_type.toUpperCase()})\n\n` +
                            `This table currently contains **0 records** (empty table).`;
                    }

                    return res.json({
                        answer: tableMarkdown,
                        tableData: rows.length > 0 ? {
                            tableName: best.table,
                            dbSource: best.conn.name,
                            dbType: best.conn.db_type,
                            columns: displayCols,
                            rows: rows.map(r => {
                                const cleanRow = {};
                                displayCols.forEach(c => {
                                    cleanRow[c] = r[c];
                                });
                                return cleanRow;
                            }),
                            totalRows: rows.length
                        } : null,
                        sources: [{
                            title: `Table: ${best.table} (${best.conn.name})`,
                            sourceType: 'DATABASE',
                            relevance: '0.99'
                        }],
                        searchType: searchType || 'GRAPH_COMPLETION',
                        mode: mode || 'chat'
                    });
                } catch (err) {
                    console.warn(`Error fetching records for ${best.table}:`, err.message);
                }
            } else {
                // If no exact table name matched, search for terms across all tables in connected databases
                const searchKeywords = query.replace(/(show me|give me|find|search for|search|get|list|display|records?|rows?|in database|from database|data)/gi, '').trim();
                if (searchKeywords.length >= 2) {
                    for (const conn of dbConns.rows) {
                        try {
                            const uniRes = await dbConnectorService.searchDatabaseUniversal(conn, searchKeywords, {
                                maxResultsPerTable: limit,
                                maxTablesToReturn: 3
                            });

                            if (uniRes && uniRes.tables && uniRes.tables.length > 0) {
                                const topTable = uniRes.tables[0];
                                const displayCols = topTable.allColumns.slice(0, 8);
                                const headerRow = `| ${displayCols.join(' | ')} |`;
                                const dividerRow = `| ${displayCols.map(() => '---').join(' | ')} |`;
                                const dataRows = topTable.rows.map(r => {
                                    const cells = displayCols.map(c => {
                                        const val = r[c];
                                        if (val === null || val === undefined) return '*NULL*';
                                        if (typeof val === 'object') return JSON.stringify(val);
                                        const str = String(val);
                                        return str.length > 35 ? str.substring(0, 32) + '...' : str;
                                    });
                                    return `| ${cells.join(' | ')} |`;
                                }).join('\n');

                                const matchedSummary = uniRes.tables.map(t => `• **\`${t.tableName}\`**: ${t.matchedCount} matching row(s) (matched in columns: ${t.matchedColumns.join(', ')})`).join('\n');

                                const answerMarkdown = `### 🔍 Universal Database Search Results for *"${searchKeywords}"*\n` +
                                    `**Database:** ${conn.name} (${conn.db_type.toUpperCase()}) | **Total Matches:** ${uniRes.totalMatches} across ${uniRes.tablesMatchedCount} table(s)\n\n` +
                                    `#### Matching Tables Summary:\n${matchedSummary}\n\n` +
                                    `#### Top Record(s) from \`${topTable.tableName}\`:\n` +
                                    `${headerRow}\n${dividerRow}\n${dataRows}`;

                                return res.json({
                                    answer: answerMarkdown,
                                    tableData: {
                                        tableName: topTable.tableName,
                                        dbSource: conn.name,
                                        dbType: conn.db_type,
                                        columns: displayCols,
                                        rows: topTable.rows,
                                        totalRows: topTable.matchedCount
                                    },
                                    sources: uniRes.tables.map(t => ({
                                        title: `Table: ${t.tableName} (${conn.name})`,
                                        sourceType: 'DATABASE',
                                        relevance: '0.99'
                                    })),
                                    searchType: searchType || 'GRAPH_COMPLETION',
                                    mode: mode || 'chat'
                                });
                            }
                        } catch (uniErr) {
                            console.warn(`[brain.js] Universal search error for ${conn.name}:`, uniErr.message);
                        }
                    }
                }
            }
        }

        // Fast-path for inventory & database queries (instant, no external network delay)
        if (isInventoryQuery) {
            let answerText = '';
            if (targetSourceType === 'DATABASE') {
                const connList = dbConns.rows.map(c => `• **${c.name}** (${c.db_type.toUpperCase()}) - Status: \`${c.status}\`, Tables: ${c.tables_count || 0} (Host: ${c.host}:${c.port || 3306})`).join('\n');
                const tableList = databaseTables.length > 0 
                    ? databaseTables.map(f => `  - ${f}`).join('\n')
                    : '  - *No tables synced yet. Use Data Sources tab to sync.*';

                answerText = `### 🗄️ Connected Databases & Tables:\n\n**Registered Database Connections (${dbConns.rows.length}):**\n${connList || '• None'}\n\n**Synced Tables in Company Brain (${databaseTables.length}):**\n${tableList}\n\n*(Total synced database records: ${dbDocs.rows.filter(d => d.source_type === 'DATABASE').length})*`;
            } else if (targetSourceType === 'ONEDRIVE') {
                answerText = `### ☁️ OneDrive Documents (${onedriveFiles.length}):\n\n` +
                    (onedriveFiles.map(f => `• ${f}`).join('\n') || '• No OneDrive documents currently synced.');
            } else if (targetSourceType === 'OUTLOOK') {
                answerText = `### 📧 Outlook Emails (${outlookFiles.length}):\n\n` +
                    (outlookFiles.map(f => `• ${f}`).join('\n') || '• No Outlook emails currently synced.');
            } else if (targetSourceType === 'FILE_UPLOAD') {
                answerText = `### 📁 Uploaded Files (${uploadFiles.length}):\n\n` +
                    (uploadFiles.map(f => `• ${f}`).join('\n') || '• No uploaded files.');
            } else {
                const connList = dbConns.rows.map(c => `• **${c.name}** (${c.db_type.toUpperCase()}) [${c.status}]`).join('\n');
                answerText = `### 🧠 Company Brain Overview (${totalUnique} total items across all sources):\n\n` +
                    `• **Database Connections (${dbConns.rows.length}):**\n${connList || '  - None'}\n\n` +
                    `• **Synced Database Tables (${databaseTables.length}):** ${databaseTables.join(', ') || 'None'}\n` +
                    `• **OneDrive Files (${onedriveFiles.length}):** ${onedriveFiles.join(', ') || 'None'}\n` +
                    `• **Outlook Emails (${outlookFiles.length}):** ${outlookFiles.join(', ') || 'None'}\n` +
                    `• **File Uploads (${uploadFiles.length}):** ${uploadFiles.join(', ') || 'None'}`;
            }

            return res.json({
                answer: answerText,
                sources: parsedSources,
                searchType: searchType || 'GRAPH_COMPLETION',
                mode: mode || 'chat'
            });
        }

        // For deep semantic questions, query Cognee with fallback
        try {
            const dbContextInfo = `[Database System Metadata: Total Ingested Records: ${dbDocs.rows.length} (${totalUnique} unique items). Database Tables (${databaseTables.length}): ${databaseTables.join(', ') || 'None'}. OneDrive files (${onedriveFiles.length}): ${onedriveFiles.join(', ') || 'None'}. Outlook emails (${outlookFiles.length}): ${outlookFiles.join(', ') || 'None'}. Media transcripts (${mediaFiles.length}): ${mediaFiles.join(', ') || 'None'}. File Uploads (${uploadFiles.length}): ${uploadFiles.join(', ') || 'None'}.]`;
            const detailedInstruction = `[System Instruction for AI Assistant: Provide a thorough, comprehensive, and well-structured answer. When answering questions regarding database tables, schemas, or records, detail the relevant fields, records, and relationships clearly. Use clean Markdown formatting.]`;

            const queryToPass = `${dbContextInfo}\n${detailedInstruction}\n\nUser Query: ${query}`;

            const response = await queryBrain(queryToPass, {
                searchType: searchType || 'GRAPH_COMPLETION',
                mode: mode || 'chat',
                onlyContext: !!onlyContext
            });

            res.json({
                ...response,
                sources: parsedSources.length > 0 ? parsedSources : response.sources
            });
        } catch (cogneeErr) {
            console.warn('Cognee search fallback triggered:', cogneeErr.message);
            res.json({
                answer: `Here is the relevant information from your Company Brain matching "${query}":\n\n` +
                    `• **Retrieved Knowledge Sources (${parsedSources.length}):**\n` +
                    parsedSources.map(s => `  - **${s.title}** (${s.sourceType})`).join('\n') +
                    `\n\n*(Note: LLM completion is operating with local graph index fallback)*`,
                sources: parsedSources,
                searchType: searchType || 'GRAPH_COMPLETION',
                mode: mode || 'chat'
            });
        }
    } catch (err) {
        console.error('Error querying brain:', err);
        res.status(500).json({ error: err.message || 'Failed to query the Company Brain' });
    }
});

// Get Knowledge Graph visualization
router.get('/graph', async (req, res) => {
    try {
        const graphData = await getKnowledgeGraphData();
        res.json(graphData);
    } catch (err) {
        console.error('Error fetching graph data:', err);
        res.status(500).json({ error: 'Failed to retrieve knowledge graph visualization' });
    }
});

// Get overall extraction metrics & statistics across Cognee
router.get('/stats', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                COUNT(*) as total_documents,
                COALESCE(SUM(chunks_count), 0) as total_chunks,
                COALESCE(SUM(entities_count), 0) as total_entities,
                COALESCE(SUM(edges_count), 0) as total_edges,
                COALESCE(SUM(embeddings_count), 0) as total_embeddings,
                COALESCE(SUM(summaries_count), 0) as total_summaries,
                COUNT(CASE WHEN source_type = 'FILE_UPLOAD' THEN 1 END) as file_upload_count,
                COUNT(CASE WHEN source_type = 'MEDIA_UPLOAD' THEN 1 END) as media_upload_count,
                COUNT(CASE WHEN source_type = 'ONEDRIVE' THEN 1 END) as onedrive_count,
                COUNT(CASE WHEN source_type = 'OUTLOOK' THEN 1 END) as outlook_count,
                COUNT(CASE WHEN source_type = 'DATABASE' THEN 1 END) as database_count
            FROM documents
        `);

        // Fetch recent document items
        const docsResult = await db.query('SELECT * FROM documents ORDER BY created_at DESC LIMIT 20');

        res.json({
            stats: result.rows[0],
            recentDocuments: docsResult.rows
        });
    } catch (err) {
        console.error('Error fetching brain stats:', err);
        res.status(500).json({ error: 'Failed to fetch brain statistics' });
    }
});

module.exports = router;
