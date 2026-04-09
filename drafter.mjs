/**
 * AI Draft Agent — Claude Sonnet 4.6 tool-use loop.
 *
 * Takes a conversation history + customer email, runs diagnostic tools,
 * searches knowledge base, and produces a draft reply for Rudy to review.
 */

import Anthropic from '@anthropic-ai/sdk';
import { searchKnowledge, searchFeedback } from './knowledge.mjs';
import { searchArticles } from './intercom.mjs';
import { SYSTEM_PROMPT, TOOLS } from './prompts.mjs';

let anthropic = null;
function getAnthropic() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 8; // Safety limit on tool-use loops

// ─── Tool execution ───

/**
 * Execute a tool call from the agent.
 * diagnose_account and investigate_account call back into our own API
 * endpoints to reuse existing logic.
 */
async function executeTool(name, input, { apiSecret, baseUrl }) {
  console.log(`  [TOOL] ${name}(${JSON.stringify(input).slice(0, 200)})`);

  try {
    switch (name) {
      case 'search_knowledge': {
        const results = await searchKnowledge(input.query, {
          domain: input.domain || null,
          limit: 8,
        });
        return JSON.stringify(results.map(r => ({
          domain: r.domain,
          section: r.section,
          chunk_type: r.chunk_type,
          similarity: parseFloat(r.similarity).toFixed(3),
          symptoms: r.customer_symptoms,
          error_codes: r.error_codes,
          content: r.content?.slice(0, 1500),
        })));
      }

      case 'search_help_articles': {
        const articles = await searchArticles(input.query);
        return JSON.stringify(articles);
      }

      case 'search_feedback': {
        const feedback = await searchFeedback(input.query, { limit: 3 });
        if (feedback.length === 0) return JSON.stringify({ message: 'No prior feedback found for similar situations.' });
        return JSON.stringify(feedback.map(f => ({
          similarity: parseFloat(f.similarity).toFixed(3),
          category: f.classified_as,
          rep_feedback: f.rep_feedback,
          diff_summary: f.diff_summary,
          final_sent: f.final_sent?.slice(0, 500),
        })));
      }

      case 'diagnose_account': {
        const url = `${baseUrl}/diagnose?email=${encodeURIComponent(input.email)}&secret=${apiSecret}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) return JSON.stringify({ error: `Diagnose failed: HTTP ${resp.status}` });
        const data = await resp.json();
        // Strip any huge fields to keep context manageable
        if (data.campaigns?.length > 20) {
          data._note = `Showing 20 most recent of ${data.campaigns.length} campaigns`;
          data.campaigns = data.campaigns.slice(-20);
        }
        return JSON.stringify(data);
      }

      case 'investigate_account': {
        const params = new URLSearchParams({ email: input.email, secret: apiSecret });
        if (input.pages?.length) params.set('pages', input.pages.join(','));
        if (input.campaign_id) params.set('campaign_id', input.campaign_id);
        if (input.workflow_id) params.set('workflow_id', input.workflow_id);

        const url = `${baseUrl}/investigate?${params}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!resp.ok) return JSON.stringify({ error: `Investigate failed: HTTP ${resp.status}` });
        const data = await resp.json();

        // Strip base64 screenshots from the response (too large for context)
        // but note their existence
        function stripScreenshots(obj) {
          if (typeof obj !== 'object' || obj === null) return obj;
          if (Array.isArray(obj)) return obj.map(stripScreenshots);
          const cleaned = {};
          for (const [k, v] of Object.entries(obj)) {
            if (k === 'screenshot') {
              cleaned[k] = '[base64 PNG screenshot available]';
            } else {
              cleaned[k] = stripScreenshots(v);
            }
          }
          return cleaned;
        }

        return JSON.stringify(stripScreenshots(data));
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    console.error(`  [TOOL ERROR] ${name}: ${err.message}`);
    return JSON.stringify({ error: err.message });
  }
}

// ─── Main draft function ───

/**
 * Generate a draft reply for a support conversation.
 *
 * @param {object} opts
 * @param {string} opts.customerEmail - Customer's email
 * @param {Array} opts.conversationHistory - Array of { role, author, body, type } from Intercom
 * @param {string} opts.feedbackContext - Optional: rep feedback for regeneration
 * @param {string} opts.previousDraft - Optional: the previous draft being refined
 * @returns {{ draft, reasoning, sources, confidence, needsEscalation, escalationReason }}
 */
export async function generateDraft({
  customerEmail,
  conversationHistory,
  feedbackContext = null,
  previousDraft = null,
}) {
  const apiSecret = process.env.API_SECRET;
  // Use localhost when running locally, Railway URL in production
  const baseUrl = process.env.SELF_URL || `http://localhost:${process.env.PORT || 3000}`;

  // Build the message array for Claude
  const messages = [];

  // Format conversation history as context
  let conversationContext = 'CONVERSATION HISTORY:\n\n';
  for (const msg of conversationHistory) {
    const prefix = msg.type === 'note' ? `[INTERNAL NOTE - ${msg.author}]` : `[${msg.role.toUpperCase()} - ${msg.author}]`;
    conversationContext += `${prefix}\n${msg.body}\n\n`;
  }

  let userPrompt = conversationContext;
  userPrompt += `\nCUSTOMER EMAIL: ${customerEmail}\n`;
  userPrompt += '\nPlease diagnose this customer\'s issue and draft a reply. Use your tools to gather the information you need. Return your response as the JSON object described in your instructions.';

  // If this is a regeneration with feedback
  if (feedbackContext && previousDraft) {
    userPrompt += `\n\n---\nREP FEEDBACK ON PREVIOUS DRAFT:\nThe support rep reviewed your previous draft and wants changes:\n\nPrevious draft:\n${previousDraft}\n\nRep's feedback:\n${feedbackContext}\n\nPlease regenerate the draft incorporating this feedback. You may call tools again if the feedback requires additional information.`;
  }

  messages.push({ role: 'user', content: userPrompt });

  // Run the Claude tool-use loop
  console.log(`[DRAFTER] Starting draft for ${customerEmail} (${conversationHistory.length} messages)`);

  let response = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    messages,
  });

  let rounds = 0;

  while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    const toolResults = [];

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await executeTool(block.name, block.input, { apiSecret, baseUrl });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      messages,
    });
  }

  console.log(`[DRAFTER] Completed after ${rounds} tool rounds, stop_reason: ${response.stop_reason}`);

  // Extract the text response
  const textParts = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text);
  const rawText = textParts.join('\n');

  // Try to parse structured JSON output
  try {
    // The model should return JSON, but it might be wrapped in markdown code fences
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        draft: parsed.draft || rawText,
        reasoning: parsed.reasoning || '',
        sources: parsed.sources || [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        needsEscalation: parsed.needs_escalation || false,
        escalationReason: parsed.escalation_reason || null,
        toolRounds: rounds,
      };
    }
  } catch {
    // JSON parsing failed — use raw text as draft
  }

  // Fallback: treat the entire response as the draft
  return {
    draft: rawText,
    reasoning: 'Agent returned unstructured response',
    sources: [],
    confidence: 0.3,
    needsEscalation: false,
    escalationReason: null,
    toolRounds: rounds,
  };
}

/**
 * Classify a conversation into a category.
 * Used for routing and analytics.
 */
export async function classifyConversation(conversationHistory, customerEmail) {
  const lastMessage = conversationHistory
    .filter(m => m.role === 'customer')
    .pop();

  if (!lastMessage) return { category: 'unknown', confidence: 0 };

  const response = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: 256,
    system: 'Classify this customer support message into exactly one category. Return JSON: { "category": "...", "confidence": 0.0-1.0, "reasoning": "..." }',
    messages: [{
      role: 'user',
      content: `Customer email: ${customerEmail}\n\nMessage: ${lastMessage.body}\n\nCategories:\n- basic (general product question, how-to, feature inquiry)\n- technical (error, bug report, something not working as expected)\n- account (credits, billing, campaign/workflow issue, account paused, messages not sending)\n- feedback (feature request, complaint, general feedback)\n\nReturn JSON only.`,
    }],
  });

  try {
    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}

  return { category: 'account', confidence: 0.5 };
}
