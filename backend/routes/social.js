const express = require('express');
const { getDb } = require('../db');
const { broadcast } = require('../lib/sse');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

router.get('/signals', (req, res) => {
  try {
    const db = getDb();
    const signals = db.prepare(`
      SELECT * FROM social_signals
      ORDER BY datetime(timestamp) DESC
    `).all();
    
    // Convert simulated to boolean for frontend
    const formatted = signals.map(s => ({
      ...s,
      simulated: s.simulated === 1
    }));
    
    res.json({ 
      success: true, 
      signals: formatted,
      provider: process.env.SOCIAL_DATA_PROVIDER || 'mock'
    });
  } catch (error) {
    console.error('GET /api/social/signals error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch social signals' });
  }
});

router.post('/signals/:id/:action', (req, res) => {
  const { id, action } = req.params;
  const role = req.headers['x-role'];

  // Role enforcement for Verify/Dismiss
  if (['verify', 'dismiss'].includes(action) && role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Access denied: Admin role required for this action' });
  }

  try {
    const db = getDb();
    const signal = db.prepare('SELECT * FROM social_signals WHERE id = ?').get(id);
    if (!signal) {
      return res.status(404).json({ success: false, error: 'Signal not found' });
    }

    let newStatus = signal.status;
    
    if (action === 'review') newStatus = 'UNDER REVIEW';
    if (action === 'verify') newStatus = 'VERIFIED';
    if (action === 'dismiss') newStatus = 'DISMISSED';
    
    db.prepare('UPDATE social_signals SET status = ?, updated_at = datetime("now") WHERE id = ?').run(newStatus, id);
    
    broadcast({ type: 'SOCIAL_SIGNALS_UPDATED' });
    
    res.json({ success: true, status: newStatus });
  } catch (error) {
    console.error(`POST /api/social/signals/${id}/${action} error:`, error);
    res.status(500).json({ success: false, error: `Failed to ${action} signal` });
  }
});

module.exports = router;
