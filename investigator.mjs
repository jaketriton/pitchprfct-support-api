/**
 * PitchPrfct Account Investigator
 * 
 * Full browser-based investigation of a customer's account.
 * Logs in, emulates, navigates to specific pages, extracts data,
 * and takes screenshots of exactly what the customer sees.
 */

import { chromium } from 'playwright';

const APP_URL = 'https://app.pitchprfct.com';
const ADMIN_EMAIL = process.env.PP_ADMIN_EMAIL || 'info@pitchprfct.com';
const ADMIN_PASSWORD = process.env.PP_ADMIN_PASSWORD;

// Reusable browser instance (stays warm between requests)
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    const launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    };
    // Use system Chromium in Docker
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    browserInstance = await chromium.launch(launchOptions);
  }
  return browserInstance;
}

/**
 * Create an authenticated, emulated session for a customer
 */
async function createEmulatedSession(customerEmail) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Login via API
  const loginResp = await page.request.post(`${APP_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
  });
  if (loginResp.status() !== 200) throw new Error('Admin login failed');

  // Search user
  const searchResp = await page.request.get(`${APP_URL}/api/admin-users/search?email=${encodeURIComponent(customerEmail)}`);
  const users = await searchResp.json();
  if (!users?.length) throw new Error(`User not found: ${customerEmail}`);

  // Start emulation
  const emResp = await page.request.post(`${APP_URL}/api/admin-users/${users[0].id}/emulate`);
  if (emResp.status() !== 200) throw new Error('Emulation failed');

  return { page, context, userId: users[0].id };
}

/**
 * Clean up an emulated session
 */
async function closeSession(page, context) {
  try { await page.request.post(`${APP_URL}/api/admin-users/emulation/stop`); } catch {}
  await context.close();
}

/**
 * Navigate to a page and wait for it to load
 */
async function navigateTo(page, path, waitMs = 4000) {
  await page.goto(`${APP_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(waitMs);
}

/**
 * Take a screenshot and return it as base64
 */
async function screenshotBase64(page) {
  const buffer = await page.screenshot({ type: 'png' });
  return buffer.toString('base64');
}

/**
 * Extract visible text content from the main area
 */
async function extractPageContent(page) {
  return await page.evaluate(() => {
    const main = document.querySelector('main') || document.querySelector('[class*="content"]') || document.body;
    return main?.innerText?.substring(0, 3000) || '';
  });
}

// ──────────────────────────────────────────────
// INVESTIGATION MODULES
// ──────────────────────────────────────────────

/**
 * Full account overview - dashboard + top bar health indicators
 */
async function investigateDashboard(page) {
  await navigateTo(page, '/app/analytics');

  const topBarText = await page.evaluate(() => {
    const header = document.querySelector('header') || document.querySelector('nav');
    return header?.innerText || '';
  });

  const metrics = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="card"], [class*="stat"], [class*="metric"]');
    return Array.from(cards).map(c => c.innerText.trim()).filter(t => t.length > 3).slice(0, 10);
  });

  return {
    section: 'dashboard',
    screenshot: await screenshotBase64(page),
    top_bar: topBarText.substring(0, 300),
    metrics,
    content: await extractPageContent(page),
  };
}

/**
 * Campaign investigation - lists all campaigns, can drill into a specific one
 */
async function investigateCampaigns(page, campaignId = null) {
  await navigateTo(page, '/app/campaigns');

  // Get list of campaigns visible on the page
  const campaignList = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr, [class*="campaign-row"], [class*="campaign-card"]');
    return Array.from(rows).map(r => ({
      text: r.innerText.trim().substring(0, 200),
      hasError: r.innerHTML.toLowerCase().includes('error') || r.innerHTML.toLowerCase().includes('failed'),
      isStuck: r.innerHTML.toLowerCase().includes('processing') || r.innerHTML.toLowerCase().includes('stuck'),
    })).filter(r => r.text.length > 5).slice(0, 20);
  });

  const result = {
    section: 'campaigns',
    screenshot: await screenshotBase64(page),
    campaign_list: campaignList,
    total_visible: campaignList.length,
    stuck_count: campaignList.filter(c => c.isStuck).length,
    error_count: campaignList.filter(c => c.hasError).length,
  };

  // If a specific campaign ID is requested, try to click into it
  if (campaignId) {
    try {
      // Try clicking on the campaign row
      const campaignLink = page.locator(`a[href*="${campaignId}"], tr:has-text("${campaignId}")`).first();
      if (await campaignLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        await campaignLink.click();
        await page.waitForTimeout(3000);
        result.campaign_detail = {
          screenshot: await screenshotBase64(page),
          content: await extractPageContent(page),
        };
      }
    } catch (e) {
      result.campaign_detail_error = e.message;
    }
  }

  return result;
}

/**
 * Workflow investigation - lists all workflows, can drill into a specific one
 */
async function investigateWorkflows(page, workflowId = null) {
  await navigateTo(page, '/app/workflows');

  const workflowList = await page.evaluate(() => {
    const items = document.querySelectorAll('tr, [class*="workflow-row"], [class*="workflow-card"], [class*="WorkflowCard"]');
    return Array.from(items).map(r => ({
      text: r.innerText.trim().substring(0, 200),
      isPaused: r.innerHTML.toLowerCase().includes('paused'),
      hasError: r.innerHTML.toLowerCase().includes('error'),
    })).filter(r => r.text.length > 5).slice(0, 20);
  });

  const result = {
    section: 'workflows',
    screenshot: await screenshotBase64(page),
    workflow_list: workflowList,
    total_visible: workflowList.length,
    paused_count: workflowList.filter(w => w.isPaused).length,
  };

  // Drill into a specific workflow by clicking on its row
  if (workflowId) {
    try {
      // Find and click the workflow row that contains this ID or name
      const wfRow = page.locator(`tr:has-text("${workflowId}"), [data-workflow-id="${workflowId}"]`).first();
      if (await wfRow.isVisible({ timeout: 3000 }).catch(() => false)) {
        await wfRow.click();
        await page.waitForTimeout(3000);
        result.workflow_detail = {
          screenshot: await screenshotBase64(page),
          content: await extractPageContent(page),
        };
        // Extract workflow nodes from the builder view
        const nodes = await page.evaluate(() => {
          const nodeElements = document.querySelectorAll('[class*="node"], [class*="Node"], [data-type], [class*="step"]');
          return Array.from(nodeElements).map(n => ({
            text: n.innerText.trim().substring(0, 150),
            type: n.getAttribute('data-type') || n.className?.match(/node-(\w+)/)?.[1] || 'unknown',
          })).filter(n => n.text.length > 2).slice(0, 20);
        });
        result.workflow_detail.nodes = nodes;
      } else {
        result.workflow_detail_error = `Workflow row "${workflowId}" not found on page`;
      }
    } catch (e) {
      result.workflow_detail_error = e.message;
    }
  }

  return result;
}

/**
 * Conversations investigation - check inbox, recent messages
 */
async function investigateConversations(page) {
  await navigateTo(page, '/app/conversations');

  const conversations = await page.evaluate(() => {
    const items = document.querySelectorAll('[class*="conversation"], [class*="message-row"], li');
    return Array.from(items).map(r => r.innerText.trim().substring(0, 150))
      .filter(t => t.length > 5).slice(0, 15);
  });

  return {
    section: 'conversations',
    screenshot: await screenshotBase64(page),
    recent_conversations: conversations,
    content: await extractPageContent(page),
  };
}

/**
 * Phone numbers & 10DLC investigation
 */
async function investigatePhoneNumbers(page) {
  await navigateTo(page, '/app/phone-numbers');

  const phoneList = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr, [class*="phone"]');
    return Array.from(rows).map(r => ({
      text: r.innerText.trim().substring(0, 150),
      isCompliant: r.innerHTML.toLowerCase().includes('compliant') && !r.innerHTML.toLowerCase().includes('not compliant'),
      isNotCompliant: r.innerHTML.toLowerCase().includes('not compliant'),
    })).filter(r => r.text.length > 5).slice(0, 20);
  });

  return {
    section: 'phone_numbers',
    screenshot: await screenshotBase64(page),
    phone_list: phoneList,
    non_compliant: phoneList.filter(p => p.isNotCompliant).length,
  };
}

/**
 * 10DLC registration investigation
 */
async function investigate10DLC(page) {
  await navigateTo(page, '/app/phone-numbers/10dlc/brand');

  return {
    section: '10dlc',
    screenshot: await screenshotBase64(page),
    content: await extractPageContent(page),
  };
}

/**
 * Settings/billing investigation
 */
async function investigateSettings(page) {
  await navigateTo(page, '/app/settings');

  return {
    section: 'settings',
    screenshot: await screenshotBase64(page),
    content: await extractPageContent(page),
  };
}

/**
 * Contacts investigation
 */
async function investigateContacts(page) {
  await navigateTo(page, '/app/contacts');

  const contactInfo = await page.evaluate(() => {
    const text = document.body.innerText;
    const totalMatch = text.match(/(\d[\d,]*)\s*(?:total|contacts)/i);
    return { total: totalMatch?.[1] || 'unknown' };
  });

  return {
    section: 'contacts',
    screenshot: await screenshotBase64(page),
    contact_info: contactInfo,
    content: await extractPageContent(page),
  };
}

// ──────────────────────────────────────────────
// Main investigation function
// ──────────────────────────────────────────────

const MODULES = {
  dashboard: investigateDashboard,
  campaigns: investigateCampaigns,
  workflows: investigateWorkflows,
  conversations: investigateConversations,
  phone_numbers: investigatePhoneNumbers,
  '10dlc': investigate10DLC,
  settings: investigateSettings,
  contacts: investigateContacts,
};

/**
 * Run a full or targeted investigation of a customer's account.
 * 
 * @param {string} customerEmail - Customer email to investigate
 * @param {object} options
 * @param {string[]} options.pages - Which pages to investigate (default: all)
 * @param {string} options.campaignId - Specific campaign to drill into
 * @param {string} options.workflowId - Specific workflow to drill into
 * @returns {object} Investigation results with screenshots (base64) and extracted data
 */
export async function investigate(customerEmail, options = {}) {
  const { pages = Object.keys(MODULES), campaignId, workflowId } = options;
  const results = { customer_email: customerEmail, timestamp: new Date().toISOString(), pages: {}, errors: [] };

  let page, context;
  try {
    ({ page, context } = await createEmulatedSession(customerEmail));

    for (const pageName of pages) {
      const moduleFn = MODULES[pageName];
      if (!moduleFn) {
        results.errors.push({ page: pageName, error: 'Unknown page' });
        continue;
      }

      try {
        // Pass drill-down IDs for specific modules
        if (pageName === 'campaigns') {
          results.pages[pageName] = await moduleFn(page, campaignId);
        } else if (pageName === 'workflows') {
          results.pages[pageName] = await moduleFn(page, workflowId);
        } else {
          results.pages[pageName] = await moduleFn(page);
        }
      } catch (err) {
        results.errors.push({ page: pageName, error: err.message });
      }
    }
  } catch (err) {
    results.errors.push({ fatal: true, error: err.message });
  } finally {
    if (page && context) await closeSession(page, context);
  }

  return results;
}

export { MODULES };
