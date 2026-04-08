/**
 * PitchPrfct Support Agent Diagnostic API
 * 
 * Exposes a single endpoint that logs into app.pitchprfct.com as an admin,
 * emulates a customer's account, pulls diagnostic data, and returns it as JSON.
 * 
 * Called by Intercom Data Connectors when the AI agent needs to investigate
 * a customer's account.
 */

import express from 'express';

const app = express();
app.use(express.json());

const APP_URL = 'https://app.pitchprfct.com';
const ADMIN_EMAIL = process.env.PP_ADMIN_EMAIL || 'info@pitchprfct.com';
const ADMIN_PASSWORD = process.env.PP_ADMIN_PASSWORD;
const API_SECRET = process.env.API_SECRET; // Optional: protect the endpoint

// ─── Session cache so we don't re-login on every request ───
let sessionCache = { cookie: null, expiresAt: 0 };

async function getAdminSession() {
  // Return cached session if still valid (45 min TTL)
  if (sessionCache.cookie && Date.now() < sessionCache.expiresAt) {
    return sessionCache.cookie;
  }

  const resp = await fetch(`${APP_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    redirect: 'manual'
  });

  if (!resp.ok) throw new Error(`Login failed: HTTP ${resp.status}`);
  
  const setCookieHeader = resp.headers.get('set-cookie');
  if (!setCookieHeader) throw new Error('Login failed: no session cookie returned');
  
  // Extract just the connect.sid cookie
  const cookie = setCookieHeader.split(';')[0];
  sessionCache = { cookie, expiresAt: Date.now() + 45 * 60 * 1000 };
  return cookie;
}

async function apiCall(cookie, method, path, body = null) {
  const opts = {
    method,
    headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${APP_URL}/api${path}`, opts);
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch { return { ok: resp.ok, status: resp.status, data: text }; }
}

// ─── Core diagnostic function ───
async function diagnoseUser(customerEmail) {
  const cookie = await getAdminSession();
  const report = {
    customer_email: customerEmail,
    timestamp: new Date().toISOString(),
    account: null,
    credits: null,
    system_status: null,
    campaigns: [],
    workflows: [],
    phone_numbers: [],
    errors: []
  };

  try {
    // 1. Find user
    const search = await apiCall(cookie, 'GET', `/admin-users/search?email=${encodeURIComponent(customerEmail)}`);
    if (!search.ok || !search.data?.length) {
      report.errors.push({ step: 'search', message: `User not found: ${customerEmail}` });
      return report;
    }
    const user = search.data[0];

    // 2. Start emulation
    const em = await apiCall(cookie, 'POST', `/admin-users/${user.id}/emulate`);
    if (!em.ok) {
      report.errors.push({ step: 'emulate', message: `Emulation failed: ${em.status}` });
      return report;
    }

    try {
      // 3. Get auth/me (account status)
      const me = await apiCall(cookie, 'GET', '/auth/me');
      if (me.ok) {
        const d = me.data;
        report.account = {
          email: d.email,
          name: `${d.firstName || ''} ${d.lastName || ''}`.trim(),
          status: d.status,
          role: d.role,
          created_at: d.createdAt,
          is_admin_paused: user.adminPaused,
          pause_reasons: user.pauseReasons || [],
        };
      }

      // 4. Credits
      const credits = await apiCall(cookie, 'GET', '/credits');
      if (credits.ok) {
        const c = credits.data;
        report.credits = {
          remaining: parseFloat(c.remainingCredits),
          recharge_active: c.rechargeActive,
          recharge_minimum: parseFloat(c.rechargeMinimum),
          total_purchased: parseFloat(c.totalCreditsPurchased),
          total_spend_usd: parseFloat(c.totalCreditPurchaseSpend),
          verification_credits: parseFloat(c.verificationCredits),
          last_updated: c.updatedAt,
        };
      }

      // 5. Campaigns
      const campaigns = await apiCall(cookie, 'GET', '/campaigns');
      if (campaigns.ok) {
        const list = Array.isArray(campaigns.data) ? campaigns.data : campaigns.data?.campaigns || [];
        report.campaigns = list.map(c => ({
          id: c.id,
          name: c.name,
          status: c.status,
          type: c.type,
          contact_count: c.contactCount || c.totalContacts || 0,
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        }));
      }

      // 6. Workflows
      const workflows = await apiCall(cookie, 'GET', '/workflows');
      if (workflows.ok) {
        const list = Array.isArray(workflows.data) ? workflows.data : workflows.data?.workflows || [];
        report.workflows = list.map(w => ({
          id: w.id,
          name: w.name,
          is_active: w.isActive,
          is_paused: w.isPaused,
          trigger_tag: w.triggerTag,
          enrolled_count: w.enrolledCount || 0,
        }));
      }

      // 7. Phone numbers
      const phones = await apiCall(cookie, 'GET', '/phone-numbers');
      if (phones.ok) {
        const list = Array.isArray(phones.data) ? phones.data : phones.data?.phoneNumbers || [];
        report.phone_numbers = list.map(p => ({
          number: p.phoneNumber,
          is_compliant: p.isCompliant,
          is_enabled: p.isEnabled,
          status: p.status,
        }));
      }

      // 8. Summarize system status
      const stuckCampaigns = report.campaigns.filter(c => c.status === 'processing' || c.status === 'stuck');
      const pausedWorkflows = report.workflows.filter(w => w.is_paused);
      const nonCompliantNumbers = report.phone_numbers.filter(p => !p.is_compliant);

      report.system_status = {
        account_active: report.account?.status === 'active',
        admin_paused: report.account?.is_admin_paused || false,
        low_credits: report.credits ? report.credits.remaining < 5000 : null,
        stuck_campaigns: stuckCampaigns.length,
        paused_workflows: pausedWorkflows.length,
        non_compliant_numbers: nonCompliantNumbers.length,
        has_recharge: report.credits?.recharge_active || false,
      };

    } finally {
      // Always stop emulation
      await apiCall(cookie, 'POST', '/admin-users/emulation/stop');
    }

  } catch (err) {
    report.errors.push({ step: 'diagnostic', message: err.message });
    // Try to stop emulation even on error
    try { await apiCall(cookie, 'POST', '/admin-users/emulation/stop'); } catch {}
  }

  return report;
}

// ─── Routes ───

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pitchprfct-support-diagnostics', timestamp: new Date().toISOString() });
});

// Main diagnostic endpoint
// Called by Intercom Data Connector: GET /diagnose?email=customer@example.com
app.get('/diagnose', async (req, res) => {
  // Optional API secret protection
  if (API_SECRET) {
    const providedSecret = req.headers['x-api-secret'] || req.query.secret;
    if (providedSecret !== API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'PP_ADMIN_PASSWORD not configured' });

  try {
    console.log(`[${new Date().toISOString()}] Diagnosing: ${email}`);
    const report = await diagnoseUser(email);
    console.log(`[${new Date().toISOString()}] Done: ${email} | status=${report.system_status?.account_active} | credits=${report.credits?.remaining}`);
    res.json(report);
  } catch (err) {
    console.error(`Error diagnosing ${email}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST version for Intercom Data Connector (some connectors use POST)
app.post('/diagnose', async (req, res) => {
  if (API_SECRET) {
    const providedSecret = req.headers['x-api-secret'] || req.body?.secret;
    if (providedSecret !== API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const email = req.body?.email || req.query.email;
  if (!email) return res.status(400).json({ error: 'email required in body or query' });

  try {
    const report = await diagnoseUser(email);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PitchPrfct Support Diagnostics API running on port ${PORT}`);
  console.log(`Admin: ${ADMIN_EMAIL}`);
  console.log(`Auth: ${API_SECRET ? 'protected' : 'open (set API_SECRET to protect)'}`);
});
