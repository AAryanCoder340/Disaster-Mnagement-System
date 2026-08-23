const express = require('express');
const { getDb } = require('../db');
const { mapAlertRow, mapSourceStatus } = require('../lib/mappers');
const { ingestOfficialSources } = require('../services/ingest');

const router = express.Router();

router.get('/status', (req, res) => {
  try {
    const db = getDb();
    const sources = db.prepare('SELECT * FROM source_status ORDER BY source').all().map(mapSourceStatus);
    res.json({ success: true, sources });
  } catch (error) {
    console.error('GET /api/official/status error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch source status' });
  }
});

router.get('/alerts', (req, res) => {
  try {
    const db = getDb();
    const alerts = db.prepare(`
      SELECT * FROM official_alerts
      ORDER BY datetime(fetched_at) DESC
    `).all().map(mapAlertRow);
    res.json({ success: true, alerts });
  } catch (error) {
    console.error('GET /api/official/alerts error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch official alerts' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const result = await ingestOfficialSources();
    res.json({
      success: true,
      imd: {
        configured: result.imd.configured,
        live: result.imd.live,
        error: result.imd.error,
        alertCount: (result.imd.alerts || []).length
      },
      sachet: {
        configured: result.sachet.configured,
        live: result.sachet.live,
        error: result.sachet.error,
        alertCount: (result.sachet.alerts || []).length
      },
      stored: result.stored
    });
  } catch (error) {
    console.error('POST /api/official/refresh error:', error);
    res.status(500).json({ success: false, error: 'Official refresh failed' });
  }
});

module.exports = router;
