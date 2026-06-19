// PATH: backend/src/routes/admin.js

const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { generateAccessCode, generateSessionToken, hashCode } = require('../services/authUtils');
const { requireAdmin } = require('../middleware/auth');
const { isLockedOut, recordFailedAttempt, clearFailedAttempts } = require('../services/rateLimiter');

// POST /api/admin/login — password-based login for the admin panel.
// Completely separate from the regular /api/auth/login (access-code) flow.
// Credentials are checked against ADMIN_USERNAME + ADMIN_PASSWORD env vars,
// not stored in the database, so there's nothing to hash/compare from DB —
// just a plain constant-time string compare against the env vars.
router.post('/login', async (req, res) => {
  const ip = req.ip;

  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Please try again in a few minutes.' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedPassword) {
    return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD in your environment variables.' });
  }

  // Constant-time comparison to avoid timing attacks on the password
  const crypto = require('crypto');
  const usernameMatch = crypto.timingSafeEqual(
    Buffer.from(username),
    Buffer.from(expectedUsername)
  );
  const passwordMatch = crypto.timingSafeEqual(
    Buffer.from(password),
    Buffer.from(expectedPassword)
  );

  if (!usernameMatch || !passwordMatch) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearFailedAttempts(ip);

  try {
    // Find the admin User record so we can issue a normal session — same
    // shape as a regular login, nothing downstream needs to know which
    // path was used.
    const adminUser = await db.getAdminUser();
    if (!adminUser) {
      return res.status(500).json({ error: 'Admin account not found. Please restart the server.' });
    }

    const token = generateSessionToken();
    await db.createSession(adminUser._id, token);

    res.json({
      token,
      user: {
        id: adminUser._id,
        name: adminUser.name,
        username: adminUser.username,
        role: adminUser.role
      }
    });
  } catch (err) {
    console.error('[admin] Login failed:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Every route below requires an authenticated admin. resolveUser (mounted
// globally in server.js) has already attached req.user by the time this runs.
router.use(requireAdmin);

// Never send accessCodeHash to the client, under any circumstances.
function toSafeUser(user) {
  return {
    id:           user._id,
    name:         user.name,
    username:     user.username,
    role:         user.role,
    isActive:     user.isActive !== false, // treat undefined as true for old records
    messageCount: user.messageCount || 0,
    createdAt:    user.createdAt
  };
}

// GET /api/admin/users — list everyone
router.get('/users', async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json(users.map(toSafeUser));
  } catch (err) {
    console.error('[admin] List users failed:', err);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

// POST /api/admin/users — create a user. Returns the plaintext access code
// exactly once — the admin must copy it now, it can't be retrieved later
// (only its hash is kept).
router.post('/users', async (req, res) => {
  try {
    const { name, role } = req.body;
    let { username } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'Username is required.' });
    }
    username = username.trim().toLowerCase();

    const existing = await db.findUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const safeRole = role === 'admin' ? 'admin' : 'user';
    const plainCode = generateAccessCode();
    const accessCodeHash = await hashCode(plainCode);

    const user = await db.createUser({ name: name.trim(), username, accessCodeHash, role: safeRole });

    res.status(201).json({
      user: toSafeUser(user),
      accessCode: plainCode
    });
  } catch (err) {
    console.error('[admin] Create user failed:', err);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

// PATCH /api/admin/users/:id/regenerate — issues a new code and immediately
// invalidates any session created under the old one.
router.patch('/users/:id/regenerate', async (req, res) => {
  try {
    const user = await db.getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const plainCode = generateAccessCode();
    const accessCodeHash = await hashCode(plainCode);
    await db.updateUserAccessCode(req.params.id, accessCodeHash);
    await db.deleteSessionsForUser(req.params.id);

    res.json({
      user: toSafeUser(user),
      accessCode: plainCode
    });
  } catch (err) {
    console.error('[admin] Regenerate code failed:', err);
    res.status(500).json({ error: 'Failed to regenerate access code.' });
  }
});

// DELETE /api/admin/users/:id — cascade-deletes their sessions + conversations.
// Blocks deleting your own account to avoid an accidental self-lockout —
// note this alone is sufficient to guarantee at least one admin always
// remains, since the only way to remove every admin would require an admin
// to delete themselves at some point.
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const target = await db.getUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (String(req.user._id) === String(id)) {
      return res.status(400).json({ error: "You can't delete your own account while logged in as it." });
    }

    await db.cascadeDeleteUser(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin] Delete user failed:', err);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// PATCH /api/admin/users/:id — update name and/or isActive status.
// Only these two fields are editable — role/username/accessCodeHash are
// not exposed here to avoid accidental privilege escalation.
router.patch('/users/:id', async (req, res) => {
  try {
    const { name, isActive } = req.body;
    const fields = {};
    if (name     !== undefined) fields.name     = name.trim();
    if (isActive !== undefined) fields.isActive = Boolean(isActive);

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    if (fields.name !== undefined && !fields.name) {
      return res.status(400).json({ error: 'Name cannot be empty.' });
    }

    const updated = await db.updateUser(req.params.id, fields);
    if (!updated) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true, user: toSafeUser(updated) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

// GET /api/admin/users/:id/conversations — all conversations belonging to a user
router.get('/users/:id/conversations', async (req, res) => {
  try {
    const convs = await db.getConversations(req.params.id);
    res.json(convs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load conversations.' });
  }
});

// GET /api/admin/conversations/:id/messages — all messages in a conversation
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const msgs = await db.getMessages(req.params.id);
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

// DELETE /api/admin/conversations/:id — admin can delete any conversation
router.delete('/conversations/:id', async (req, res) => {
  try {
    await db.deleteConversation(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete conversation.' });
  }
});

module.exports = router;