const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { generateSessionToken, verifyCode } = require('../services/authUtils');
const { isLockedOut, recordFailedAttempt, clearFailedAttempts } = require('../middleware/auth');

// POST /api/auth/login — exchanges an access code for a session token.
// Anonymous users never hit this; this is only for people who have a code.
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
    // Can't look up a user "by code" directly since only the hash is stored —
    // bcrypt-compare the submitted code against each user's hash in turn.
    // Fine at personal/small-team scale (see db.js getAllUsersForLogin).
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

    res.json({
      token,
      user: {
        id: matchedUser._id,
        name: matchedUser.name,
        username: matchedUser.username,
        role: matchedUser.role
      }
    });
  } catch (err) {
    console.error('[auth] Login failed:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/logout — invalidates the current session token, if any.
// Always returns success — logging out an already-invalid token is harmless.
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

// GET /api/auth/me — lets the frontend check whether a token it saved
// (e.g. in localStorage from a previous visit) is still valid, without
// resubmitting the access code. req.user is populated by the global
// resolveUser middleware; null means the token is missing, malformed, or
// was revoked (logout, regenerate, or the user being deleted).
router.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  res.json({
    user: {
      id: req.user._id,
      name: req.user.name,
      username: req.user.username,
      role: req.user.role
    }
  });
});

module.exports = router;