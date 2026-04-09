/**
 * Intercom API client for the support agent.
 *
 * Capabilities:
 * - Read full conversation history (messages + notes)
 * - Post private notes (agent drafts)
 * - Search help articles
 * - Extract customer email from conversation
 * - Webhook signature verification
 */

import crypto from 'crypto';

const INTERCOM_BASE = 'https://api.intercom.io';
const TOKEN = process.env.INTERCOM_API_TOKEN;
const WEBHOOK_SECRET = process.env.INTERCOM_WEBHOOK_SECRET;

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ─── Conversation reading ───

/**
 * Fetch a full conversation including all message parts.
 * Returns the conversation object with parts[].
 */
export async function getConversation(conversationId) {
  const resp = await fetch(`${INTERCOM_BASE}/conversations/${conversationId}?display_as=plaintext`, {
    headers: headers(),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Intercom getConversation ${resp.status}: ${body}`);
  }
  return resp.json();
}

/**
 * Extract a structured message history from a conversation object.
 * Returns an array of { role, author, body, created_at, type } objects,
 * ordered chronologically.
 */
export function extractMessageHistory(conversation) {
  const messages = [];

  // Opening message from the customer
  if (conversation.source) {
    messages.push({
      role: 'customer',
      author: conversation.source.author?.name || conversation.source.author?.email || 'Customer',
      body: conversation.source.body || '',
      created_at: conversation.created_at,
      type: 'message',
    });
  }

  // Conversation parts (replies, notes, assignments, etc.)
  const parts = conversation.conversation_parts?.conversation_parts || [];
  for (const part of parts) {
    if (!part.body && part.part_type !== 'note') continue;

    const isAdmin = part.author?.type === 'admin' || part.author?.type === 'bot';
    const isNote = part.part_type === 'note';

    messages.push({
      role: isAdmin ? 'admin' : 'customer',
      author: part.author?.name || part.author?.email || (isAdmin ? 'Support' : 'Customer'),
      body: part.body || '',
      created_at: part.created_at,
      type: isNote ? 'note' : 'message',
      part_type: part.part_type,
      note_id: part.id,
    });
  }

  return messages.sort((a, b) => a.created_at - b.created_at);
}

/**
 * Get the customer's email from a conversation.
 */
export function getCustomerEmail(conversation) {
  // Try the source author first
  if (conversation.source?.author?.email) return conversation.source.author.email;
  // Try contacts
  const contacts = conversation.contacts?.contacts || [];
  for (const c of contacts) {
    if (c.email) return c.email;
  }
  // Try tags / custom attributes
  if (conversation.custom_attributes?.email) return conversation.custom_attributes.email;
  return null;
}

/**
 * Check if a conversation part is a "@bot draft" trigger from an admin.
 */
export function isBotTrigger(part) {
  if (!part.body) return false;
  const text = part.body.toLowerCase().trim();
  return text.startsWith('@bot draft') || text.startsWith('@bot help') || text === '@bot';
}

/**
 * Check if a conversation part is "@bot <feedback>" for regeneration.
 */
export function isBotFeedback(part) {
  if (!part.body) return false;
  const text = part.body.toLowerCase().trim();
  return text.startsWith('@bot ') && !isBotTrigger(part);
}

/**
 * Extract the feedback text from a "@bot <feedback>" message.
 */
export function extractFeedback(body) {
  return body.replace(/^@bot\s*/i, '').trim();
}

// ─── Posting ───

// Cache of the bot's admin ID (fetched from /me on first use)
let cachedBotAdminId = null;

async function getBotAdminId() {
  if (cachedBotAdminId) return cachedBotAdminId;
  if (process.env.BOT_ADMIN_ID) {
    cachedBotAdminId = process.env.BOT_ADMIN_ID;
    return cachedBotAdminId;
  }
  // Fetch from /me endpoint using the workspace token
  const resp = await fetch(`${INTERCOM_BASE}/me`, { headers: headers() });
  if (!resp.ok) throw new Error(`Could not fetch bot admin ID: ${resp.status}`);
  const me = await resp.json();
  cachedBotAdminId = me.id;
  return cachedBotAdminId;
}

/**
 * Post a private note on a conversation (visible only to teammates).
 * This is how the agent delivers draft replies for review.
 * admin_id is required by Intercom — defaults to the token owner's admin ID.
 */
export async function postNote(conversationId, body, adminId = null) {
  const resolvedAdminId = adminId || (await getBotAdminId());

  const resp = await fetch(`${INTERCOM_BASE}/conversations/${conversationId}/reply`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      message_type: 'note',
      type: 'admin',
      admin_id: resolvedAdminId,
      body,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Intercom postNote ${resp.status}: ${errBody}`);
  }
  return resp.json();
}

/**
 * Post a public reply on a conversation (visible to customer).
 * Only used if auto-send is ever enabled (not in v1 — all replies go through Rudy).
 */
export async function postReply(conversationId, body, adminId) {
  const resp = await fetch(`${INTERCOM_BASE}/conversations/${conversationId}/reply`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      message_type: 'comment',
      type: 'admin',
      admin_id: adminId,
      body,
    }),
  });
  if (!resp.ok) throw new Error(`Intercom postReply ${resp.status}`);
  return resp.json();
}

// ─── Help articles ───

/**
 * Search Intercom help articles.
 */
export async function searchArticles(query) {
  const resp = await fetch(`${INTERCOM_BASE}/articles/search`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ phrase: query }),
  });
  if (!resp.ok) {
    // Fallback: list articles if search endpoint not available
    return listArticles();
  }
  const data = await resp.json();
  return (data.data || data.articles || []).slice(0, 5).map(a => ({
    id: a.id,
    title: a.title,
    description: a.description || '',
    body: (a.body || '').slice(0, 2000),
    url: a.url,
  }));
}

/**
 * List published help articles.
 */
async function listArticles() {
  const resp = await fetch(`${INTERCOM_BASE}/articles?per_page=50`, {
    headers: headers(),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.data || []).filter(a => a.state === 'published').slice(0, 10).map(a => ({
    id: a.id,
    title: a.title,
    body: (a.body || '').slice(0, 1000),
  }));
}

/**
 * Get a specific article by ID.
 */
export async function getArticle(articleId) {
  const resp = await fetch(`${INTERCOM_BASE}/articles/${articleId}`, {
    headers: headers(),
  });
  if (!resp.ok) return null;
  const a = await resp.json();
  return {
    id: a.id,
    title: a.title,
    body: (a.body || '').slice(0, 5000),
    url: a.url,
  };
}

// ─── Webhook verification ───

/**
 * Verify an Intercom webhook signature.
 * Intercom sends X-Hub-Signature header with SHA1 HMAC.
 */
export function verifyWebhook(rawBody, signature) {
  const secret = process.env.INTERCOM_WEBHOOK_SECRET;
  if (!secret) return true; // Skip verification if no secret configured
  if (!signature) {
    console.warn('[WEBHOOK] No X-Hub-Signature header present');
    return false;
  }
  // rawBody should be a Buffer; HMAC over raw bytes
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
  const sha1 = 'sha1=' + crypto.createHmac('sha1', secret).update(body).digest('hex');
  const sha256 = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  if (signature === sha1 || signature === sha256) return true;

  console.warn(`[WEBHOOK] Signature mismatch. received="${signature}" computed_sha1="${sha1}" computed_sha256="${sha256}" body_len=${body.length} body_preview="${body.slice(0, 120).toString('utf8')}"`);
  return false;
}

// ─── Formatting ───

/**
 * Format a draft response as an Intercom private note.
 * Includes the draft, reasoning, sources, and feedback instructions.
 */
export function formatDraftNote({ draft, reasoning, sources, confidence, needsEscalation, feedbackContext }) {
  const lines = [];

  if (feedbackContext) {
    lines.push('<b>Regenerated draft</b> (incorporating your feedback)');
    lines.push(`<i>Your feedback: "${feedbackContext}"</i>`);
    lines.push('');
  }

  lines.push('<b>Draft reply for review:</b>');
  lines.push('');
  lines.push(draft);
  lines.push('');
  lines.push('---');

  if (confidence != null) {
    const pct = Math.round(confidence * 100);
    lines.push(`<i>Confidence: ${pct}%</i>`);
  }

  if (needsEscalation) {
    lines.push('<b>This may need escalation to engineering.</b>');
  }

  if (sources?.length > 0) {
    lines.push('<i>Sources: ' + sources.join(', ') + '</i>');
  }

  if (reasoning) {
    lines.push(`<i>Reasoning: ${reasoning}</i>`);
  }

  lines.push('');
  lines.push('<i>To refine this draft, reply to this note starting with <b>@bot</b> followed by your feedback.</i>');
  lines.push('<i>To send, copy the draft above into a reply to the customer.</i>');

  return lines.join('\n');
}
