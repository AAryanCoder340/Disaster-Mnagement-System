const express = require('express');
const { getDb } = require('../db');
const { mapReportRow, mapIncidentRow, mapAlertRow, mapSourceStatus } = require('../lib/mappers');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const db = getDb();

    const reports = db.prepare(`
      SELECT r.*, u.username, u.display_name, u.trust_score
      FROM disaster_reports r
      JOIN users u ON u.id = r.user_id
      ORDER BY datetime(r.created_at) DESC
    `).all().map(mapReportRow);

    const officialAlerts = db.prepare(`
      SELECT * FROM official_alerts
      ORDER BY datetime(fetched_at) DESC
    `).all().map(mapAlertRow);

    const incidents = db.prepare(`
      SELECT * FROM incidents
      ORDER BY datetime(latest_reported_at) DESC
    `).all().map(mapIncidentRow);

    const sources = db.prepare(`
      SELECT * FROM source_status ORDER BY source
    `).all().map(mapSourceStatus);

    res.json({
      success: true,
      citizenReports: reports.filter((r) => r.sourceType === 'CITIZEN_REPORT'),
      seedReports: reports.filter((r) => r.isSeed || r.sourceType === 'DEMO_SEED'),
      reports,
      officialAlerts,
      incidents,
      sources
    });
  } catch (error) {
    console.error('GET /api/hazards error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch hazards' });
  }
});

module.exports = router;
