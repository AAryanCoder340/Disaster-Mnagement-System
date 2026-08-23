const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const users = db.prepare(`
      SELECT id, username, display_name, trust_score, is_active, created_at
      FROM users
      ORDER BY created_at ASC
    `).all();

    res.json({
      success: true,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        trustScore: u.trust_score,
        isActive: Boolean(u.is_active),
        createdAt: u.created_at
      }))
    });
  } catch (error) {
    console.error('GET /api/users error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

router.get('/me', (req, res) => {
  try {
    const db = getDb();
    const id =
      process.env.DEFAULT_USER_ID || '00000000-0000-4000-8000-000000000001';

    const user = db.prepare(`
      SELECT id, username, display_name, trust_score, is_active, created_at
      FROM users WHERE id = ?
    `).get(id);

    if (!user) {
      return res.status(404).json({ success: false, error: 'Default user not found' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        trustScore: user.trust_score,
        isActive: Boolean(user.is_active),
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('GET /api/users/me error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch current user' });
  }
});

module.exports = router;
