const mongoose = require('mongoose');

// DB-backed (not a signed JWT) so that regenerating a user's access code, or
// deleting a user, can instantly kill any active session tied to them —
// see authUtils.js / routes/admin.js.
const sessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Session', sessionSchema);