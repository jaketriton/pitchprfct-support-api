#!/usr/bin/env node
/**
 * One-time migration: re-embed all knowledge_chunks from all-MiniLM-L6-v2 (384d)
 * to OpenAI text-embedding-3-small (1536d).
 *
 * Steps:
 * 1. Add embedding_1536 column (if not exists)
 * 2. Create support_feedback table (if not exists)
 * 3. Read all chunks that need re-embedding
 * 4. Batch-embed via OpenAI API
 * 5. Update rows with new embeddings
 * 6. Create HNSW index on embedding_1536
 *
 * Run: node scripts/migrate-embeddings.mjs
 * Requires: OPENAI_API_KEY, NEON_API_KEY, NEON_HOST, NEON_DB, NEON_USER,
 *           NEON_PROJECT_ID, NEON_BRANCH_ID in .env
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import OpenAI from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dotenv dependency)
try {
  const envPath = resolve(__dirname, '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const { Pool } = pg;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BATCH_SIZE = 100; // OpenAI embedding batch limit is 2048, but 100 is safe

async function getNeonPassword() {
  const resp = await fetch(
    `https://console.neon.tech/api/v2/projects/${process.env.NEON_PROJECT_ID}/branches/${process.env.NEON_BRANCH_ID}/roles/neondb_owner/reveal_password`,
    { headers: { Authorization: `Bearer ${process.env.NEON_API_KEY}` } }
  );
  if (!resp.ok) throw new Error(`Neon password retrieval failed: ${resp.status}`);
  return (await resp.json()).password;
}

async function main() {
  console.log('Connecting to Neon support_brain...');
  const password = await getNeonPassword();
  const pool = new Pool({
    host: process.env.NEON_HOST,
    database: process.env.NEON_DB || 'support_brain',
    user: process.env.NEON_USER || 'neondb_owner',
    password,
    ssl: { rejectUnauthorized: false },
  });

  // Step 1: Schema migrations
  console.log('\n--- Step 1: Schema migrations ---');

  // Add embedding_1536 column if not exists
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding_1536'
      ) THEN
        ALTER TABLE knowledge_chunks ADD COLUMN embedding_1536 vector(1536);
      END IF;
    END $$;
  `);
  console.log('  embedding_1536 column ready');

  // Create support_feedback table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_feedback (
      id SERIAL PRIMARY KEY,
      conversation_id VARCHAR(100),
      customer_email VARCHAR(255),
      classified_as VARCHAR(50),
      original_draft TEXT,
      final_sent TEXT,
      rep_feedback TEXT,
      feedback_category VARCHAR(50),
      diff_summary TEXT,
      embedding vector(1536),
      created_at TIMESTAMP DEFAULT NOW(),
      rep_id VARCHAR(50)
    );
  `);
  console.log('  support_feedback table ready');

  // Create HNSW index on support_feedback (if not exists)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_embedding
    ON support_feedback USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  `);
  console.log('  support_feedback HNSW index ready');

  // Step 2: Read chunks that need embedding
  console.log('\n--- Step 2: Reading chunks to re-embed ---');
  const { rows: chunks } = await pool.query(`
    SELECT id, content FROM knowledge_chunks
    WHERE embedding_1536 IS NULL AND content IS NOT NULL AND content != ''
    ORDER BY id
  `);
  console.log(`  ${chunks.length} chunks need re-embedding`);

  if (chunks.length === 0) {
    console.log('  All chunks already have 1536d embeddings. Nothing to do.');
  } else {
    // Step 3: Batch embed via OpenAI
    console.log('\n--- Step 3: Generating OpenAI embeddings ---');
    let processed = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map(c => c.content.slice(0, 8000)); // OpenAI limit safety

      const resp = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      });

      // Step 4: Update each row
      for (let j = 0; j < batch.length; j++) {
        const vec = resp.data[j].embedding;
        const vecStr = '[' + vec.join(',') + ']';
        await pool.query(
          'UPDATE knowledge_chunks SET embedding_1536 = $1::vector WHERE id = $2',
          [vecStr, batch[j].id]
        );
      }

      processed += batch.length;
      console.log(`  Embedded ${processed}/${chunks.length} chunks`);
    }
  }

  // Step 5: Create HNSW index on embedding_1536 (drop old if needed)
  console.log('\n--- Step 4: Creating HNSW index on embedding_1536 ---');
  await pool.query(`DROP INDEX IF EXISTS idx_chunks_embedding_1536;`);
  await pool.query(`
    CREATE INDEX idx_chunks_embedding_1536
    ON knowledge_chunks USING hnsw (embedding_1536 vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  `);
  console.log('  HNSW index on embedding_1536 created');

  // Step 6: Verify
  console.log('\n--- Step 5: Verification ---');
  const { rows: stats } = await pool.query(`
    SELECT
      count(*) as total,
      count(embedding) as has_384,
      count(embedding_1536) as has_1536
    FROM knowledge_chunks
  `);
  console.log(`  Total chunks: ${stats[0].total}`);
  console.log(`  With 384d embedding: ${stats[0].has_384}`);
  console.log(`  With 1536d embedding: ${stats[0].has_1536}`);

  const { rows: domains } = await pool.query(`
    SELECT domain, count(*) as cnt
    FROM knowledge_chunks
    WHERE embedding_1536 IS NOT NULL
    GROUP BY domain ORDER BY cnt DESC
  `);
  console.log('\n  By domain:');
  for (const d of domains) {
    console.log(`    ${d.domain}: ${d.cnt}`);
  }

  // Quick similarity test
  console.log('\n--- Step 6: Quick similarity test ---');
  const testQuery = 'my blast is not sending messages';
  const testResp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: testQuery,
  });
  const testVec = '[' + testResp.data[0].embedding.join(',') + ']';
  const { rows: testResults } = await pool.query(`
    SELECT section, chunk_type, domain,
           1 - (embedding_1536 <=> $1::vector) as similarity,
           left(content, 100) as preview
    FROM knowledge_chunks
    WHERE embedding_1536 IS NOT NULL
    ORDER BY embedding_1536 <=> $1::vector
    LIMIT 5
  `, [testVec]);

  console.log(`  Query: "${testQuery}"`);
  for (const r of testResults) {
    console.log(`    [${r.similarity.toFixed(3)}] ${r.domain}/${r.section} (${r.chunk_type})`);
    console.log(`      ${r.preview}...`);
  }

  console.log('\nMigration complete!');
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
