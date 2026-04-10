/**
 * Polling-based trigger for the support agent.
 *
 * Every POLL_INTERVAL_MS, this module:
 * 1. Queries Intercom for conversations updated in the last POLL_LOOKBACK_MINUTES
 * 2. For each recent conversation, looks at admin notes we haven't processed yet
 * 3. If a note matches "@bot draft" or "@bot <feedback>", triggers the drafter
 * 4. Posts the resulting draft as a private note
 * 5. Marks the note_id as processed so we never re-process
 *
 * This bypasses Intercom webhooks entirely, avoiding self-loop prevention
 * and other webhook-subscription issues.
 */

import pg from 'pg';
import {
  getConversation, extractMessageHistory, getCustomerEmail,
  isBotTrigger, isBotFeedback, extractFeedback,
  postNote, formatDraftNote,
} from './intercom.mjs';
import { generateDraft } from './drafter.mjs';
import { recordFeedback } from './knowledge.mjs';

const INTERCOM_BASE = 'https://api.intercom.io';
// These are read lazily inside functions so .env loading in server.mjs
// takes effect before we use them.

// In-memory draft cache for feedback loops (mirrors webhook handler)
export const activeDrafts = new Map();

// DB pool (created lazily to share with the rest of the app)
let _pool = null;
async function getPool() {
  if (_pool) return _pool;
  const { readFileSync } = await import('fs');
  const { Pool } = pg;
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  const branchId = process.env.NEON_BRANCH_ID;
  const resp = await fetch(
    `https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}/roles/neondb_owner/reveal_password`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  const { password } = await resp.json();
  _pool = new Pool({
    host: process.env.NEON_HOST,
    database: process.env.NEON_DB,
    user: process.env.NEON_USER,
    password,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return _pool;
}

// ─── Processed notes tracking ───

async function isNoteProcessed(noteId) {
  const db = await getPool();
  const { rowCount } = await db.query(
    'SELECT 1 FROM processed_notes WHERE note_id = $1',
    [String(noteId)]
  );
  return rowCount > 0;
}

async function markNoteProcessed(noteId, conversationId, commandType) {
  const db = await getPool();
  // Upsert so we can update command_type after completion
  // (we mark 'in-progress' before running, then final status after)
  await db.query(
    `INSERT INTO processed_notes (note_id, conversation_id, command_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (note_id) DO UPDATE
       SET command_type = EXCLUDED.command_type,
           processed_at = NOW()`,
    [String(noteId), String(conversationId), commandType]
  );
}

// ─── Intercom polling ───

/**
 * Search Intercom for conversations updated in the last N minutes.
 * Returns a list of conversation IDs (does not fetch full content yet).
 */
async function searchRecentConversations(lookbackMinutes) {
  const cutoffUnix = Math.floor(Date.now() / 1000) - lookbackMinutes * 60;

  const resp = await fetch(`${INTERCOM_BASE}/conversations/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.INTERCOM_API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: {
        field: 'updated_at',
        operator: '>',
        value: cutoffUnix,
      },
      pagination: { per_page: 50 },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Intercom search failed: ${resp.status} ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return (data.conversations || []).map(c => c.id);
}

// ─── Main poll tick ───

async function processBotCommand(conversation, history, note) {
  const conversationId = conversation.id;
  const customerEmail = getCustomerEmail(conversation);

  if (!customerEmail) {
    console.log(`[POLLER] No customer email for conversation ${conversationId}`);
    await markNoteProcessed(note.note_id, conversationId, 'skipped-no-email');
    return;
  }

  if (isBotTrigger(note)) {
    console.log(`[POLLER] @bot draft triggered for ${customerEmail} on ${conversationId}`);

    const result = await generateDraft({
      customerEmail,
      conversationHistory: history,
    });

    activeDrafts.set(String(conversationId), {
      draft: result.draft,
      reasoning: result.reasoning,
      customerEmail,
      createdAt: Date.now(),
    });

    await postNote(conversationId, formatDraftNote(result));
    await markNoteProcessed(note.note_id, conversationId, 'draft');
    console.log(`[POLLER] Draft posted for ${conversationId} (confidence=${result.confidence})`);
    return;
  }

  if (isBotFeedback(note)) {
    const feedback = extractFeedback(note.body);
    const existing = activeDrafts.get(String(conversationId));

    console.log(`[POLLER] @bot feedback for ${customerEmail}: "${feedback.slice(0, 100)}"`);

    if (!existing) {
      await postNote(conversationId,
        '<i>No active draft to refine. Use <b>@bot draft</b> to generate a new one first.</i>');
      await markNoteProcessed(note.note_id, conversationId, 'feedback-no-draft');
      return;
    }

    const result = await generateDraft({
      customerEmail,
      conversationHistory: history,
      feedbackContext: feedback,
      previousDraft: existing.draft,
    });

    activeDrafts.set(String(conversationId), {
      draft: result.draft,
      reasoning: result.reasoning,
      customerEmail,
      feedback,
      previousDraft: existing.draft,
      createdAt: Date.now(),
    });

    await postNote(conversationId, formatDraftNote({ ...result, feedbackContext: feedback }));
    await markNoteProcessed(note.note_id, conversationId, 'feedback');

    // Auto-record feedback for future learning
    try {
      await recordFeedback({
        conversationId,
        customerEmail,
        classifiedAs: null,
        originalDraft: existing.draft,
        finalSent: null,
        repFeedback: feedback,
        feedbackCategory: 'regeneration',
        diffSummary: `Rep asked to adjust: ${feedback.slice(0, 200)}`,
        repId: note.author,
      });
      console.log(`[POLLER] Feedback recorded for future learning`);
    } catch (err) {
      console.error(`[POLLER] Failed to record feedback: ${err.message}`);
    }
  }
}

// Prevent concurrent tick executions — drafter calls can take 30-60s,
// and we don't want multiple ticks double-processing the same note.
let tickInFlight = false;

async function pollTick() {
  if (tickInFlight) {
    // Silently skip; a previous tick is still running.
    return;
  }
  tickInFlight = true;

  const lookbackMin = parseInt(process.env.POLL_LOOKBACK_MINUTES || '10', 10);
  try {
    const convoIds = await searchRecentConversations(lookbackMin);
    if (convoIds.length === 0) return;

    let botCommandsFound = 0;

    for (const convoId of convoIds) {
      let conversation;
      try {
        conversation = await getConversation(convoId);
      } catch (err) {
        console.error(`[POLLER] Failed to fetch convo ${convoId}: ${err.message}`);
        continue;
      }

      const history = extractMessageHistory(conversation);

      // Find all admin notes that match @bot commands and are not yet processed
      for (const msg of history) {
        if (msg.type !== 'note') continue;
        if (msg.role !== 'admin') continue;
        if (!msg.note_id) continue;

        const isCommand = isBotTrigger(msg) || isBotFeedback(msg);
        if (!isCommand) continue;

        if (await isNoteProcessed(msg.note_id)) continue;

        // CRITICAL: mark as processed BEFORE running the drafter,
        // not after. Otherwise a slow drafter means the next tick
        // sees the same unprocessed note and re-triggers.
        await markNoteProcessed(msg.note_id, convoId, 'in-progress');

        botCommandsFound++;
        try {
          await processBotCommand(conversation, history, msg);
        } catch (err) {
          console.error(`[POLLER] Error processing note ${msg.note_id}: ${err.message}`);
          // Already marked as processed above, so this won't loop.
        }
      }
    }

    if (botCommandsFound > 0) {
      console.log(`[POLLER] Tick complete: scanned ${convoIds.length} convos, processed ${botCommandsFound} @bot commands`);
    }
  } catch (err) {
    console.error(`[POLLER] Tick failed: ${err.message}`);
  } finally {
    tickInFlight = false;
  }
}

// ─── Startup ───

let pollInterval = null;

export function startPoller() {
  if (pollInterval) return;
  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS || '20000', 10);
  const lookbackMin = parseInt(process.env.POLL_LOOKBACK_MINUTES || '10', 10);
  console.log(`[POLLER] Starting poll loop (interval=${intervalMs}ms, lookback=${lookbackMin}min)`);

  // First tick immediately, then on interval
  pollTick();
  pollInterval = setInterval(pollTick, intervalMs);
}

export function stopPoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
