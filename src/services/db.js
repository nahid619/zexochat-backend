// PATH: backend/src/services/db.js
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const Session = require('../models/Session');

let isMockDB = false;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
// Rolling expiry — called on conversation creation AND on every new
// message, so the 30-day clock restarts each time the conversation is
// actually used (see Conversation.js for the corresponding TTL index).
function thirtyDaysFromNow() {
  return new Date(Date.now() + THIRTY_DAYS_MS);
}

// Mock database storage
const conversations = new Map();
const messages = [];
const users = new Map();
const sessions = new Map(); // keyed by token

function checkConnectionState() {
  // If mongoose is not connected, use mock
  return isMockDB || mongoose.connection.readyState !== 1;
}

function setMockDB(val) {
  isMockDB = val;
}

// Database helper functions
const db = {
  isMock: () => checkConnectionState(),

  setMock: (val) => setMockDB(val),

  // CONVERSATIONS
  createConversation: async (title = 'New Chat', model = 'gemini-3-flash-preview', userId) => {
    if (checkConnectionState()) {
      const id = 'mock_conv_' + Math.random().toString(36).substring(2, 15);
      const conv = {
        _id: id,
        id: id,
        title,
        model,
        userId,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: thirtyDaysFromNow()
      };
      conversations.set(id, conv);
      return conv;
    } else {
      return await Conversation.create({ title, model, userId, expiresAt: thirtyDaysFromNow() });
    }
  },

  getConversations: async (userId) => {
    if (checkConnectionState()) {
      return Array.from(conversations.values())
        .filter(c => String(c.userId) === String(userId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } else {
      return await Conversation.find({ userId }).sort({ updatedAt: -1 });
    }
  },

  getConversation: async (id) => {
    if (checkConnectionState()) {
      return conversations.get(id) || null;
    } else {
      return await Conversation.findById(id);
    }
  },

  updateConversation: async (id, updateData) => {
    if (checkConnectionState()) {
      const conv = conversations.get(id);
      if (!conv) throw new Error('Conversation not found');
      const updated = { ...conv, ...updateData, updatedAt: new Date() };
      conversations.set(id, updated);
      return updated;
    } else {
      return await Conversation.findByIdAndUpdate(
        id,
        { ...updateData, updatedAt: new Date() },
        { new: true }
      );
    }
  },

  deleteConversation: async (id) => {
    if (checkConnectionState()) {
      if (!conversations.has(id)) throw new Error('Conversation not found');
      conversations.delete(id);
      // Remove all associated messages
      let i = messages.length;
      while (i--) {
        if (messages[i].conversationId === id) {
          messages.splice(i, 1);
        }
      }
      return { success: true };
    } else {
      await Conversation.findByIdAndDelete(id);
      await Message.deleteMany({ conversationId: id });
      return { success: true };
    }
  },

  // MESSAGES
  createMessage: async (conversationId, role, content, modelUsed = '') => {
    if (checkConnectionState()) {
      const id = 'mock_msg_' + Math.random().toString(36).substring(2, 15);
      const msg = { _id: id, id: id, conversationId, role, content, modelUsed, createdAt: new Date() };
      messages.push(msg);

      // Update the updatedAt timestamp of the parent conversation, and
      // reset its rolling 30-day expiry since it just got used.
      const conv = conversations.get(conversationId);
      if (conv) {
        conv.updatedAt = new Date();
        conv.expiresAt = thirtyDaysFromNow();
        if (modelUsed) {
          conv.model = modelUsed;
        }
      }

      return msg;
    } else {
      const msg = await Message.create({ conversationId, role, content, modelUsed });
      await Conversation.findByIdAndUpdate(conversationId, {
        updatedAt: new Date(),
        expiresAt: thirtyDaysFromNow(),
        ...(modelUsed ? { model: modelUsed } : {})
      });
      return msg;
    }
  },

  getMessages: async (conversationId) => {
    if (checkConnectionState()) {
      return messages
        .filter(m => m.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt);
    } else {
      return await Message.find({ conversationId }).sort({ createdAt: 1 });
    }
  },

  // USERS
  createUser: async ({ name, username, accessCodeHash, role = 'user' }) => {
    if (checkConnectionState()) {
      const id = 'mock_user_' + Math.random().toString(36).substring(2, 15);
      const user = { _id: id, id, name, username, accessCodeHash, role, isActive: true, messageCount: 0, createdAt: new Date() };
      users.set(id, user);
      return user;
    } else {
      return await User.create({ name, username, accessCodeHash, role, isActive: true, messageCount: 0 });
    }
  },

  getUsers: async () => {
    if (checkConnectionState()) {
      return Array.from(users.values()).sort((a, b) => b.createdAt - a.createdAt);
    } else {
      return await User.find().sort({ createdAt: -1 });
    }
  },

  getUserById: async (id) => {
    if (checkConnectionState()) {
      return users.get(id) || null;
    } else {
      return await User.findById(id);
    }
  },

  findUserByUsername: async (username) => {
    if (checkConnectionState()) {
      return Array.from(users.values()).find(u => u.username === username) || null;
    } else {
      return await User.findOne({ username });
    }
  },

  countAdmins: async () => {
    if (checkConnectionState()) {
      return Array.from(users.values()).filter(u => u.role === 'admin').length;
    } else {
      return await User.countDocuments({ role: 'admin' });
    }
  },

  // Used by the /admin password login (env-var credentials) to find the
  // existing admin User record once the password check passes, so the
  // resulting session is a completely normal one — same shape as a
  // regular access-code login, nothing downstream needs to know which
  // login path was used.
  getAdminUser: async () => {
    if (checkConnectionState()) {
      return Array.from(users.values()).find(u => u.role === 'admin') || null;
    } else {
      return await User.findOne({ role: 'admin' });
    }
  },

  // Login can't look up a user "by code" directly since only the hash is
  // stored — the caller bcrypt-compares the submitted code against each
  // user's hash in turn. Fine at personal/small-team scale; would need a
  // different approach (e.g. a fast-lookup prefix) if the user count ever
  // grew into the hundreds+.
  getAllUsersForLogin: async () => {
    if (checkConnectionState()) {
      return Array.from(users.values());
    } else {
      return await User.find();
    }
  },

  updateUserAccessCode: async (id, accessCodeHash) => {
    if (checkConnectionState()) {
      const user = users.get(id);
      if (!user) throw new Error('User not found');
      user.accessCodeHash = accessCodeHash;
      return user;
    } else {
      return await User.findByIdAndUpdate(id, { accessCodeHash }, { new: true });
    }
  },

  // Update safe user fields (name + isActive — role/username/accessCodeHash
  // are not exposed here to avoid accidental privilege escalation).
  updateUser: async (id, fields) => {
    if (checkConnectionState()) {
      const user = users.get(id);
      if (!user) throw new Error('User not found');
      if (fields.name     !== undefined) user.name     = fields.name;
      if (fields.isActive !== undefined) user.isActive = fields.isActive;
      return user;
    } else {
      return await User.findByIdAndUpdate(id, { $set: fields }, { new: true });
    }
  },

  // Increments the per-user message counter shown in the admin panel.
  // Called after every successful AI response for identified users.
  incrementMessageCount: async (id) => {
    if (checkConnectionState()) {
      const user = users.get(id);
      if (user) user.messageCount = (user.messageCount || 0) + 1;
    } else {
      await User.findByIdAndUpdate(id, { $inc: { messageCount: 1 } });
    }
  },

  // Deletes the user, all their sessions, and (per the plan) cascades to
  // delete their conversations + messages rather than leaving them orphaned.
  cascadeDeleteUser: async (id) => {
    if (checkConnectionState()) {
      users.delete(id);
      for (const [token, s] of sessions.entries()) {
        if (String(s.userId) === String(id)) sessions.delete(token);
      }
      for (const [convId, conv] of conversations.entries()) {
        if (String(conv.userId) === String(id)) {
          conversations.delete(convId);
          let i = messages.length;
          while (i--) {
            if (messages[i].conversationId === convId) messages.splice(i, 1);
          }
        }
      }
      return { success: true };
    } else {
      const convs = await Conversation.find({ userId: id }, '_id');
      const convIds = convs.map(c => c._id);
      await Message.deleteMany({ conversationId: { $in: convIds } });
      await Conversation.deleteMany({ userId: id });
      await Session.deleteMany({ userId: id });
      await User.findByIdAndDelete(id);
      return { success: true };
    }
  },

  // SESSIONS
  createSession: async (userId, token) => {
    if (checkConnectionState()) {
      const id = 'mock_sess_' + Math.random().toString(36).substring(2, 15);
      const session = { _id: id, token, userId, createdAt: new Date() };
      sessions.set(token, session);
      return session;
    } else {
      return await Session.create({ token, userId });
    }
  },

  getSessionByToken: async (token) => {
    if (checkConnectionState()) {
      return sessions.get(token) || null;
    } else {
      return await Session.findOne({ token });
    }
  },

  deleteSession: async (token) => {
    if (checkConnectionState()) {
      sessions.delete(token);
      return { success: true };
    } else {
      await Session.deleteOne({ token });
      return { success: true };
    }
  },

  // Used when an admin regenerates someone's access code — kills any
  // session created under the old code immediately.
  deleteSessionsForUser: async (userId) => {
    if (checkConnectionState()) {
      for (const [token, s] of sessions.entries()) {
        if (String(s.userId) === String(userId)) sessions.delete(token);
      }
      return { success: true };
    } else {
      await Session.deleteMany({ userId });
      return { success: true };
    }
  }
};

module.exports = db;