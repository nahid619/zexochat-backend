const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  // Never store the plaintext access code — same handling as a password,
  // even though it's machine-generated rather than user-chosen. The
  // plaintext is shown to the admin exactly once at creation/regeneration
  // time and then discarded server-side.
  accessCodeHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);