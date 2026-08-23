const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { broadcast } = require('../lib/sse');

const router = express.Router();

const SOS_STATUSES = ['PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESCUE_ASSIGNED', 'RESOLVED'];
const STATUS_TRANSITIONS = {
  PENDING: ['ACKNOWLEDGED', 'IN_PROGRESS', 'RESCUE_ASSIGNED', 'RESOLVED'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'RESCUE_ASSIGNED', 'RESOLVED'],
  IN_PROGRESS: ['RESCUE_ASSIGNED', 'RESOLVED'],
  RESCUE_ASSIGNED: ['RESOLVED'],
  RESOLVED: []
};

function generateShortSosId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `SOS-${id}`;
}

function generateUniqueShortId(db) {
  let attempts = 0;
  while (attempts < 50) {
    const candidate = generateShortSosId();
    const existing = db.prepare('SELECT id FROM sos_incidents WHERE sos_short_id = ?').get(candidate);
    if (!existing) return candidate;
    attempts++;
  }
  return `SOS-${Date.now().toString(36).toUpperCase()}`;
}

function mapSosRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sosShortId: row.sos_short_id,
    userId: row.user_id,
    latitude: row.latitude,
    longitude: row.longitude,
    locationAvailable: Boolean(row.location_available),
    status: row.status,
    acknowledgedAt: row.acknowledged_at,
    assignedAt: row.assigned_at,
    responseAt: row.response_at,
    resolvedAt: row.resolved_at,
    assignedTo: row.assigned_to,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isValidStatusTransition(from, to) {
  const allowed = STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { userId, latitude, longitude } = req.body || {};

    const locationAvailable =
      typeof latitude === 'number' && typeof longitude === 'number' &&
      !Number.isNaN(latitude) && !Number.isNaN(longitude);

    const id = uuidv4();
    const sosShortId = generateUniqueShortId(db);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO sos_incidents (
        id, sos_short_id, user_id, latitude, longitude,
        location_available, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'), datetime('now'))
    `).run(
      id,
      sosShortId,
      userId || null,
      locationAvailable ? latitude : null,
      locationAvailable ? longitude : null,
      locationAvailable ? 1 : 0
    );

    const row = db.prepare('SELECT * FROM sos_incidents WHERE id = ?').get(id);
    const incident = mapSosRow(row);

    broadcast('sos:new', {
      type: 'sos_new',
      incident,
      serverTime: now
    });

    res.status(201).json({
      success: true,
      incident,
      message: locationAvailable
        ? 'SOS activated with your current location.'
        : 'SOS activated. Note: Location was unavailable — authorities will contact you for details.'
    });
  } catch (error) {
    console.error('POST /api/sos error:', error);
    res.status(500).json({ success: false, error: 'Failed to activate SOS' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    let row = db.prepare('SELECT * FROM sos_incidents WHERE id = ?').get(id);
    if (!row) {
      row = db.prepare('SELECT * FROM sos_incidents WHERE sos_short_id = ?').get(id);
    }

    if (!row) {
      return res.status(404).json({ success: false, error: 'SOS incident not found' });
    }

    res.json({
      success: true,
      incident: mapSosRow(row)
    });
  } catch (error) {
    console.error('GET /api/sos/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch SOS incident' });
  }
});

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { status, user_id, limit } = req.query;

    let sql = 'SELECT * FROM sos_incidents WHERE 1=1';
    const params = [];

    if (status && SOS_STATUSES.includes(status)) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (user_id) {
      sql += ' AND user_id = ?';
      params.push(user_id);
    }

    sql += ' ORDER BY datetime(created_at) DESC';

    const maxRows = Math.min(Number(limit) || 100, 500);
    sql += ` LIMIT ${maxRows}`;

    const rows = db.prepare(sql).all(...params);

    res.json({
      success: true,
      incidents: rows.map(mapSosRow),
      count: rows.length
    });
  } catch (error) {
    console.error('GET /api/sos error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch SOS incidents' });
  }
});

router.patch('/:id/status', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { status, assignedTo, notes, authorityId } = req.body || {};

    if (!status || !SOS_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${SOS_STATUSES.join(', ')}`
      });
    }

    let row = db.prepare('SELECT * FROM sos_incidents WHERE id = ?').get(id);
    if (!row) {
      row = db.prepare('SELECT * FROM sos_incidents WHERE sos_short_id = ?').get(id);
    }

    if (!row) {
      return res.status(404).json({ success: false, error: 'SOS incident not found' });
    }

    const currentStatus = row.status;
    if (status !== currentStatus && !isValidStatusTransition(currentStatus, status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status transition from '${currentStatus}' to '${status}'. Allowed: ${STATUS_TRANSITIONS[currentStatus].join(', ') || '(none)'}`,
        currentStatus,
        allowedTransitions: STATUS_TRANSITIONS[currentStatus]
      });
    }

    const updates = [];
    const params = [];

    if (status !== currentStatus) {
      updates.push('status = ?');
      params.push(status);

      const timestampField = {
        ACKNOWLEDGED: 'acknowledged_at',
        IN_PROGRESS: 'response_at',
        RESCUE_ASSIGNED: 'assigned_at',
        RESOLVED: 'resolved_at'
      }[status];

      if (timestampField) {
        updates.push(`${timestampField} = datetime('now')`);
      }
    }

    if (assignedTo !== undefined) {
      updates.push('assigned_to = ?');
      params.push(assignedTo || null);
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes || null);
    }

    updates.push("updated_at = datetime('now')");
    params.push(row.id);

    const sql = `UPDATE sos_incidents SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...params);

    const updatedRow = db.prepare('SELECT * FROM sos_incidents WHERE id = ?').get(row.id);
    const incident = mapSosRow(updatedRow);

    broadcast('sos:update', {
      type: 'sos_update',
      incident,
      serverTime: new Date().toISOString()
    });

    res.json({
      success: true,
      incident,
      message: status === 'ACKNOWLEDGED'
        ? 'SOS acknowledged. Authorities have been notified.'
        : status === 'IN_PROGRESS'
          ? 'Response in progress.'
          : status === 'RESCUE_ASSIGNED'
            ? 'Rescue team assigned.'
            : status === 'RESOLVED'
              ? 'SOS marked as resolved.'
              : 'Status updated.'
    });
  } catch (error) {
    console.error('PATCH /api/sos/:id/status error:', error);
    res.status(500).json({ success: false, error: 'Failed to update SOS status' });
  }
});

router.get('/stats/summary', (req, res) => {
  try {
    const db = getDb();

    const totals = {};
    for (const s of SOS_STATUSES) {
      const r = db.prepare('SELECT COUNT(*) AS total FROM sos_incidents WHERE status = ?').get(s);
      totals[s] = r.total;
    }

    const total = db.prepare('SELECT COUNT(*) AS total FROM sos_incidents').get().total;
    const active = db.prepare(
      "SELECT COUNT(*) AS total FROM sos_incidents WHERE status IN ('PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESCUE_ASSIGNED')"
    ).get().total;
    const last24h = db.prepare(
      "SELECT COUNT(*) AS total FROM sos_incidents WHERE datetime(created_at) >= datetime('now', '-24 hours')"
    ).get().total;

    res.json({
      success: true,
      stats: {
        total,
        active,
        last24h,
        byStatus: totals
      }
    });
  } catch (error) {
    console.error('GET /api/sos/stats/summary error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch SOS stats' });
  }
});

module.exports = router;
