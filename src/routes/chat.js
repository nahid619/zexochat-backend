const express = require('express');
const router = express.Router();
const { routeChat } = require('../services/aiRouter');
const db = require('../services/db');

// Anonymous (unidentified) callers are locked to exactly this model — see
// access plan §1. Enforced here, not just hidden in the frontend dropdown,
// because a client-side-only restriction can be bypassed by anyone calling
// this endpoint directly with curl/Postman.
const ANONYMOUS_MODEL = 'openai/gpt-oss-120b';

router.post('/', async (req, res) => {
  const { userMessage, searchEnabled } = req.body;
  const preferredModel = req.user ? req.body.preferredModel : ANONYMOUS_MODEL;

  if (!userMessage) {
    return res.status(400).json({ error: 'userMessage is required' });
  }

  try {
    let chatMessages;
    const conversationId = req.body.conversationId;

    if (req.user) {
      // Identified user — full DB-backed persistence, scoped to their
      // account. conversationId must already exist and must belong to them
      // (you can't read or post into someone else's conversation just by
      // guessing/passing their Mongo _id).
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
      chatMessages = history.map(m => ({ role: m.role, content: m.content }));
    } else {
      // Anonymous — nothing touches the database at all (access plan §1:
      // "chats are not persisted"). There's no server-side memory of this
      // conversation, so the client sends the running history itself with
      // every request; we just append the latest user turn to it.
      const clientHistory = Array.isArray(req.body.messages) ? req.body.messages : [];
      chatMessages = [...clientHistory, { role: 'user', content: userMessage }];
    }

    // If chat history is very long, trim it (keeping the latest context)
    if (chatMessages.length > 30) {
      chatMessages = chatMessages.slice(-30);
    }

    // (Phase 7: Web Search integration wrapper)
    // If search is enabled, we'll run a search check. For now, if search is enabled,
    // we'll inject a note into the prompt. The real Tavily service will be connected in Phase 7.
    if (searchEnabled) {
      try {
        const { searchWeb } = require('../services/tavily');
        console.log(`🔍 [Chat Route] Web search requested for: "${userMessage}"`);
        const searchResults = await searchWeb(userMessage);

        if (searchResults && searchResults.trim().length > 0) {
          const lastIndex = chatMessages.length - 1;
          chatMessages[lastIndex].content = `Use these web search results to help answer the user's question:\n\n${searchResults}\n\nNow answer the user's question: ${userMessage}`;
        }
      } catch (err) {
        console.error('⚠️ Tavily search service skipped or error:', err.message);
        const lastIndex = chatMessages.length - 1;
        chatMessages[lastIndex].content = `[Web Search Active - Mock Results Injected]\nQuery: ${userMessage}`;
      }
    }

    // Query AI Router (auto-switches on 429 rate limits)
    const { content, modelUsed } = await routeChat(chatMessages, preferredModel);

    if (req.user) {
      const assistantMsg = await db.createMessage(conversationId, 'assistant', content, modelUsed);
      await db.updateConversation(conversationId, { model: modelUsed });
      return res.json({ reply: content, modelUsed, message: assistantMsg });
    }

    // Anonymous: nothing was saved, so there's no message doc to return —
    // just the reply itself. The frontend appends it to its own in-memory
    // history (and the `messages` array it sends next turn).
    return res.json({ reply: content, modelUsed });

  } catch (err) {
    console.error('❌ Chat route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;