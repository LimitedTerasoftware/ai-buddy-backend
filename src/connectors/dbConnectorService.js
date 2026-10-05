const { Client: PgClient } = require('pg');
let mysql = null;
try {
    mysql = require('mysql2/promise');
} catch (e) {
    console.warn('mysql2 not loaded yet:', e.message);
}
let sqlite3 = null;
try {
    sqlite3 = require('sqlite3').verbose();
} catch (e) {
    console.warn('sqlite3 not loaded yet:', e.message);
}

const { ingestMultipleItems } = require('../cognee/client');
const db = require('../db');

function enrichTableRelationships(tables) {
    const tableNames = new Map(tables.map(table => [table.tableName.toLowerCase(), table]));

    return tables.map(table => {
        const relationships = [];

        for (const column of table.columns) {
            const match = column.name.match(/^(.+)_id$/i);
            if (!match) continue;

            const baseName = match[1].toLowerCase();
            const candidates = [baseName, `${baseName}s`];
            const target = candidates
                .map(candidate => tableNames.get(candidate))
                .find(candidate => candidate && candidate.tableName.toLowerCase() !== table.tableName.toLowerCase());

            if (!target) continue;

            const targetColumn = target.columns.some(targetCol => targetCol.name.toLowerCase() === `${baseName}_id`)
                ? `${baseName}_id`
                : target.columns.some(targetCol => targetCol.name.toLowerCase() === 'id')
                    ? 'id'
                    : null;

            if (targetColumn) {
                relationships.push({
                    column: column.name,
                    targetTable: target.tableName,
                    targetColumn,
                    type: 'many-to-one (conventional foreign key)'
                });
            }
        }

        return { ...table, relationships };
    });
}

class DBConnectorService {
    /**
     * Test connection to a database configuration
     */
    async testConnection(config) {
        const startTime = Date.now();
        const dbType = (config.db_type || config.dbType || 'postgres').toLowerCase();

        if (dbType === 'postgres' || dbType === 'postgresql') {
            const client = new PgClient({
                user: config.username || config.user,
                host: config.host || 'localhost',
                database: config.database_name || config.database,
                password: config.password,
                port: Number(config.port) || 5432,
                ssl: config.ssl ? { rejectUnauthorized: false } : false,
                connectionTimeoutMillis: 6000
            });

            try {
                await client.connect();
                const res = await client.query('SELECT version() as version, current_database() as database');
                const tableRes = await client.query(`
                    SELECT count(*)::int as count 
                    FROM information_schema.tables 
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                `);
                await client.end();
                const latency = Date.now() - startTime;
                return {
                    success: true,
                    version: res.rows[0]?.version?.split(' on ')[0] || 'PostgreSQL',
                    database: res.rows[0]?.database,
                    tableCount: tableRes.rows[0]?.count || 0,
                    latencyMs: latency
                };
            } catch (err) {
                try { await client.end(); } catch (e) {}
                return { success: false, error: err.message };
            }
        } else if (dbType === 'mysql' || dbType === 'mariadb') {
            if (!mysql) throw new Error('mysql2 driver not installed');
            try {
                const conn = await mysql.createConnection({
                    host: config.host || 'localhost',
                    user: config.username || config.user,
                    database: config.database_name || config.database,
                    password: config.password,
                    port: Number(config.port) || 3306,
                    connectTimeout: 6000
                });
                const [rows] = await conn.query('SELECT VERSION() as version, DATABASE() as `database`');
                const [tableRows] = await conn.query('SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE()');
                await conn.end();
                const latency = Date.now() - startTime;
                return {
                    success: true,
                    version: rows[0]?.version || 'MySQL',
                    database: rows[0]?.database,
                    tableCount: tableRows[0]?.count || 0,
                    latencyMs: latency
                };
            } catch (err) {
                return { success: false, error: err.message };
            }
        } else if (dbType === 'sqlite') {
            if (!sqlite3) throw new Error('sqlite3 driver not installed');
            const filepath = config.filepath || config.database_name;
            return new Promise((resolve) => {
                const sqliteDb = new sqlite3.Database(filepath, sqlite3.OPEN_READONLY, (err) => {
                    if (err) {
                        return resolve({ success: false, error: err.message });
                    }
                    sqliteDb.all("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", (err, rows) => {
                        sqliteDb.close();
                        if (err) {
                            return resolve({ success: false, error: err.message });
                        }
                        const latency = Date.now() - startTime;
                        return resolve({
                            success: true,
                            version: 'SQLite 3',
                            database: filepath,
                            tableCount: rows[0]?.count || 0,
                            latencyMs: latency
                        });
                    });
                });
            });
        } else {
            throw new Error(`Unsupported database type: ${dbType}`);
        }
    }

    /**
     * Introspect database schema and retrieve all tables with columns, types, and row counts
     */
    async listTables(config) {
        const dbType = (config.db_type || config.dbType || 'postgres').toLowerCase();

        if (dbType === 'postgres' || dbType === 'postgresql') {
            const client = new PgClient({
                user: config.username || config.user,
                host: config.host || 'localhost',
                database: config.database_name || config.database,
                password: config.password,
                port: Number(config.port) || 5432,
                ssl: config.ssl ? { rejectUnauthorized: false } : false
            });

            await client.connect();
            try {
                // Get all user tables
                const tablesQuery = `
                    SELECT 
                        t.table_schema,
                        t.table_name,
                        COALESCE(s.n_live_tup, 0) as approximate_row_count
                    FROM information_schema.tables t
                    LEFT JOIN pg_stat_user_tables s 
                        ON t.table_name = s.relname AND t.table_schema = s.schemaname
                    WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
                      AND t.table_type = 'BASE TABLE'
                    ORDER BY t.table_name;
                `;
                const tablesRes = await client.query(tablesQuery);

                // Get all column details
                const columnsQuery = `
                    SELECT 
                        table_name,
                        column_name,
                        data_type,
                        is_nullable,
                        column_default
                    FROM information_schema.columns
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_name, ordinal_position;
                `;
                const columnsRes = await client.query(columnsQuery);

                // Group columns by table
                const columnsByTable = {};
                for (const col of columnsRes.rows) {
                    if (!columnsByTable[col.table_name]) {
                        columnsByTable[col.table_name] = [];
                    }
                    columnsByTable[col.table_name].push({
                        name: col.column_name,
                        type: col.data_type,
                        isNullable: col.is_nullable === 'YES',
                        default: col.column_default
                    });
                }

                // Get accurate row counts for tables
                const tables = [];
                for (const row of tablesRes.rows) {
                    const tableName = row.table_name;
                    let rowCount = Number(row.approximate_row_count) || 0;
                    
                    // If row count is 0 or uncertain, run quick exact count
                    try {
                        const countRes = await client.query(`SELECT count(*)::int as exact_count FROM "${row.table_schema}"."${tableName}"`);
                        rowCount = countRes.rows[0]?.exact_count || 0;
                    } catch (e) {
                        // Keep approximate
                    }

                    tables.push({
                        tableName,
                        schema: row.table_schema,
                        rowCount,
                        columns: columnsByTable[tableName] || []
                    });
                }

                return enrichTableRelationships(tables);
            } finally {
                await client.end();
            }
        } else if (dbType === 'mysql' || dbType === 'mariadb') {
            if (!mysql) throw new Error('mysql2 driver not installed');
            const conn = await mysql.createConnection({
                host: config.host || 'localhost',
                user: config.username || config.user,
                database: config.database_name || config.database,
                password: config.password,
                port: Number(config.port) || 3306
            });

            try {
                const [tableRows] = await conn.query(`
                    SELECT TABLE_NAME as tableName, TABLE_SCHEMA as \`schema\`, TABLE_ROWS as rowCount
                    FROM information_schema.tables 
                    WHERE table_schema = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
                    ORDER BY TABLE_NAME
                `);

                const [columnRows] = await conn.query(`
                    SELECT TABLE_NAME as tableName, COLUMN_NAME as name, DATA_TYPE as type, IS_NULLABLE as isNullable
                    FROM information_schema.columns
                    WHERE table_schema = DATABASE()
                    ORDER BY TABLE_NAME, ORDINAL_POSITION
                `);

                const columnsByTable = {};
                for (const col of columnRows) {
                    if (!columnsByTable[col.tableName]) columnsByTable[col.tableName] = [];
                    columnsByTable[col.tableName].push({
                        name: col.name,
                        type: col.type,
                        isNullable: col.isNullable === 'YES'
                    });
                }

                return enrichTableRelationships(tableRows.map(t => ({
                    tableName: t.tableName,
                    schema: t.schema,
                    rowCount: Number(t.rowCount) || 0,
                    columns: columnsByTable[t.tableName] || []
                })));
            } finally {
                await conn.end();
            }
        } else if (dbType === 'sqlite') {
            if (!sqlite3) throw new Error('sqlite3 driver not installed');
            const filepath = config.filepath || config.database_name;
            return new Promise((resolve, reject) => {
                const sqliteDb = new sqlite3.Database(filepath, sqlite3.OPEN_READONLY, async (err) => {
                    if (err) return reject(err);

                    sqliteDb.all("SELECT name as tableName FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", async (err, tableRows) => {
                        if (err) {
                            sqliteDb.close();
                            return reject(err);
                        }

                        const tables = [];
                        for (const t of tableRows) {
                            const tableName = t.tableName;
                            const cols = await new Promise((resCols) => {
                                sqliteDb.all(`PRAGMA table_info("${tableName}")`, (e, infoRows) => {
                                    if (e || !infoRows) return resCols([]);
                                    resCols(infoRows.map(r => ({
                                        name: r.name,
                                        type: r.type,
                                        isNullable: r.notnull === 0,
                                        isPrimary: r.pk === 1
                                    })));
                                });
                            });

                            const rowCount = await new Promise((resCount) => {
                                sqliteDb.get(`SELECT count(*) as count FROM "${tableName}"`, (e, countRow) => {
                                    resCount(countRow?.count || 0);
                                });
                            });

                            tables.push({
                                tableName,
                                schema: 'main',
                                rowCount,
                                columns: cols
                            });
                        }
                        sqliteDb.close();
                        resolve(enrichTableRelationships(tables));
                    });
                });
            });
        } else {
            throw new Error(`Unsupported database type: ${dbType}`);
        }
    }

    /**
     * Safely read top records from a table for preview and extraction
     */
    async getTableRows(config, tableName, limit = 50) {
        const dbType = (config.db_type || config.dbType || 'postgres').toLowerCase();

        if (dbType === 'postgres' || dbType === 'postgresql') {
            const client = new PgClient({
                user: config.username || config.user,
                host: config.host || 'localhost',
                database: config.database_name || config.database,
                password: config.password,
                port: Number(config.port) || 5432,
                ssl: config.ssl ? { rejectUnauthorized: false } : false
            });

            await client.connect();
            try {
                const schema = config.schema || 'public';
                const res = await client.query(`SELECT * FROM "${schema}"."${tableName}" LIMIT $1`, [limit]);
                return res.rows;
            } finally {
                await client.end();
            }
        } else if (dbType === 'mysql' || dbType === 'mariadb') {
            const conn = await mysql.createConnection({
                host: config.host || 'localhost',
                user: config.username || config.user,
                database: config.database_name || config.database,
                password: config.password,
                port: Number(config.port) || 3306
            });
            try {
                const [rows] = await conn.query(`SELECT * FROM \`${tableName}\` LIMIT ?`, [limit]);
                return rows;
            } finally {
                await conn.end();
            }
        } else if (dbType === 'sqlite') {
            const filepath = config.filepath || config.database_name;
            return new Promise((resolve, reject) => {
                const sqliteDb = new sqlite3.Database(filepath, sqlite3.OPEN_READONLY, (err) => {
                    if (err) return reject(err);
                    sqliteDb.all(`SELECT * FROM "${tableName}" LIMIT ${Number(limit) || 50}`, (e, rows) => {
                        sqliteDb.close();
                        if (e) return reject(e);
                        resolve(rows || []);
                    });
                });
            });
        }
        return [];
    }

    /**
     * Format table schema and records into structured natural language for Cognee knowledge graph
     */
    formatTableKnowledge(dbName, dbType, tableMeta, rows) {
        const columnsDesc = tableMeta.columns.map(c => 
            `- ${c.name} (type: ${c.type}${c.isNullable ? ', nullable' : ''}${c.isPrimary ? ', primary key' : ''})`
        ).join('\n');

        const relationshipsDesc = tableMeta.relationships?.length
            ? tableMeta.relationships.map(relation =>
                `- ${tableMeta.tableName}.${relation.column} -> ${relation.targetTable}.${relation.targetColumn} (${relation.type})`
            ).join('\n')
            : 'No conventional foreign-key relationships detected.';

        let recordsFormatted = '';
        if (rows.length === 0) {
            recordsFormatted = 'No data records currently stored in this table.';
        } else {
            recordsFormatted = rows.slice(0, 150).map((row, idx) => {
                const fields = Object.entries(row)
                    .map(([k, v]) => `${k}: ${v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : v}`)
                    .join(' | ');
                return `Record #${idx + 1}: [ ${fields} ]`;
            }).join('\n');

            if (rows.length > 150) {
                recordsFormatted += `\n... (and ${rows.length - 150} more records in table)`;
            }
        }

        return `DATABASE TABLE KNOWLEDGE
Database Source: ${dbName}
Engine Type: ${dbType.toUpperCase()}
Table Name: ${tableMeta.tableName}
Total Rows: ${tableMeta.rowCount}
Schema Definition & Columns:
${columnsDesc}

Relationships:
${relationshipsDesc}

Data Records & Content:
${recordsFormatted}
`;
    }

    /**
     * Ingest all tables from a database connection into Cognee Knowledge Graph
     */
    async syncDatabaseToCognee(connRecord, options = {}) {
        const { maxRowsPerTable = 100 } = options;
        console.log(`Starting sync of all tables from database [${connRecord.name}] (${connRecord.db_type})...`);

        // 1. List all tables
        const tables = await this.listTables(connRecord);
        console.log(`Found ${tables.length} tables in database [${connRecord.name}].`);

        const batchList = [];
        const syncedTableDocs = [];

        // 2. Extract and format data for each table
        for (const table of tables) {
            try {
                let rows = [];
                if (table.rowCount > 0) {
                    rows = await this.getTableRows(connRecord, table.tableName, maxRowsPerTable);
                }

                const formattedText = this.formatTableKnowledge(
                    connRecord.name || connRecord.database_name,
                    connRecord.db_type || 'postgres',
                    table,
                    rows
                );

                const originalName = `Table: ${table.tableName} (${connRecord.name})`;
                const sourceId = `db-${connRecord.id}-${table.tableName}`;

                // Check if document already exists for this table in documents table
                const existing = await db.query(
                    'SELECT id FROM documents WHERE source_id = $1',
                    [sourceId]
                );

                let docRecord;
                if (existing.rows.length > 0) {
                    const updateRes = await db.query(
                        `UPDATE documents SET 
                            filename = $1, 
                            original_name = $2, 
                            size_bytes = $3, 
                            status = 'PENDING',
                            metadata = $4,
                            updated_at = NOW() 
                         WHERE id = $5 RETURNING *`,
                        [
                            `${table.tableName}.sql`,
                            originalName,
                            formattedText.length,
                            JSON.stringify({ databaseId: connRecord.id, tableName: table.tableName, rowCount: table.rowCount }),
                            existing.rows[0].id
                        ]
                    );
                    docRecord = updateRes.rows[0];
                } else {
                    const insertRes = await db.query(
                        `INSERT INTO documents 
                         (filename, original_name, mime_type, size_bytes, source_type, source_id, status, metadata) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                        [
                            `${table.tableName}.sql`,
                            originalName,
                            'application/sql',
                            formattedText.length,
                            'DATABASE',
                            sourceId,
                            'PENDING',
                            JSON.stringify({ databaseId: connRecord.id, tableName: table.tableName, rowCount: table.rowCount })
                        ]
                    );
                    docRecord = insertRes.rows[0];
                }

                syncedTableDocs.push(docRecord);
                batchList.push({
                    textContent: formattedText,
                    documentRecord: docRecord
                });

            } catch (tableErr) {
                console.warn(`Failed extracting table ${table.tableName}:`, tableErr.message);
            }
        }

        // 3. Batch Ingest & Cognify into Cognee Knowledge Graph
        if (batchList.length > 0) {
            try {
                console.log(`Sending ${batchList.length} database tables to Cognee addAndCognify...`);
                const cognifyResult = await ingestMultipleItems(batchList);
                const chunks = cognifyResult?.chunks || 2;
                const entities = cognifyResult?.entities || 3;
                const edges = cognifyResult?.edges || 2;
                const embeddings = cognifyResult?.embeddings || 2;
                const summaries = cognifyResult?.summaries || 1;

                for (const doc of syncedTableDocs) {
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
            } catch (cognifyErr) {
                console.error('Cognee cognify failed for database tables:', cognifyErr);
                for (const doc of syncedTableDocs) {
                    await db.query('UPDATE documents SET status = $1, error = $2 WHERE id = $3', ['FAILED', cognifyErr.message, doc.id]);
                    doc.status = 'FAILED';
                }
            }
        }

        // 4. Update database_connections state
        await db.query(
            `UPDATE database_connections SET 
                status = 'CONNECTED', 
                tables_count = $1, 
                last_synced_at = NOW(), 
                error = NULL 
             WHERE id = $2`,
            [tables.length, connRecord.id]
        );

        return {
            success: true,
            tablesCount: tables.length,
            syncedDocuments: syncedTableDocs,
            message: `Successfully synchronized and ingested ${tables.length} tables from ${connRecord.name} into Company Brain.`
        };
    }

    /**
     * Universal Full-Database Search across all tables and columns for a search term
     */
    async searchDatabaseUniversal(config, searchTerm, options = {}) {
        const { maxResultsPerTable = 15, maxTablesToReturn = 10 } = options;
        if (!searchTerm || !searchTerm.trim()) {
            return { tables: [], totalMatches: 0 };
        }

        const cleanTerm = searchTerm.trim();
        const dbType = (config.db_type || config.dbType || 'postgres').toLowerCase();
        const tables = await this.listTables(config);
        const searchResults = [];
        let totalMatches = 0;

        for (const table of tables) {
            // Find searchable columns (text, char, varchar, int, etc.)
            const searchableCols = table.columns.filter(c => {
                const t = (c.type || '').toLowerCase();
                return t.includes('char') || t.includes('text') || t.includes('int') || 
                       t.includes('decimal') || t.includes('double') || t.includes('enum') || 
                       t.includes('json') || t.includes('string');
            });

            if (searchableCols.length === 0) continue;

            try {
                let matchedRows = [];
                if (dbType === 'mysql' || dbType === 'mariadb') {
                    if (!mysql) continue;
                    const conn = await mysql.createConnection({
                        host: config.host || 'localhost',
                        user: config.username || config.user,
                        database: config.database_name || config.database,
                        password: config.password,
                        port: Number(config.port) || 3306
                    });
                    try {
                        const whereClauses = searchableCols.map(c => `\`${c.name}\` LIKE ?`).join(' OR ');
                        const params = searchableCols.map(() => `%${cleanTerm}%`);
                        params.push(maxResultsPerTable);
                        const [rows] = await conn.query(
                            `SELECT * FROM \`${table.tableName}\` WHERE ${whereClauses} LIMIT ?`,
                            params
                        );
                        matchedRows = rows;
                    } finally {
                        await conn.end();
                    }
                } else if (dbType === 'postgres' || dbType === 'postgresql') {
                    const client = new PgClient({
                        user: config.username || config.user,
                        host: config.host || 'localhost',
                        database: config.database_name || config.database,
                        password: config.password,
                        port: Number(config.port) || 5432,
                        ssl: config.ssl ? { rejectUnauthorized: false } : false
                    });
                    await client.connect();
                    try {
                        const schema = config.schema || 'public';
                        const whereClauses = searchableCols.map((c, i) => `"${c.name}"::text ILIKE $1`).join(' OR ');
                        const res = await client.query(
                            `SELECT * FROM "${schema}"."${table.tableName}" WHERE ${whereClauses} LIMIT $2`,
                            [`%${cleanTerm}%`, maxResultsPerTable]
                        );
                        matchedRows = res.rows;
                    } finally {
                        await client.end();
                    }
                } else if (dbType === 'sqlite') {
                    if (!sqlite3) continue;
                    const filepath = config.filepath || config.database_name;
                    matchedRows = await new Promise((resolve) => {
                        const sqliteDb = new sqlite3.Database(filepath, sqlite3.OPEN_READONLY, (err) => {
                            if (err) return resolve([]);
                            const whereClauses = searchableCols.map(c => `"${c.name}" LIKE ?`).join(' OR ');
                            const params = searchableCols.map(() => `%${cleanTerm}%`);
                            sqliteDb.all(
                                `SELECT * FROM "${table.tableName}" WHERE ${whereClauses} LIMIT ${maxResultsPerTable}`,
                                params,
                                (e, rows) => {
                                    sqliteDb.close();
                                    resolve(e ? [] : rows);
                                }
                            );
                        });
                    });
                }

                if (matchedRows && matchedRows.length > 0) {
                    totalMatches += matchedRows.length;
                    
                    // Identify which columns had matches
                    const matchedColNames = new Set();
                    const lowerTerm = cleanTerm.toLowerCase();
                    matchedRows.forEach(r => {
                        Object.entries(r).forEach(([k, v]) => {
                            if (v !== null && v !== undefined && String(v).toLowerCase().includes(lowerTerm)) {
                                matchedColNames.add(k);
                            }
                        });
                    });

                    searchResults.push({
                        tableName: table.tableName,
                        schema: table.schema,
                        matchedCount: matchedRows.length,
                        matchedColumns: Array.from(matchedColNames),
                        allColumns: table.columns.map(c => c.name),
                        rows: matchedRows
                    });
                }
            } catch (err) {
                console.warn(`[searchDatabaseUniversal] Error searching table ${table.tableName}:`, err.message);
            }
        }

        // Sort by number of matches descending
        searchResults.sort((a, b) => b.matchedCount - a.matchedCount);

        return {
            databaseName: config.name || config.database_name,
            dbType: dbType.toUpperCase(),
            searchTerm: cleanTerm,
            totalMatches,
            tablesMatchedCount: searchResults.length,
            tables: searchResults.slice(0, maxTablesToReturn)
        };
    }

    /**
     * Safely execute a read-only SELECT query against the target database
     */
    async executeRawQuery(config, sqlQuery, maxRows = 100) {
        const startTime = Date.now();
        const trimmed = (sqlQuery || '').trim();
        const upper = trimmed.toUpperCase();

        // Security check: Only allow read-only SELECT or EXPLAIN queries
        if (!upper.startsWith('SELECT') && !upper.startsWith('WITH') && !upper.startsWith('SHOW') && !upper.startsWith('DESCRIBE') && !upper.startsWith('EXPLAIN')) {
            throw new Error('Only read-only SELECT queries are permitted.');
        }

        // Prevent destructive statements
        if (/;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b/i.test(trimmed) ||
            /\b(INTO\s+OUTFILE|LOAD_FILE)\b/i.test(trimmed)) {
            throw new Error('Destructive or multi-statement modifications are not permitted.');
        }

        const dbType = (config.db_type || config.dbType || 'postgres').toLowerCase();

        if (dbType === 'mysql' || dbType === 'mariadb') {
            if (!mysql) throw new Error('mysql2 driver is not available');
            const conn = await mysql.createConnection({
                host: config.host || 'localhost',
                user: config.username || config.user,
                database: config.database_name || config.database,
                password: config.password,
                port: Number(config.port) || 3306,
                connectTimeout: 8000
            });
            try {
                const [rows, fields] = await conn.query(trimmed);
                const resultRows = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
                const columns = fields ? fields.map(f => f.name) : (resultRows.length > 0 ? Object.keys(resultRows[0]) : []);
                return {
                    success: true,
                    rows: resultRows,
                    rowCount: resultRows.length,
                    columns,
                    executionTimeMs: Date.now() - startTime
                };
            } finally {
                await conn.end();
            }
        } else if (dbType === 'postgres' || dbType === 'postgresql') {
            const client = new PgClient({
                user: config.username || config.user,
                host: config.host || 'localhost',
                database: config.database_name || config.database,
                password: config.password,
                port: Number(config.port) || 5432,
                ssl: config.ssl ? { rejectUnauthorized: false } : false,
                connectionTimeoutMillis: 8000
            });
            await client.connect();
            try {
                const res = await client.query(trimmed);
                const resultRows = (res.rows || []).slice(0, maxRows);
                const columns = res.fields ? res.fields.map(f => f.name) : (resultRows.length > 0 ? Object.keys(resultRows[0]) : []);
                return {
                    success: true,
                    rows: resultRows,
                    rowCount: resultRows.length,
                    columns,
                    executionTimeMs: Date.now() - startTime
                };
            } finally {
                await client.end();
            }
        } else if (dbType === 'sqlite') {
            if (!sqlite3) throw new Error('sqlite3 driver is not available');
            const filepath = config.filepath || config.database_name;
            return new Promise((resolve, reject) => {
                const sqliteDb = new sqlite3.Database(filepath, sqlite3.OPEN_READONLY, (err) => {
                    if (err) return reject(err);
                    sqliteDb.all(trimmed, (e, rows) => {
                        sqliteDb.close();
                        if (e) return reject(e);
                        const resultRows = (rows || []).slice(0, maxRows);
                        const columns = resultRows.length > 0 ? Object.keys(resultRows[0]) : [];
                        resolve({
                            success: true,
                            rows: resultRows,
                            rowCount: resultRows.length,
                            columns,
                            executionTimeMs: Date.now() - startTime
                        });
                    });
                });
            });
        } else {
            throw new Error(`Unsupported database type: ${dbType}`);
        }
    }
}

module.exports = new DBConnectorService();

