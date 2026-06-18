const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  title: { type: String, default: 'New Chat' },
  model: { type: String, default: 'gemini-3-flash-preview' },
  // Anonymous chats are never written to the database at all (access plan
  // §1) — only an identified user can have a persisted Conversation, so
  // this is required rather than nullable.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  // Rolling 30-day expiry: set on creation, then bumped forward every time
  // a new message is added (see services/db.js createMessage) — so only
  // genuinely abandoned conversations get cleaned up, not ones still in
  // active use. (Decision from access plan §5 item 1: reset-on-activity,
  // not a hard expiry from creation.)
  expiresAt: { type: Date, required: true },
});

// TTL index — MongoDB's background process deletes a document once the
// clock passes the Date stored in `expiresAt`. expireAfterSeconds: 0 means
// "expire exactly at the timestamp written in the field," not "0 seconds
// after creation" — no cron job or scheduled task needed.
conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Conversation', conversationSchema);