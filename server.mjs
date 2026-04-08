/**
 * PitchPrfct Support Agent API
 * 
 * Two modes:
 *   /diagnose  — Fast API-only diagnostic (2 seconds, structured data)
 *   /investigate — Full browser investigation (10-30 seconds, screenshots + deep data)
 * 
 * Deploy via Docker on Railway/Fly.io/AWS for persistent 24/7 operation.
 */

import express from 'express';
import { investigate, MODULES } from './investigator.mjs';

const app = express();
app.use(express.json());

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pitchprfct-support-agent', capabilities: ['diagnose', 'investigate'] });
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PitchPrfct Support Agent API on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET /diagnose?email=...         Fast API diagnostic (2s)`);
  console.log(`  GET /investigate?email=...       Full browser investigation (15-30s)`);
  console.log(`  GET /investigate?email=...&pages=campaigns,workflows`);
  console.log(`  GET /investigate?email=...&workflow_id=3898`);
  console.log(`  GET /screenshot?email=...&page=dashboard  Returns PNG`);
  console.log(`  Available pages: ${Object.keys(MODULES).join(', ')}`);
});
