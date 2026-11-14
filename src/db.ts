import Database from 'better-sqlite3';
import path from 'path';

export interface DocumentChunk {
  id?: number;
  tenantId: string;
  documentId: string;
  title: string;
  chunkIndex: number;
  content: string;
  embeddingJson?: string;
  createdAt?: string;
}

export class VectorDatabase {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Tabla de documentos indexados con partición estricta por tenantId
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, document_id)
      );

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id, document_id) REFERENCES knowledge_documents(tenant_id, document_id) ON DELETE CASCADE,
        UNIQUE(tenant_id, document_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON knowledge_chunks(tenant_id);
    `);
  }

  public upsertDocument(tenantId: string, documentId: string, title: string, content: string): number {
    const upsertDoc = this.db.prepare(`
      INSERT INTO knowledge_documents (tenant_id, document_id, title, content)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, document_id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        created_at = CURRENT_TIMESTAMP
    `);

    const deleteOldChunks = this.db.prepare(`
      DELETE FROM knowledge_chunks WHERE tenant_id = ? AND document_id = ?
    `);

    const insertChunk = this.db.prepare(`
      INSERT INTO knowledge_chunks (tenant_id, document_id, chunk_index, content)
      VALUES (?, ?, ?, ?)
    `);

    // Chunking KISS con límite seguro (aprox 1000 chars por chunk, solapamiento de 100 chars)
    const chunks = this.createChunks(content, 1000, 100);

    const transaction = this.db.transaction(() => {
      upsertDoc.run(tenantId, documentId, title, content);
      deleteOldChunks.run(tenantId, documentId);

      chunks.forEach((chunkContent, index) => {
        insertChunk.run(tenantId, documentId, index, chunkContent);
      });
    });

    transaction();
    return chunks.length;
  }

  public searchKnowledge(tenantId: string, query: string, limit: number = 3): DocumentChunk[] {
    // Filtro relacional estricto obligatorio por tenantId (Invariante Linus + OWASP LLM)
    const stmt = this.db.prepare(`
      SELECT c.tenant_id as tenantId, c.document_id as documentId, d.title as title,
             c.chunk_index as chunkIndex, c.content as content
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON c.tenant_id = d.tenant_id AND c.document_id = d.document_id
      WHERE c.tenant_id = ?
      LIMIT ?
    `);

    const rows = stmt.all(tenantId, limit) as DocumentChunk[];
    return rows;
  }

  private createChunks(text: string, chunkSize: number, overlap: number): string[] {
    if (text.length <= chunkSize) {
      return [text];
    }
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.slice(start, end));
      if (end === text.length) break;
      start += chunkSize - overlap;
    }
    return chunks;
  }

  public close() {
    this.db.close();
  }
}

// Instancia singleton compartida en memoria para tests y ejecución local
export const dbInstance = new VectorDatabase(process.env.SQLITE_DB_PATH || ':memory:');
