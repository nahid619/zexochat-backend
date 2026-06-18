// PATH: backend/src/services/rateLimiter.js

// In-memory brute-force guard for login endpoints.
// Kept in its own file with zero imports so it can be required by both
// routes/auth.js and routes/admin.js without creating a circular dependency
// through middleware/auth.js.

const failedAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function isLockedOut(ip) {
  const entry = failedAttempts.get(ip);
  return !!(entry && entry.lockedUntil && Date.now() < entry.lockedUntil);
}

function recordFailedAttempt(ip) {
  const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(ip, entry);
}

function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

module.exports = { isLockedOut, recordFailedAttempt, clearFailedAttempts };