require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  user: process.env.PGUSER || process.env.PG_USER || 'postgres',
  host: process.env.PGHOST || process.env.PG_HOST || 'localhost',
  database: process.env.PGDATABASE || process.env.PG_DB || 'postgres',
  password: process.env.PGPASSWORD || process.env.PG_PASSWORD || 'password',
  port: process.env.PGPORT || process.env.PG_PORT || 5432,
});

async function initDb() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(sql);
      console.log('Database schema initialized successfully.');
    }
    
    // Idempotent table & column additions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS database_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        db_type VARCHAR(50) NOT NULL DEFAULT 'postgres',
        host VARCHAR(255),
        port INT,
        database_name VARCHAR(255) NOT NULL,
        username VARCHAR(255),
        password VARCHAR(255),
        ssl BOOLEAN DEFAULT false,
        filepath TEXT,
        options JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'CONNECTED',
        tables_count INT DEFAULT 0,
        last_synced_at TIMESTAMP WITH TIME ZONE,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'FILE_UPLOAD';
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_id VARCHAR(255);
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunks_count INT DEFAULT 0;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS entities_count INT DEFAULT 0;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS edges_count INT DEFAULT 0;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS embeddings_count INT DEFAULT 0;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS summaries_count INT DEFAULT 0;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
    `);
    console.log('Database tables & columns migrated successfully.');
  } catch (err) {
    console.error('Failed to initialize database schema:', err);
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  initDb,
};
