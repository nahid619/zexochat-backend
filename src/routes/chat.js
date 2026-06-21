// PATH: backend/src/routes/chat.js
const express       = require('express');
const router        = express.Router();
const { routeChat } = require('../services/aiRouter');
const db            = require('../services/db');

const ANONYMOUS_MODEL = 'openai/gpt-oss-120b';

// ─── System prompt ─────────────────────────────────────────────────────────────
// Builds the context injected as `role: "system"` before every conversation.
// Each provider's caller is responsible for mapping this to its own API shape
// (Gemini → systemInstruction, Cohere → preamble, others → native system role).
function buildSystemPrompt({ localDateTime, timezone, searchEnabled }) {
  const utcNow = new Date().toUTCString();

  const timeBlock = (localDateTime && timezone)
    ? `## Current date & time
User's local time : ${localDateTime}
User's timezone   : ${timezone}
Server UTC time   : ${utcNow}

Always use the user's local time above when answering any question about the current time, date, day of the week, or how long until/since an event. Never guess or use your training-data cutoff as the current date.`
    : `## Current date & time
Server UTC time: ${utcNow}
(No client timezone was provided — use UTC as a fallback if the user asks about the time.)`;

  const searchBlock = searchEnabled
    ? `\n\n## Web search
When this conversation's last user message contains search results labelled "Source [N]:", you MUST use those results to answer. Quote or cite the sources when relevant. If the results don't cover the question fully, say so rather than guessing.`
    : '';

  return `You are ZexoChat, a helpful and concise AI assistant.

${timeBlock}${searchBlock}`;
}

// ─── Main chat endpoint ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    userMessage,
    searchEnabled,
    localDateTime,   // e.g. "Saturday, June 21, 2026 at 11:47 PM"  (from browser)
    timezone,        // e.g. "Asia/Dhaka"                             (from browser)
  } = req.body;

  const preferredModel = req.user ? req.body.preferredModel : ANONYMOUS_MODEL;

  if (req.user && req.user.isActive === false) {
    return res.status(403).json({
      error:     'Your access has been temporarily suspended. Please contact the admin.',
      suspended: true,
    });
  }

  if (!userMessage) {
    return res.status(400).json({ error: 'userMessage is required' });
  }

  try {
    let chatMessages;
    const conversationId = req.body.conversationId;

    // ── Build conversation history ──────────────────────────────────────────
    if (req.user) {
      if (!conversationId) {
        return res.status(400).json({ error: 'conversationId is required' });
      }
      const conv = await db.getConversation(conversationId);
      if (!conv) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if (String(conv.userId) !== String(req.user.id)) {
        return res.status(403).json({ error: 'You do not have access to this conversation.' });
      }

      await db.createMessage(conversationId, 'user', userMessage);
      const history = await db.getMessages(conversationId);
      chatMessages  = history.map(m => ({ role: m.role, content: m.content }));
    } else {
      const clientHistory = Array.isArray(req.body.messages) ? req.body.messages : [];
      chatMessages = [...clientHistory, { role: 'user', content: userMessage }];
    }

    // Trim very long histories (keep most-recent context)
    if (chatMessages.length > 30) chatMessages = chatMessages.slice(-30);

    // ── Prepend system prompt ───────────────────────────────────────────────
    // Inserted at position 0 so it frames every call to every provider.
    const systemPrompt = buildSystemPrompt({ localDateTime, timezone, searchEnabled });
    chatMessages.unshift({ role: 'system', content: systemPrompt });

    // ── Web search injection ────────────────────────────────────────────────
    // Only runs when search is enabled AND a real Tavily key is configured.
    // If the key is missing we skip silently — injecting mock results would
    // cause the model to confidently hallucinate fake citations.
    if (searchEnabled) {
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (!tavilyKey || tavilyKey.trim().length === 0) {
        console.warn('[chat] TAVILY_API_KEY not set — web search skipped for this request.');
      } else {
        try {
          const { searchWeb }  = require('../services/tavily');
          console.log(`🔍 [chat] Searching: "${userMessage}"`);
          const searchResults = await searchWeb(userMessage);

          if (searchResults && searchResults.trim().length > 0) {
            // Inject results into the last user turn so they appear as part
            // of the conversation, not as instructions the model might ignore.
            const lastIdx = chatMessages.length - 1;
            chatMessages[lastIdx].content =
              `Here are current web search results for my question:\n\n${searchResults}\n\n` +
              `My question: ${userMessage}`;
          }
        } catch (err) {
          // Non-fatal — answer from model knowledge if search fails
          console.error('⚠️ [chat] Web search failed:', err.message);
        }
      }
    }

    // ── Call AI router ──────────────────────────────────────────────────────
    const { content, modelUsed } = await routeChat(chatMessages, preferredModel);

    if (req.user) {
      const assistantMsg = await db.createMessage(conversationId, 'assistant', content, modelUsed);
      await db.updateConversation(conversationId, { model: modelUsed });
      db.incrementMessageCount(req.user._id || req.user.id).catch(() => {});
      return res.json({ reply: content, modelUsed, message: assistantMsg });
    }

    return res.json({ reply: content, modelUsed });

  } catch (err) {
    console.error('❌ [chat] Route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;