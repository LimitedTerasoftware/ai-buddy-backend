-- schema.sql
-- Create the documents table for tracking uploaded files and connector items

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID, -- For future tenant isolation
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT,
    source_type VARCHAR(50) DEFAULT 'FILE_UPLOAD', -- FILE_UPLOAD, ONEDRIVE, OUTLOOK, WEBSCRAPER, etc.
    source_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'PENDING', -- PENDING, UPLOADED, INGESTED, FAILED
    chunks_count INT DEFAULT 0,
    entities_count INT DEFAULT 0,
    edges_count INT DEFAULT 0,
    embeddings_count INT DEFAULT 0,
    summaries_count INT DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trigger to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_documents_modtime ON documents;
CREATE TRIGGER update_documents_modtime
    BEFORE UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TABLE IF NOT EXISTS database_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    db_type VARCHAR(50) NOT NULL DEFAULT 'postgres', -- postgres, mysql, sqlite
    host VARCHAR(255),
    port INT,
    database_name VARCHAR(255) NOT NULL,
    username VARCHAR(255),
    password VARCHAR(255),
    ssl BOOLEAN DEFAULT false,
    filepath TEXT,
    options JSONB DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'CONNECTED', -- CONNECTED, DISCONNECTED, ERROR
    tables_count INT DEFAULT 0,
    last_synced_at TIMESTAMP WITH TIME ZONE,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_database_connections_modtime ON database_connections;
CREATE TRIGGER update_database_connections_modtime
    BEFORE UPDATE ON database_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

