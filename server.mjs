/**
 * PitchPrfct Support Agent API
 *
 * Modes:
 *   /diagnose     — Fast API-only diagnostic (2 seconds, structured data)
 *   /investigate   — Full browser investigation (10-30 seconds, screenshots + deep data)
 *   /draft-reply   — AI-generated support reply draft (Claude Sonnet 4.6 + tool use)
 *   /intercom-webhook — Intercom webhook handler (@bot draft / @bot feedback)
 *
 * Deploy via Docker on Railway for persistent 24/7 operation.
 */

// Load .env file (if present) before any imports that read process.env
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envContent = readFileSync(resolve(__dirname, '.env'), 'utf-8');
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

import express from 'express';
import { investigate, MODULES } from './investigator.mjs';
import { searchKnowledge, searchFeedback, recordFeedback, checkDbHealth } from './knowledge.mjs';
import {
  getConversation, extractMessageHistory, getCustomerEmail,
  isBotTrigger, isBotFeedback, extractFeedback,
  postNote, formatDraftNote, verifyWebhook,
} from './intercom.mjs';
import { generateDraft, classifyConversation } from './drafter.mjs';

const app = express();

// Store raw body (Buffer) for webhook signature verification, then parse JSON
app.use((req, res, next) => {
  if (req.path === '/intercom-webhook') {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = {}; }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

const APP_URL = 'https://app.pitchprfct.com';
const ADMIN_EMAIL = process.env.PP_ADMIN_EMAIL || 'info@pitchprfct.com';
const ADMIN_PASSWORD = process.env.PP_ADMIN_PASSWORD;
const API_SECRET = process.env.API_SECRET;

// ─── Auth middleware ───
function checkAuth(req, res, next) {
  if (API_SECRET) {
    const secret = req.headers['x-api-secret'] || req.query.secret || req.body?.secret;
    if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Session cache for API-only mode ───
let sessionCache = { cookie: null, expiresAt: 0 };

async function getAdminSession() {
  if (sessionCache.cookie && Date.now() < sessionCache.expiresAt) return sessionCache.cookie;
  const resp = await fetch(`${APP_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    redirect: 'manual'
  });
  if (!resp.ok) throw new Error(`Login failed: HTTP ${resp.status}`);
  const cookie = resp.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('No session cookie');
  sessionCache = { cookie, expiresAt: Date.now() + 45 * 60 * 1000 };
  return cookie;
}

async function apiCall(cookie, method, path, body) {
  const opts = { method, headers: { 'Cookie': cookie, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${APP_URL}/api${path}`, opts);
  try { return { ok: resp.ok, status: resp.status, data: await resp.json() }; }
  catch { return { ok: resp.ok, status: resp.status, data: null }; }
}

// ──────────────────────────────────────────────
// ROUTE 1: Fast API-only diagnostic (2 seconds)
// ──────────────────────────────────────────────

async function diagnoseUser(email) {
  const cookie = await getAdminSession();
  const report = { customer_email: email, timestamp: new Date().toISOString(), mode: 'api',
    account: null, credits: null, system_status: null, campaigns: [], workflows: [], phone_numbers: [], errors: [] };

  const search = await apiCall(cookie, 'GET', `/admin-users/search?email=${encodeURIComponent(email)}`);
  if (!search.ok || !search.data?.length) { report.errors.push('User not found'); return report; }
  const user = search.data[0];

  const em = await apiCall(cookie, 'POST', `/admin-users/${user.id}/emulate`);
  if (!em.ok) { report.errors.push('Emulation failed'); return report; }

  try {
    const me = await apiCall(cookie, 'GET', '/auth/me');
    if (me.ok) report.account = {
      email: me.data.email, name: `${me.data.firstName || ''} ${me.data.lastName || ''}`.trim(),
      status: me.data.status, role: me.data.role, created_at: me.data.createdAt,
      is_admin_paused: user.adminPaused, pause_reasons: user.pauseReasons || [],
    };

    const credits = await apiCall(cookie, 'GET', '/credits');
    if (credits.ok) report.credits = {
      remaining: parseFloat(credits.data.remainingCredits), recharge_active: credits.data.rechargeActive,
      recharge_minimum: parseFloat(credits.data.rechargeMinimum),
      total_purchased: parseFloat(credits.data.totalCreditsPurchased),
      total_spend_usd: parseFloat(credits.data.totalCreditPurchaseSpend),
    };

    const campaigns = await apiCall(cookie, 'GET', '/campaigns');
    if (campaigns.ok) {
      const list = Array.isArray(campaigns.data) ? campaigns.data : campaigns.data?.campaigns || [];
      report.campaigns = list.map(c => ({ id: c.id, name: c.name, status: c.status, type: c.type,
        contact_count: c.contactCount || c.totalContacts || 0, created_at: c.createdAt }));
    }

    const workflows = await apiCall(cookie, 'GET', '/workflows');
    if (workflows.ok) {
      const list = Array.isArray(workflows.data) ? workflows.data : workflows.data?.workflows || [];
      report.workflows = list.map(w => ({ id: w.id, name: w.name, is_active: w.isActive, is_paused: w.isPaused,
        trigger_tag: w.triggerTag, enrolled_count: w.enrolledCount || 0 }));
    }

    const phones = await apiCall(cookie, 'GET', '/phone-numbers');
    if (phones.ok) {
      const list = Array.isArray(phones.data) ? phones.data : phones.data?.phoneNumbers || [];
      report.phone_numbers = list.map(p => ({ number: p.phoneNumber, is_compliant: p.isCompliant, is_enabled: p.isEnabled }));
    }

    report.system_status = {
      account_active: report.account?.status === 'active',
      admin_paused: report.account?.is_admin_paused || false,
      low_credits: report.credits ? report.credits.remaining < 5000 : null,
      stuck_campaigns: report.campaigns.filter(c => ['processing', 'stuck'].includes(c.status)).length,
      paused_workflows: report.workflows.filter(w => w.is_paused).length,
      non_compliant_numbers: report.phone_numbers.filter(p => !p.is_compliant).length,
      has_recharge: report.credits?.recharge_active || false,
    };
  } finally {
    await apiCall(cookie, 'POST', '/admin-users/emulation/stop');
  }
  return report;
}

// ──────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────

// Fast API diagnostic
app.all('/diagnose', checkAuth, async (req, res) => {
  const email = req.query.email || req.body?.email;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    console.log(`[DIAGNOSE] ${email}`);
    const report = await diagnoseUser(email);
    res.json(report);
  } catch (err) {
    console.error(`[DIAGNOSE ERROR] ${email}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full browser investigation
app.all('/investigate', checkAuth, async (req, res) => {
  const email = req.query.email || req.body?.email;
  if (!email) return res.status(400).json({ error: 'email required' });

  const pagesParam = req.query.pages || req.body?.pages;
  const pages = pagesParam ? pagesParam.split(',').map(p => p.trim()) : undefined;
  const campaignId = req.query.campaign_id || req.body?.campaign_id;
  const workflowId = req.query.workflow_id || req.body?.workflow_id;

  try {
    console.log(`[INVESTIGATE] ${email} | pages=${pages?.join(',') || 'all'} | campaign=${campaignId || '-'} | workflow=${workflowId || '-'}`);
    const result = await investigate(email, { pages, campaignId, workflowId });
    res.json(result);
  } catch (err) {
    console.error(`[INVESTIGATE ERROR] ${email}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Screenshot a specific page as the user (returns PNG image)
app.get('/screenshot', checkAuth, async (req, res) => {
  const { email, page: pageName } = req.query;
  if (!email || !pageName) return res.status(400).json({ error: 'email and page required' });
  
  try {
    const result = await investigate(email, { pages: [pageName] });
    const pageResult = result.pages?.[pageName];
    if (pageResult?.screenshot) {
      const buffer = Buffer.from(pageResult.screenshot, 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', `inline; filename="${email}_${pageName}.png"`);
      res.send(buffer);
    } else {
      res.status(404).json({ error: 'Screenshot not available', details: result.errors });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// ROUTE 4: Search knowledge base
// ──────────────────────────────────────────────

app.post('/search-knowledge', checkAuth, async (req, res) => {
  const { query, domain, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const results = await searchKnowledge(query, { domain, limit: limit || 8 });
    res.json({ query, results });
  } catch (err) {
    console.error('[SEARCH-KNOWLEDGE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// ROUTE 5: Search feedback
// ──────────────────────────────────────────────

app.post('/search-feedback', checkAuth, async (req, res) => {
  const { query, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const results = await searchFeedback(query, { limit: limit || 5 });
    res.json({ query, results });
  } catch (err) {
    console.error('[SEARCH-FEEDBACK ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// ROUTE 6: Draft a reply (direct API call)
// ──────────────────────────────────────────────

app.post('/draft-reply', checkAuth, async (req, res) => {
  const { email, conversation_id, messages, feedback, previous_draft } = req.body;

  // Two modes: pass a conversation_id (fetches from Intercom) or pass messages directly
  let conversationHistory;
  let customerEmail = email;

  if (conversation_id) {
    try {
      const convo = await getConversation(conversation_id);
      conversationHistory = extractMessageHistory(convo);
      customerEmail = customerEmail || getCustomerEmail(convo);
    } catch (err) {
      return res.status(400).json({ error: `Failed to fetch conversation: ${err.message}` });
    }
  } else if (messages) {
    conversationHistory = messages;
  } else {
    return res.status(400).json({ error: 'conversation_id or messages required' });
  }

  if (!customerEmail) return res.status(400).json({ error: 'Could not determine customer email' });

  try {
    console.log(`[DRAFT-REPLY] ${customerEmail} | convo=${conversation_id || 'direct'} | feedback=${!!feedback}`);
    const result = await generateDraft({
      customerEmail,
      conversationHistory,
      feedbackContext: feedback || null,
      previousDraft: previous_draft || null,
    });
    res.json(result);
  } catch (err) {
    console.error(`[DRAFT-REPLY ERROR] ${customerEmail}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// ROUTE 7: Intercom webhook handler
// ──────────────────────────────────────────────

// In-memory store of active drafts per conversation (for feedback loop)
const activeDrafts = new Map(); // conversationId -> { draft, reasoning, ... }

app.post('/intercom-webhook', async (req, res) => {
  // Verify webhook signature
  const signature = req.headers['x-hub-signature'];
  const rawBody = req.rawBody || '';

  if (!verifyWebhook(rawBody, signature)) {
    console.warn('[WEBHOOK] Invalid signature');
    return res.status(401).send('Invalid signature');
  }

  // Parse the webhook payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  // Acknowledge immediately — we process async
  res.status(200).send('ok');

  // Process the webhook event
  try {
    await handleWebhookEvent(payload);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
  }
});

async function handleWebhookEvent(payload) {
  const topic = payload.topic;
  console.log(`[WEBHOOK] Received event: topic=${topic}`);

  // We care about: conversation.admin.noted (private note added)
  // This is where @bot draft and @bot <feedback> come from
  if (topic !== 'conversation.admin.noted') {
    console.log(`[WEBHOOK] Ignoring topic: ${topic}`);
    return;
  }

  const item = payload.data?.item || payload.data || {};
  // Intercom can nest the conversation in different ways depending on version/topic.
  // Try multiple paths to extract the conversation ID.
  const conversationId =
    item?.id ||
    item?.conversation?.id ||
    item?.conversation_id ||
    payload.data?.id;

  console.log(`[WEBHOOK] Extracted conversationId=${conversationId} | item.type=${item?.type}`);

  if (!conversationId) {
    console.log(`[WEBHOOK] No conversation ID. Payload keys: ${Object.keys(payload || {}).join(',')}, data keys: ${Object.keys(payload.data || {}).join(',')}, item keys: ${Object.keys(item || {}).slice(0, 20).join(',')}`);
    return;
  }

  // If the webhook payload already contains the full conversation, use it directly.
  // Otherwise, fetch from the API.
  let conversation;
  if (item?.type === 'conversation' && item?.conversation_parts) {
    console.log(`[WEBHOOK] Using conversation from webhook payload (${item.conversation_parts?.conversation_parts?.length || 0} parts)`);
    conversation = item;
  } else {
    console.log(`[WEBHOOK] Fetching conversation ${conversationId} from API`);
    conversation = await getConversation(String(conversationId));
  }
  const history = extractMessageHistory(conversation);
  const customerEmail = getCustomerEmail(conversation);

  if (!customerEmail) {
    console.log(`[WEBHOOK] No customer email found for conversation ${conversationId}`);
    return;
  }

  // Find the most recent admin note
  const lastNote = [...history].reverse().find(m => m.type === 'note' && m.role === 'admin');
  if (!lastNote) return;

  // Check if it's a @bot trigger
  if (isBotTrigger(lastNote)) {
    console.log(`[WEBHOOK] @bot draft triggered for ${customerEmail} in conversation ${conversationId}`);

    const result = await generateDraft({ customerEmail, conversationHistory: history });

    // Store the draft for potential feedback loop
    activeDrafts.set(conversationId, {
      draft: result.draft,
      reasoning: result.reasoning,
      customerEmail,
      createdAt: Date.now(),
    });

    // Post the draft as a private note
    const noteBody = formatDraftNote(result);
    await postNote(conversationId, noteBody);

    // Classify for analytics
    const classification = await classifyConversation(history, customerEmail);
    console.log(`[WEBHOOK] Draft posted. Category: ${classification.category}, Confidence: ${result.confidence}`);
    return;
  }

  // Check if it's @bot feedback (refine a previous draft)
  if (isBotFeedback(lastNote)) {
    const feedback = extractFeedback(lastNote.body);
    const existingDraft = activeDrafts.get(conversationId);

    if (!existingDraft) {
      await postNote(conversationId, '<i>No active draft to refine. Use <b>@bot draft</b> to generate a new one first.</i>');
      return;
    }

    console.log(`[WEBHOOK] @bot feedback for ${customerEmail}: "${feedback.slice(0, 100)}"`);

    const result = await generateDraft({
      customerEmail,
      conversationHistory: history,
      feedbackContext: feedback,
      previousDraft: existingDraft.draft,
    });

    // Update the stored draft
    activeDrafts.set(conversationId, {
      draft: result.draft,
      reasoning: result.reasoning,
      customerEmail,
      feedback,
      previousDraft: existingDraft.draft,
      createdAt: Date.now(),
    });

    // Post the regenerated draft
    const noteBody = formatDraftNote({ ...result, feedbackContext: feedback });
    await postNote(conversationId, noteBody);

    // Auto-record the feedback for future learning
    try {
      await recordFeedback({
        conversationId,
        customerEmail,
        classifiedAs: null,
        originalDraft: existingDraft.draft,
        finalSent: null, // We don't know what was finally sent yet
        repFeedback: feedback,
        feedbackCategory: 'regeneration',
        diffSummary: `Rep asked to adjust: ${feedback.slice(0, 200)}`,
        repId: lastNote.author,
      });
    } catch (err) {
      console.error('[WEBHOOK] Failed to record feedback:', err.message);
    }

    return;
  }
}

// Prune old activeDrafts every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of activeDrafts) {
    if (v.createdAt < cutoff) activeDrafts.delete(k);
  }
}, 30 * 60 * 1000);

// ──────────────────────────────────────────────
// ROUTE 8: Health check (extended)
// ──────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const dbHealth = await checkDbHealth().catch(() => ({ ok: false, error: 'unreachable' }));
  res.json({
    status: 'ok',
    service: 'pitchprfct-support-agent',
    capabilities: ['diagnose', 'investigate', 'draft-reply', 'search-knowledge', 'intercom-webhook'],
    vector_db: dbHealth,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PitchPrfct Support Agent API on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /diagnose?email=...              Fast API diagnostic (2s)`);
  console.log(`  GET  /investigate?email=...            Full browser investigation (15-30s)`);
  console.log(`  GET  /screenshot?email=...&page=...    Returns PNG`);
  console.log(`  POST /search-knowledge                 Vector DB search`);
  console.log(`  POST /search-feedback                  Rep feedback search`);
  console.log(`  POST /draft-reply                      AI draft generation`);
  console.log(`  POST /intercom-webhook                 Intercom webhook handler`);
  console.log(`  Available pages: ${Object.keys(MODULES).join(', ')}`);
});
