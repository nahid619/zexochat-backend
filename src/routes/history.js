const express = require('express');
const router = express.Router();
const db = require('../services/db');

// Create new conversation — identified users only. Anonymous chats are
// never persisted (access plan §1), so there's nothing to create for an
// unidentified caller; the frontend keeps anonymous conversations entirely
// in its own state instead of ever calling this route.
router.post('/new', async (req, res) => {
  if (!req.user) {
    return res.status(403).json({ error: 'Log in with an access code to save conversation history. Anonymous chats are not saved.' });
  }
  try {
    const title = req.body.title || 'New Chat';
    const model = req.body.model || 'gemini-3-flash-preview';
    const conv = await db.createConversation(title, model, req.user.id);
    res.status(201).json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all conversations — scoped to the caller. Anonymous callers have no
// persisted history by definition, so they get an empty list rather than
// an error, which keeps the frontend's "load history on boot" call simple
// regardless of login state.
router.get('/', async (req, res) => {
  try {
    if (!req.user) return res.json([]);
    const convs = await db.getConversations(req.user.id);
    res.json(convs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages in a conversation — only the owning user may read it.
router.get('/:id', async (req, res) => {
  try {
    const conv = await db.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!req.user || String(conv.userId) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You do not have access to this conversation.' });
    }
    const messages = await db.getMessages(req.params.id);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete conversation — only the owning user may delete it.
router.delete('/:id', async (req, res) => {
  try {
    const conv = await db.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!req.user || String(conv.userId) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You do not have access to this conversation.' });
    }
    await db.deleteConversation(req.params.id);
    res.json({ success: true, message: 'Conversation deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;