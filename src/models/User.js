// PATH: backend/src/models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  // Never store the plaintext access code — only its bcrypt hash.
  accessCodeHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  // isActive: false lets the admin instantly suspend a user's chat access
  // without deleting their account or conversations. Defaults to true.
  isActive: { type: Boolean, default: true },
  // Total number of messages the user has sent — shown in the admin panel
  // so the admin can see per-user usage at a glance.
  messageCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);