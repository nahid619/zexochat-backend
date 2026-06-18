const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// High-entropy, URL-safe access code — this is the only "password" a real
// user ever has, so it needs to resist brute-forcing on its own (the login
// endpoint also rate-limits attempts — see middleware/auth.js).
function generateAccessCode() {
  return crypto.randomBytes(24).toString('base64url'); // 32-char string
}

// Opaque session token, same generation approach as the access code.
function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function hashCode(plaintextCode) {
  return await bcrypt.hash(plaintextCode, 10);
}

async function verifyCode(plaintextCode, hash) {
  return await bcrypt.compare(plaintextCode, hash);
}

module.exports = { generateAccessCode, generateSessionToken, hashCode, verifyCode };