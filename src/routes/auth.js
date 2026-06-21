// PATH: backend/src/routes/auth.js

const express = require('express');
const router  = express.Router();
const db      = require('../services/db');
const { generateSessionToken, verifyCode } = require('../services/authUtils');
const { isLockedOut, recordFailedAttempt, clearFailedAttempts } = require('../services/rateLimiter');

// Helper — strips the hash and returns only what the frontend needs.
// appearance is included so the client can restore the user's saved
// theme / accent / background on every page load.
function toPublicUser(user) {
  return {
    id:         user._id,
    name:       user.name,
    username:   user.username,
    role:       user.role,
    appearance: user.appearance || {}
  };
}

// POST /api/auth/login — exchanges an access code for a session token.
router.post('/login', async (req, res) => {
  const ip = req.ip;
  const { code } = req.body;

  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Please try again in a few minutes.' });
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Access code is required.' });
  }

  try {
    const allUsers = await db.getAllUsersForLogin();
    let matchedUser = null;
    for (const user of allUsers) {
      if (await verifyCode(code, user.accessCodeHash)) {
        matchedUser = user;
        break;
      }
    }

    if (!matchedUser) {
      recordFailedAttempt(ip);
      return res.status(401).json({ error: 'Invalid access code.' });
    }

    clearFailedAttempts(ip);
    const token = generateSessionToken();
    await db.createSession(matchedUser._id, token);

    res.json({ token, user: toPublicUser(matchedUser) });
  } catch (err) {
    console.error('[auth] Login failed:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/logout — invalidates the current session token.
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) await db.deleteSession(token);
  } catch (err) {
    console.error('[auth] Logout cleanup failed:', err.message);
  }
  res.json({ success: true });
});

// GET /api/auth/me — validates a stored token and returns the current user.
// appearance is included so the frontend can re-apply preferences without
// a separate request.
router.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  res.json({ user: toPublicUser(req.user) });
});

// PATCH /api/auth/appearance — persists the user's appearance preferences.
// Called automatically (debounced) whenever the user changes their theme,
// accent colour, or background palette. Silent on failure — a missed save
// is not worth interrupting the chat experience for.
router.patch('/appearance', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not logged in.' });
  }

  const { appearance } = req.body;

  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) {
    return res.status(400).json({ error: 'appearance must be a plain object.' });
  }

  try {
    await db.updateUser(req.user._id, { appearance });
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] Failed to save appearance:', err.message);
    res.status(500).json({ error: 'Failed to save appearance.' });
  }
});

module.exports = router;