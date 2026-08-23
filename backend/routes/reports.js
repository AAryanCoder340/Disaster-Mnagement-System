const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { mapReportRow } = require('../lib/mappers');
const { clusterCitizenReport } = require('../lib/clustering');
const { broadcast } = require('../lib/sse');
const { parseMultipartForm, persistUploadedFile } = require('../lib/multipart');
const { runEvidenceVerification } = require('../services/ai_verification');

const router = express.Router();

const VALID_SEVERITIES = new Set(['low', 'medium', 'high']);
const VALID_VERIFICATION = new Set(['pending', 'verified', 'rejected']);
const VALID_INCIDENT = new Set(['active', 'resolved', 'monitoring']);

function getUploadRoot() {
  return path.resolve(__dirname, '..', 'uploads');
}

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const includeHistorical = req.query.include_historical === 'true' || req.query.all === 'true';
    const status = req.query.status;

    let query = `
      SELECT r.*, u.username, u.display_name, u.trust_score
      FROM disaster_reports r
      JOIN users u ON u.id = r.user_id
      WHERE 1=1
    `;
    const params = [];

    if (!includeHistorical) {
      query += ` AND COALESCE(r.source_type, '') NOT IN ('HISTORICAL_EONET', 'HISTORICAL_NRSC') AND COALESCE(r.incident_status, 'active') != 'archived'`;
    }

    if (status) {
      query += ` AND r.incident_status = ?`;
      params.push(status);
    }

    query += ` ORDER BY datetime(r.created_at) DESC`;

    const rows = db.prepare(query).all(...params);

    res.json({ success: true, reports: rows.map(mapReportRow) });
  } catch (error) {
    console.error('GET /api/reports error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch reports' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT r.*, u.username, u.display_name, u.trust_score
      FROM disaster_reports r
      JOIN users u ON u.id = r.user_id
      WHERE r.id = ?
    `).get(req.params.id);

    if (!row) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    res.json({ success: true, report: mapReportRow(row) });
  } catch (error) {
    console.error('GET /api/reports/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch report' });
  }
});

async function parseRequest(req) {
  const isMultipart = (req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data');
  if (isMultipart) {
    const { fields, files } = await parseMultipartForm(req);
    return {
      fields,
      files: Array.isArray(files) ? files : [],
      isMultipart: true
    };
  }
  return {
    fields: req.body || {},
    files: [],
    isMultipart: false
  };
}

function fkCheck(db, stepLabel) {
  try {
    const v = db.prepare('PRAGMA foreign_key_check').all();
    if (v && v.length) {
      console.error(`[FK-VIOLATION] at ${stepLabel}:`, JSON.stringify(v));
    } else {
      console.log(`[FK-OK] ${stepLabel}`);
    }
  } catch (_) {}
}

router.post('/', async (req, res) => {
  const db = getDb();
  let txnStarted = false;
  try {
    const parsed = await parseRequest(req);
    const fields = parsed.fields || {};
    const files = parsed.files || [];

    const {
      disasterType,
      type,
      location,
      description,
      severity,
      latitude,
      longitude,
      userId,
      evidenceRef
    } = fields || {};

    const disaster_type = (disasterType || type || '').trim();
    const loc = (location || '').trim();
    const desc = (description || '').trim();
    const sev = (severity || '').trim().toLowerCase();

    if (!disaster_type || !loc || !desc || !sev) {
      return res.status(400).json({
        success: false,
        error: 'disasterType, location, description, and severity are required'
      });
    }

    if (!VALID_SEVERITIES.has(sev)) {
      return res.status(400).json({
        success: false,
        error: 'severity must be low, medium, or high'
      });
    }

    const defaultUserId =
      process.env.DEFAULT_USER_ID || '00000000-0000-4000-8000-000000000001';
    const reporterId = userId || defaultUserId;

    const user = db.prepare('SELECT id, trust_score FROM users WHERE id = ?').get(reporterId);
    if (!user) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }

    let lat = null;
    let lng = null;
    if (latitude !== undefined && latitude !== null && latitude !== '') {
      lat = Number(latitude);
      if (Number.isNaN(lat)) {
        return res.status(400).json({ success: false, error: 'Invalid latitude' });
      }
    }
    if (longitude !== undefined && longitude !== null && longitude !== '') {
      lng = Number(longitude);
      if (Number.isNaN(lng)) {
        return res.status(400).json({ success: false, error: 'Invalid longitude' });
      }
    }

    const id = uuidv4();
    const uploadRoot = getUploadRoot();
    const pendingEvidence = [];
    for (const f of files) {
        if (!f || !f.buffer || !f.buffer.length) continue;
        const persisted = persistUploadedFile({
            originalName: f.originalName,
            contentType: f.contentType,
            size: f.size,
            buffer: f.buffer,
            uploadRoot
        });
        const accessUrl = `/uploads/${persisted.relativePath.replace(/^uploads\//, '')}`;
        pendingEvidence.push({
            originalName: f.originalName,
            contentType: f.contentType,
            size: f.size,
            accessUrl,
            storagePath: persisted.storagePath,
            storedName: persisted.storedName,
            buffer: f.buffer
        });
    }

    let aiVerification = null;
    if (pendingEvidence.length) {
        const images = pendingEvidence.filter((e) => e.contentType.startsWith('image/'));
        const primary = images[0] || pendingEvidence[0];
        try {
            aiVerification = await runEvidenceVerification({
                evidenceBuffer: primary.buffer,
                contentType: primary.contentType,
                userSelectedType: disaster_type
            });
        } catch (aiErr) {
            console.error('AI verification error:', aiErr);
            aiVerification = null;
        }
    }

    let verificationState = 'none';
    let aiTopLabel = null;
    let aiConfidence = 0;
    let aiModelInfo = null;
    let verificationBonus = 0;
    let evidence_access_urls = pendingEvidence.map((e) => e.accessUrl);
    let evidence_ref_out = evidenceRef || (evidence_access_urls.length ? evidence_access_urls.join(',') : null);

    if (aiVerification) {
        verificationState = aiVerification.verificationState || 'inconclusive';
        aiTopLabel = aiVerification.topLabel || null;
        aiConfidence = aiVerification.topConfidence || 0;
        aiModelInfo = JSON.stringify(aiVerification.model || null);
        verificationBonus = aiVerification.verificationBonus || 0;
    }

    db.prepare('BEGIN').run();
    txnStarted = true;
    fkCheck(db, 'BEGIN');

    db.prepare(`
      INSERT INTO disaster_reports (
        id, user_id, disaster_type, location, description, severity,
        latitude, longitude, verification_status, incident_status,
        source, source_type, is_seed, corroboration_status, evidence_ref,
        ai_verification_state, ai_top_label, ai_confidence, ai_model_info
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active', 'CITIZEN', 'CITIZEN_REPORT', 0, 'CITIZEN_REPORTED', ?, ?, ?, ?, ?)
    `).run(
      id,
      reporterId,
      disaster_type,
      loc,
      desc,
      sev,
      lat,
      lng,
      evidence_ref_out,
      verificationState,
      aiTopLabel,
      aiConfidence,
      aiModelInfo
    );
    fkCheck(db, 'INSERT disaster_reports');

    const savedEvidence = [];
    if (pendingEvidence.length) {
      const insertEvidence = db.prepare(`
        INSERT INTO evidence_files (
          id, report_id, user_id, original_name, stored_name, content_type,
          size_bytes, storage_path, access_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const pe of pendingEvidence) {
        const evidenceId = uuidv4();
        insertEvidence.run(
          evidenceId,
          id,
          reporterId,
          pe.originalName,
          pe.storedName,
          pe.contentType,
          pe.size,
          pe.storagePath,
          pe.accessUrl
        );
        savedEvidence.push({
          id: evidenceId,
          originalName: pe.originalName,
          contentType: pe.contentType,
          size: pe.size,
          accessUrl: pe.accessUrl,
          buffer: pe.buffer
        });
      }
    }
    fkCheck(db, 'INSERT evidence_files');

    if (aiVerification && savedEvidence.length) {
      const insertAi = db.prepare(`
        INSERT INTO ai_verifications (
          id, report_id, evidence_id, model_name, model_provider, input_type,
          detected_labels_json, top_label, confidence, user_selected_type,
          match_state, verification_state, verification_bonus, flag_human_review,
          raw_response_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ev of savedEvidence) {
        insertAi.run(
          uuidv4(),
          id,
          ev.id,
          aiVerification.model?.name || 'unknown',
          aiVerification.model?.provider || 'unknown',
          ev.contentType.startsWith('video') ? 'video' : 'image',
          JSON.stringify(aiVerification.detections || []),
          aiTopLabel,
          aiConfidence,
          disaster_type,
          aiVerification.matchState || 'inconclusive',
          verificationState,
          verificationBonus,
          Number(Boolean(aiVerification.flagHumanReview)),
          JSON.stringify({ primaryEvidence: ev.originalName })
        );
      }
    }
    fkCheck(db, 'INSERT ai_verifications');

    const trustTotal = 2 + verificationBonus;
    if (trustTotal > 0) {
      db.prepare(`
        UPDATE users SET trust_score = trust_score + ? WHERE id = ?
      `).run(trustTotal, reporterId);
    }
    fkCheck(db, 'UPDATE users trust_score');

    const afterInsert = db.prepare(`
      SELECT r.*, u.username, u.display_name, u.trust_score
      FROM disaster_reports r
      JOIN users u ON u.id = r.user_id
      WHERE r.id = ?
    `).get(id);
    fkCheck(db, 'SELECT afterInsert');

    let incident = null;
    try {
      incident = clusterCitizenReport(afterInsert);
    } catch (clusterError) {
      console.error('Clustering failed after save:', clusterError);
    }
    fkCheck(db, 'clusterCitizenReport');

    const refreshed = db.prepare(`
      SELECT r.*, u.username, u.display_name, u.trust_score
      FROM disaster_reports r
      JOIN users u ON u.id = r.user_id
      WHERE r.id = ?
    `).get(id);
    fkCheck(db, 'SELECT refreshed');

    db.prepare('COMMIT').run();
    txnStarted = false;
    fkCheck(db, 'COMMIT');

    broadcast('hazard-update', {
      reason: 'citizen-report',
      reportId: id,
      incidentId: incident ? incident.id : null
    });

    const report = mapReportRow(refreshed);

    const responsePayload = {
      success: true,
      message: 'Citizen report saved immediately',
      report,
      evidence: savedEvidence.map(({ buffer: _buf, ...rest }) => rest),
      aiVerification: aiVerification
        ? {
            state: aiVerification.verificationState,
            topLabel: aiVerification.topLabel,
            topConfidence: aiVerification.topConfidence,
            matchState: aiVerification.matchState,
            flagHumanReview: Boolean(aiVerification.flagHumanReview),
            verificationBonus: aiVerification.verificationBonus,
            detections: aiVerification.detections,
            model: aiVerification.model
          }
        : null,
      incident: incident
        ? {
            id: incident.id,
            reportCount: incident.report_count,
            verificationStatus: incident.verification_status,
            confidenceScore: incident.confidence_score
          }
        : null
    };

    res.status(201).json(responsePayload);
  } catch (error) {
    if (txnStarted) {
      try { db.prepare('ROLLBACK').run(); } catch (_) { /* noop */ }
    }
    console.error('POST /api/reports error:', error);
    let errMsg = error.message || 'Failed to submit report';
    try {
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations && violations.length) {
        console.error('FK violation details:', JSON.stringify(violations));
        const detail = violations.map(v => `table=${v.table}, rowid=${v.rowid}, parent=${v.parent}, fkid=${v.fkid}`).join('; ');
        errMsg = `FOREIGN KEY constraint failed (${detail}). Database may need server restart to run schema migrations.`;
      }
    } catch (_) {}
    res.status(500).json({ success: false, error: errMsg });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM disaster_reports WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    const { verificationStatus, incidentStatus } = req.body || {};
    let verification = existing.verification_status;
    let incident = existing.incident_status;

    if (verificationStatus !== undefined) {
      if (!VALID_VERIFICATION.has(verificationStatus)) {
        return res.status(400).json({
          success: false,
          error: 'verificationStatus must be pending, verified, or rejected'
        });
      }
      verification = verificationStatus;
    }

    if (incidentStatus !== undefined) {
      if (!VALID_INCIDENT.has(incidentStatus)) {
        return res.status(400).json({
          success: false,
          error: 'incidentStatus must be active, resolved, or monitoring'
        });
      }
      incident = incidentStatus;
    }

    db.prepare(`
      UPDATE disaster_reports
      SET verification_status = ?, incident_status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(verification, incident, req.params.id);

    const row = db.prepare(`
      SELECT r.*, u.username, u.display_name, u.trust_score
      FROM disaster_reports r
      JOIN users u ON u.id = r.user_id
      WHERE r.id = ?
    `).get(req.params.id);

    res.json({ success: true, report: mapReportRow(row) });
  } catch (error) {
    console.error('PATCH /api/reports/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to update report' });
  }
});

module.exports = router;
