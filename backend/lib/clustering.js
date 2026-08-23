const { getDb } = require('../db');
const { haversineKm, sameHazardFamily, normalizeDisasterType } = require('./geo');

function clusterConfig() {
  return {
    radiusKm: Number(process.env.CLUSTER_RADIUS_KM) || 25,
    windowHours: Number(process.env.CLUSTER_WINDOW_HOURS) || 24
  };
}

function confidenceFromCount(count) {
  return Math.min(95, 15 + Number(count) * 3);
}

function lifecycleFromIncident(incident) {
  if (incident.incident_status === 'resolved') return 'RESOLVED';
  if (incident.official_corroboration) return 'OFFICIALLY_CORROBORATED';
  if (Number(incident.report_count) >= 3) return 'CORROBORATED';
  return 'CITIZEN_REPORTED';
}

function findMatchingIncident(report) {
  const db = getDb();
  const { radiusKm, windowHours } = clusterConfig();
  const type = normalizeDisasterType(report.disaster_type);
  const rows = db.prepare(`
    SELECT * FROM incidents
    WHERE incident_status != 'resolved'
      AND datetime(latest_reported_at) >= datetime('now', ?)
  `).all(`-${windowHours} hours`);

  let best = null;
  let bestDistance = Infinity;

  for (const incident of rows) {
    if (!sameHazardFamily(incident.disaster_type, type)) continue;
    if (report.latitude == null || report.longitude == null || incident.latitude == null || incident.longitude == null) {
      const samePlace =
        String(incident.location_name || '').toLowerCase() ===
        String(report.location || '').toLowerCase();
      if (samePlace && !best) best = incident;
      continue;
    }
    const km = haversineKm(
      report.latitude,
      report.longitude,
      incident.latitude,
      incident.longitude
    );
    if (km != null && km <= radiusKm && km < bestDistance) {
      best = incident;
      bestDistance = km;
    }
  }
  return best;
}

function attachReportToIncident(report, incidentId) {
  const db = getDb();
  const incidentExists = db.prepare('SELECT 1 FROM incidents WHERE id = ?').get(incidentId);
  const reportExists = db.prepare('SELECT 1 FROM disaster_reports WHERE id = ?').get(report?.id);
  if (!incidentExists || !reportExists) {
    console.warn(`[clustering] attachReportToIncident skipped: incident=${!!incidentExists}, report=${!!reportExists}, reportId=${report?.id}, incidentId=${incidentId}`);
    return;
  }
  try {
    db.prepare(`
      INSERT OR IGNORE INTO incident_reports (incident_id, report_id)
      VALUES (?, ?)
    `).run(incidentId, report.id);
  } catch (fkErr) {
    console.warn(`[clustering] incident_reports INSERT skipped due to FK: ${fkErr.message}`);
    return;
  }

  db.prepare(`
    UPDATE disaster_reports
    SET incident_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(incidentId, report.id);
}

function refreshIncidentStats(incidentId) {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS report_count,
      MIN(created_at) AS first_reported_at,
      MAX(created_at) AS latest_reported_at,
      AVG(latitude) AS latitude,
      AVG(longitude) AS longitude
    FROM disaster_reports
    WHERE incident_id = ?
  `).get(incidentId);

  const official = db.prepare(`
    SELECT COUNT(*) AS total FROM official_alerts
    WHERE linked_incident_id = ?
  `).get(incidentId).total;

  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  const reportCount = stats.report_count || 0;
  const officialFlag = official > 0 || incident.official_corroboration ? 1 : 0;
  const verification = officialFlag
    ? 'OFFICIALLY_CORROBORATED'
    : reportCount >= 3
      ? 'CORROBORATED'
      : 'CITIZEN_REPORTED';

  db.prepare(`
    UPDATE incidents
    SET report_count = ?,
        first_reported_at = COALESCE(?, first_reported_at),
        latest_reported_at = COALESCE(?, latest_reported_at),
        latitude = COALESCE(?, latitude),
        longitude = COALESCE(?, longitude),
        confidence_score = ?,
        official_corroboration = ?,
        verification_status = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    reportCount,
    stats.first_reported_at,
    stats.latest_reported_at,
    stats.latitude,
    stats.longitude,
    confidenceFromCount(reportCount),
    officialFlag,
    verification,
    incidentId
  );

  const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  db.prepare(`
    UPDATE disaster_reports
    SET corroboration_status = ?, updated_at = datetime('now')
    WHERE incident_id = ?
      AND is_seed = 0
  `).run(lifecycleFromIncident(updated), incidentId);

  return updated;
}

function createIncidentFromReport(report) {
  const { v4: uuidv4 } = require('uuid');
  const db = getDb();
  const id = uuidv4();
  const type = normalizeDisasterType(report.disaster_type);
  db.prepare(`
    INSERT INTO incidents (
      id, disaster_type, location_name, latitude, longitude,
      report_count, first_reported_at, latest_reported_at,
      verification_status, confidence_score, official_corroboration, incident_status
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'CITIZEN_REPORTED', ?, 0, 'active')
  `).run(
    id,
    type,
    report.location,
    report.latitude,
    report.longitude,
    report.created_at,
    report.created_at,
    confidenceFromCount(1)
  );
  attachReportToIncident(report, id);
  return refreshIncidentStats(id);
}

function clusterCitizenReport(report) {
  const existing = findMatchingIncident(report);
  if (existing) {
    attachReportToIncident(report, existing.id);
    return refreshIncidentStats(existing.id);
  }
  return createIncidentFromReport(report);
}

function linkOfficialAlertToIncidents(alert) {
  const db = getDb();
  const { radiusKm } = clusterConfig();
  const incidents = db.prepare(`
    SELECT * FROM incidents WHERE incident_status != 'resolved'
  `).all();

  let linked = 0;
  for (const incident of incidents) {
    if (!sameHazardFamily(incident.disaster_type, alert.disaster_type)) continue;
    let match = false;
    if (
      alert.latitude != null &&
      alert.longitude != null &&
      incident.latitude != null &&
      incident.longitude != null
    ) {
      const km = haversineKm(
        alert.latitude,
        alert.longitude,
        incident.latitude,
        incident.longitude
      );
      match = km != null && km <= radiusKm;
    } else {
      const a = String(alert.location_name || '').toLowerCase();
      const b = String(incident.location_name || '').toLowerCase();
      match = Boolean(a && b && (a.includes(b) || b.includes(a)));
    }
    if (!match) continue;
    db.prepare(`
      UPDATE official_alerts
      SET linked_incident_id = ?
      WHERE id = ?
    `).run(incident.id, alert.id);
    refreshIncidentStats(incident.id);
    linked += 1;
  }
  return linked;
}

module.exports = {
  clusterCitizenReport,
  linkOfficialAlertToIncidents,
  refreshIncidentStats,
  clusterConfig
};
