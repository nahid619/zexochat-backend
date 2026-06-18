const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const db = require('./services/db');
const { resolveUser } = require('./middleware/auth');

const app = express();

// Configure CORS
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
app.use(cors({
  origin: frontendUrl,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Ensures the admin User record exists on first boot.
// Admin logs in at /admin with ADMIN_USERNAME + ADMIN_PASSWORD (env vars).
// The access-code login path (/api/auth/login) doesn't work for the admin
// — their accessCodeHash is deliberately set to an unusable value.
async function ensureBootstrapAdmin() {
  try {
    const adminCount = await db.countAdmins();
    if (adminCount > 0) return;

    const { generateAccessCode, hashCode } = require('./services/authUtils');
    const name     = process.env.ADMIN_NAME     || 'Admin';
    const username = process.env.ADMIN_USERNAME  || 'admin';
    const unusableCodeHash = await hashCode(generateAccessCode());

    await db.createUser({ name, username, accessCodeHash: unusableCodeHash, role: 'admin' });

    console.log('');
    console.log('================================================================');
    console.log('🔑 Admin account created:');
    console.log(`   Username : ${username}`);
    console.log(`   Password : set via ADMIN_PASSWORD in your .env`);
    console.log(`   Login at : /admin`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('   ⚠️  ADMIN_PASSWORD is not set — admin panel is inaccessible until you add it!');
    }
    console.log('================================================================');
    console.log('');
  } catch (err) {
    console.error('❌ Failed to bootstrap admin account:', err.message);
  }
}

// Database connection
let isMockDB = false;
const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
  console.warn('⚠️ MONGO_URI not set — running in Mock (in-memory) mode. Data resets on restart.');
  isMockDB = true;
  ensureBootstrapAdmin();
} else {
  mongoose.connect(mongoUri)
    .then(() => {
      console.log('✅ MongoDB connected.');
      ensureBootstrapAdmin();
    })
    .catch(err => {
      console.error('❌ MongoDB connection error:', err.message);
      console.warn('⚠️ Falling back to Mock mode.');
      isMockDB = true;
      ensureBootstrapAdmin();
    });
}

app.set('isMockDB', isMockDB);

// Attach req.user (or null) to every request from the session token
app.use(resolveUser);

// Health check
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend is alive!',
    databaseMode: isMockDB ? 'Mock (In-Memory)' : 'MongoDB Atlas',
    timestamp: new Date()
  });
});

// Routes
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/admin',   require('./routes/admin'));
app.use('/api/history', require('./routes/history'));
app.use('/api/models',  require('./routes/models'));
app.use('/api/chat',    require('./routes/chat'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`👉 CORS enabled for ${frontendUrl}`);
});