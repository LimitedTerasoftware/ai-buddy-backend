const express = require('express');
const router = express.Router();
const db = require('../db');
const dbConnectorService = require('../connectors/dbConnectorService');

// 1. Get all saved database connections
router.get('/', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                id, name, db_type, host, port, database_name, username, ssl, filepath,
                status, tables_count, last_synced_at, error, created_at, updated_at
            FROM database_connections 
            ORDER BY created_at DESC
        `);
        res.json({ databases: result.rows });
    } catch (err) {
        console.error('Error fetching database connections:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Test a database connection configuration
router.post('/test', async (req, res) => {
    try {
        const config = req.body;
        if (!config.db_type) {
            config.db_type = 'postgres';
        }
        const testResult = await dbConnectorService.testConnection(config);
        res.json(testResult);
    } catch (err) {
        console.error('Database connection test error:', err);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 3. Create & save a new database connection
router.post('/', async (req, res) => {
    try {
        const { name, db_type, host, port, database_name, username, password, ssl, filepath } = req.body;

        if (!name || !database_name) {
            return res.status(400).json({ error: 'Connection Name and Database Name are required' });
        }

        // Test connection first
        const testResult = await dbConnectorService.testConnection({
            db_type: db_type || 'postgres',
            host,
            port,
            database_name,
            username,
            password,
            ssl,
            filepath
        });

        const status = testResult.success ? 'CONNECTED' : 'ERROR';
        const error = testResult.success ? null : testResult.error;
        const tablesCount = testResult.tableCount || 0;

        const result = await db.query(
            `INSERT INTO database_connections 
             (name, db_type, host, port, database_name, username, password, ssl, filepath, status, tables_count, error) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, name, db_type, host, port, database_name, username, ssl, filepath, status, tables_count, error, created_at`,
            [
                name,
                db_type || 'postgres',
                host || 'localhost',
                port ? Number(port) : (db_type === 'mysql' ? 3306 : 5432),
                database_name,
                username || null,
                password || null,
                Boolean(ssl),
                filepath || null,
                status,
                tablesCount,
                error
            ]
        );

        const newConnection = result.rows[0];

        res.status(201).json({
            message: `Database connection '${name}' registered successfully`,
            database: newConnection,
            testResult
        });
    } catch (err) {
        console.error('Error saving database connection:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4. Discover & list all tables for a specific database connection
router.get('/:id/tables', async (req, res) => {
    try {
        const { id } = req.params;
        const connRes = await db.query('SELECT * FROM database_connections WHERE id = $1', [id]);
        if (connRes.rows.length === 0) {
            return res.status(404).json({ error: 'Database connection not found' });
        }

        const conn = connRes.rows[0];
        const tables = await dbConnectorService.listTables(conn);

        // Update tables count in connection table
        await db.query('UPDATE database_connections SET tables_count = $1, status = $2 WHERE id = $3', [tables.length, 'CONNECTED', id]);

        res.json({
            databaseId: id,
            databaseName: conn.name,
            tablesCount: tables.length,
            tables
        });
    } catch (err) {
        console.error(`Error listing tables for DB ${req.params.id}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// 5. Get preview rows for a table
router.get('/:id/tables/:tableName/rows', async (req, res) => {
    try {
        const { id, tableName } = req.params;
        const limit = Number(req.query.limit) || 20;

        const connRes = await db.query('SELECT * FROM database_connections WHERE id = $1', [id]);
        if (connRes.rows.length === 0) {
            return res.status(404).json({ error: 'Database connection not found' });
        }

        const conn = connRes.rows[0];
        const rows = await dbConnectorService.getTableRows(conn, tableName, limit);

        res.json({
            tableName,
            rowCount: rows.length,
            rows
        });
    } catch (err) {
        console.error(`Error previewing table ${req.params.tableName}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// 6. Sync / Ingest all tables from database into Cognee Knowledge Graph
router.post('/:id/sync', async (req, res) => {
    try {
        const { id } = req.params;
        const connRes = await db.query('SELECT * FROM database_connections WHERE id = $1', [id]);
        if (connRes.rows.length === 0) {
            return res.status(404).json({ error: 'Database connection not found' });
        }

        const conn = connRes.rows[0];
        const syncResult = await dbConnectorService.syncDatabaseToCognee(conn, {
            maxRowsPerTable: Number(req.body.maxRowsPerTable) || 100
        });

        res.json(syncResult);
    } catch (err) {
        console.error(`Error syncing database ${req.params.id}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// 7. Universal Cross-Table Search across a specific database connection
router.post('/:id/search', async (req, res) => {
    try {
        const { id } = req.params;
        const { query, maxResultsPerTable, maxTables } = req.body;
        
        if (!query) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        const connRes = await db.query('SELECT * FROM database_connections WHERE id = $1', [id]);
        if (connRes.rows.length === 0) {
            return res.status(404).json({ error: 'Database connection not found' });
        }

        const results = await dbConnectorService.searchDatabaseUniversal(connRes.rows[0], query, {
            maxResultsPerTable: Number(maxResultsPerTable) || 15,
            maxTablesToReturn: Number(maxTables) || 10
        });

        res.json(results);
    } catch (err) {
        console.error(`Error searching database ${req.params.id}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// 8. Universal Search across ALL connected databases
router.post('/search/all', async (req, res) => {
    try {
        const { query, maxResultsPerTable } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        const connsRes = await db.query('SELECT * FROM database_connections WHERE status = $1', ['CONNECTED']);
        const allDbResults = [];

        for (const conn of connsRes.rows) {
            try {
                const resDb = await dbConnectorService.searchDatabaseUniversal(conn, query, {
                    maxResultsPerTable: Number(maxResultsPerTable) || 10
                });
                if (resDb.totalMatches > 0) {
                    allDbResults.push(resDb);
                }
            } catch (e) {
                console.warn(`Failed searching ${conn.name}:`, e.message);
            }
        }

        res.json({
            query,
            totalDatabasesSearched: connsRes.rows.length,
            databasesWithMatches: allDbResults.length,
            results: allDbResults
        });
    } catch (err) {
        console.error('Error during global database search:', err);
        res.status(500).json({ error: err.message });
    }
});

// 9. Delete database connection and associated documents
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Remove synced database documents
        await db.query(`DELETE FROM documents WHERE source_id LIKE $1`, [`db-${id}-%`]);
        
        // Remove connection profile
        const result = await db.query('DELETE FROM database_connections WHERE id = $1 RETURNING id, name', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Database connection not found' });
        }

        res.json({ message: `Database connection '${result.rows[0].name}' deleted successfully` });
    } catch (err) {
        console.error(`Error deleting database ${req.params.id}:`, err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

