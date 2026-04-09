/**
 * Knowledge layer — Neon pgvector search + OpenAI embeddings.
 *
 * Connects to the support_brain database and provides:
 * - searchKnowledge(query, opts) — semantic search across knowledge_chunks
 * - searchFeedback(query, opts) — semantic search across support_feedback (rep corrections)
 * - recordFeedback(data) — store a rep correction for future learning
 * - embed(text) — generate a 1536-dim embedding via OpenAI text-embedding-3-small
 */

import pg from 'pg';
import OpenAI from 'openai';

const { Pool } = pg;

// ─── Neon DB connection ───
let pool = null;
let neonPassword = null;

async function getNeonPassword() {
  if (neonPassword) return neonPassword;
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  const branchId = process.env.NEON_BRANCH_ID;
  const resp = await fetch(
    `https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}/roles/neondb_owner/reveal_password`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!resp.ok) throw new Error(`Neon password retrieval failed: ${resp.status}`);
  const data = await resp.json();
  neonPassword = data.password;
  return neonPassword;
}

async function getPool() {
  if (pool) return pool;
  const password = await getNeonPassword();
  pool = new Pool({
    host: process.env.NEON_HOST,
    database: process.env.NEON_DB || 'support_brain',
    user: process.env.NEON_USER || 'neondb_owner',
    password,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
  return pool;
}

// ─── OpenAI embeddings (lazy init) ───
let openai = null;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export async function embed(text) {
  const resp = await getOpenAI().embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return resp.data[0].embedding; // 1536-dim float array
}

function vecToString(vec) {
  return '[' + vec.join(',') + ']';
}

// ─── Knowledge search ───

/**
 * Semantic search against knowledge_chunks table.
 * Returns top matches with similarity scores.
 */
export async function searchKnowledge(query, { limit = 8, domain = null, chunkType = null } = {}) {
  const db = await getPool();
  const queryVec = await embed(query);

  const conditions = ['kc.embedding_1536 IS NOT NULL'];
  const params = [vecToString(queryVec), limit];
  let paramIdx = 3;

  if (domain) {
    conditions.push(`kc.domain = $${paramIdx++}`);
    params.push(domain);
  }
  if (chunkType) {
    conditions.push(`kc.chunk_type = $${paramIdx++}`);
    params.push(chunkType);
  }

  const sql = `
    SELECT kc.id, kc.content, kc.domain, kc.section, kc.subsection,
           kc.chunk_type, kc.customer_symptoms, kc.error_codes,
           1 - (kc.embedding_1536 <=> $1::vector) AS similarity
    FROM knowledge_chunks kc
    WHERE ${conditions.join(' AND ')}
    ORDER BY kc.embedding_1536 <=> $1::vector
    LIMIT $2
  `;

  const { rows } = await db.query(sql, params);
  return rows;
}

// ─── Feedback search ───

/**
 * Search prior rep feedback/corrections for similar situations.
 * Helps the agent learn from past mistakes.
 */
export async function searchFeedback(query, { limit = 5 } = {}) {
  const db = await getPool();
  const queryVec = await embed(query);

  const sql = `
    SELECT id, conversation_id, customer_email, classified_as,
           original_draft, final_sent, rep_feedback, feedback_category,
           diff_summary,
           1 - (embedding <=> $1::vector) AS similarity
    FROM support_feedback
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;

  const { rows } = await db.query(sql, [vecToString(queryVec), limit]);
  return rows;
}

// ─── Feedback recording ───

/**
 * Record a rep's correction/feedback for future learning.
 * Also inserts a manual_feedback_* chunk into knowledge_chunks so it
 * surfaces in regular knowledge searches and survives weekly refresh.
 */
export async function recordFeedback({
  conversationId, customerEmail, classifiedAs,
  originalDraft, finalSent, repFeedback,
  feedbackCategory, diffSummary, repId,
}) {
  const db = await getPool();

  // Embed the combination of context + feedback for future semantic lookup
  const embeddingText = `Customer issue: ${diffSummary || ''}\nRep feedback: ${repFeedback || ''}\nFinal response: ${finalSent || ''}`;
  const vec = await embed(embeddingText);

  // Insert into support_feedback table
  const feedbackResult = await db.query(`
    INSERT INTO support_feedback
      (conversation_id, customer_email, classified_as, original_draft,
       final_sent, rep_feedback, feedback_category, diff_summary, embedding, rep_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10)
    RETURNING id
  `, [
    conversationId, customerEmail, classifiedAs,
    originalDraft, finalSent, repFeedback,
    feedbackCategory, diffSummary, vecToString(vec), repId,
  ]);

  const feedbackId = feedbackResult.rows[0].id;

  // Also insert as a manual knowledge chunk (survives weekly refresh)
  const chunkContent = [
    `## Support Feedback #${feedbackId}`,
    `Customer: ${customerEmail}`,
    `Category: ${classifiedAs || 'unknown'}`,
    '',
    `### What the rep corrected`,
    repFeedback || '(edited the draft directly)',
    '',
    `### Final approved response`,
    finalSent || '(not captured)',
    '',
    `### Correction summary`,
    diffSummary || '(no summary)',
  ].join('\n');

  await db.query(`
    INSERT INTO knowledge_chunks
      (content, domain, section, chunk_type, source_file, embedding_1536)
    VALUES ($1, 'support_patterns', $2, 'diagnostic', $3, $4::vector)
  `, [
    chunkContent,
    `Support Feedback #${feedbackId}`,
    `manual_feedback_${feedbackId}`,
    vecToString(vec),
  ]);

  return feedbackId;
}

// ─── DB health check ───
export async function checkDbHealth() {
  try {
    const db = await getPool();
    const { rows } = await db.query('SELECT count(*) as total FROM knowledge_chunks');
    const { rows: fbRows } = await db.query('SELECT count(*) as total FROM support_feedback');
    return {
      ok: true,
      knowledge_chunks: parseInt(rows[0].total),
      support_feedback: parseInt(fbRows[0].total),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
