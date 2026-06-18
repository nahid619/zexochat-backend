// PATH: backend/src/middleware/auth.js

const db = require('../services/db');
const { isLockedOut, recordFailedAttempt, clearFailedAttempts } = require('../services/rateLimiter');

// Attaches req.user (the User doc) if a valid session token is present, or
// req.user = null for anonymous callers. Never blocks the request — routes
// that require a logged-in user check req.user themselves.
async function resolveUser(req, res, next) {
  req.user = null;
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return next();

    const session = await db.getSessionByToken(token);
    if (!session) return next();

    const user = await db.getUserById(session.userId);
    if (user) req.user = user;
  } catch (err) {
    console.warn('[auth] resolveUser failed:', err.message);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

module.exports = {
  resolveUser,
  requireAdmin,
  isLockedOut,
  recordFailedAttempt,
  clearFailedAttempts
};