const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.get('/stats', (req, res) => {
  try {
    const db = getDb();

    const totalReports = db.prepare(`
      SELECT COUNT(*) AS total FROM disaster_reports WHERE is_seed = 0
    `).get().total;

    const citizenReports = db.prepare(`
      SELECT COUNT(*) AS total FROM disaster_reports
      WHERE source_type = 'CITIZEN_REPORT' AND is_seed = 0
    `).get().total;

    const highPriorityReports = db.prepare(`
      SELECT COUNT(*) AS total FROM disaster_reports
      WHERE severity = 'high' AND is_seed = 0
    `).get().total;

    const verifiedReports = db.prepare(`
      SELECT COUNT(*) AS total FROM disaster_reports
      WHERE verification_status = 'verified' AND is_seed = 0
    `).get().total;

    const reportsLast24h = db.prepare(`
      SELECT COUNT(*) AS total FROM disaster_reports
      WHERE is_seed = 0 AND datetime(created_at) >= datetime('now', '-24 hours')
    `).get().total;

    const activeUsers = db.prepare(`
      SELECT COUNT(*) AS total FROM users WHERE is_active = 1
    `).get().total;

    const activeIncidents = db.prepare(`
      SELECT COUNT(*) AS total FROM incidents WHERE incident_status = 'active'
    `).get().total;

    const emergingIncidents = db.prepare(`
      SELECT COUNT(*) AS total FROM incidents
      WHERE incident_status = 'active' AND report_count >= 3 AND official_corroboration = 0
    `).get().total;

    const verifiedIncidents = db.prepare(`
      SELECT COUNT(*) AS total FROM incidents
      WHERE official_corroboration = 1 OR verification_status IN ('OFFICIALLY_CORROBORATED', 'VERIFIED')
    `).get().total;

    const officialAlerts = db.prepare(`
      SELECT COUNT(*) AS total FROM official_alerts WHERE incident_status = 'active'
    `).get().total;

    const activeHazards = db.prepare(`
      SELECT (
        (SELECT COUNT(*) FROM disaster_reports WHERE incident_status = 'active' AND is_seed = 0)
        + (SELECT COUNT(*) FROM official_alerts WHERE incident_status = 'active')
      ) AS total
    `).get().total;

    res.json({
      success: true,
      stats: {
        totalReports,
        citizenReports,
        highPriorityReports,
        verifiedReports,
        reportsLast24h,
        activeUsers,
        activeIncidents,
        emergingIncidents,
        verifiedIncidents,
        officialAlerts,
        activeHazards
      }
    });
  } catch (error) {
    console.error('GET /api/dashboard/stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch dashboard stats' });
  }
});

module.exports = router;
