const express = require('express');
const { getDb } = require('../db');
const { mapIncidentRow, mapReportRow, mapAlertRow } = require('../lib/mappers');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const incidents = db.prepare(`
      SELECT * FROM incidents
      ORDER BY datetime(latest_reported_at) DESC
    `).all().map(mapIncidentRow);
    res.json({ success: true, incidents });
  } catch (error) {
    console.error('GET /api/incidents error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch incidents' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
    if (!incident) {
      return res.status(404).json({ success: false, error: 'Incident not found' });
    }

    const reports = db.prepare(`
      SELECT r.*, u.username, u.display_name, u.trust_score
      FROM disaster_reports r
      JOIN users u ON u.id = r.user_id
      WHERE r.incident_id = ?
      ORDER BY datetime(r.created_at) DESC
    `).all(req.params.id).map(mapReportRow);

    const officialAlerts = db.prepare(`
      SELECT * FROM official_alerts WHERE linked_incident_id = ?
    `).all(req.params.id).map(mapAlertRow);

    res.json({
      success: true,
      incident: mapIncidentRow(incident),
      reports,
      officialAlerts
    });
  } catch (error) {
    console.error('GET /api/incidents/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch incident' });
  }
});

module.exports = router;
