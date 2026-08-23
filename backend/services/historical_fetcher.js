const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { haversineKm } = require('../lib/geo');

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || '00000000-0000-4000-8000-000000000001';
const NRSC_DATASET_PATH = path.join(__dirname, '..', 'data', 'india_disaster_inventory_nrsc.json');

function loadNrscInventory() {
  try {
    if (fs.existsSync(NRSC_DATASET_PATH)) {
      const raw = fs.readFileSync(NRSC_DATASET_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('Error loading NRSC inventory:', err);
  }
  return [];
}

function parseDateIso(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

function filterNrscRecords({ latitude, longitude, radiusKm, startDate, endDate }) {
  const allRecords = loadNrscInventory();
  const matched = [];
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  for (const record of allRecords) {
    if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude)) continue;
    const distKm = haversineKm(latitude, longitude, record.latitude, record.longitude);
    if (distKm == null || distKm > radiusKm) continue;

    const eventDate = parseDateIso(record.event_time);
    if (eventDate) {
      if (start && eventDate < start) continue;
      if (end && eventDate > end) continue;
    }

    matched.push({
      ...record,
      km_from_center: +distKm.toFixed(1)
    });
  }

  return matched;
}

async function fetchFromEonet({ latitude, longitude, radiusKm, startDate, endDate }) {
  const baseUrl = process.env.HISTORICAL_EONET_BASE_URL || 'https://eonet.gsfc.nasa.gov/api/v3';
  const categories = process.env.HISTORICAL_EONET_CATEGORIES || 'floods,severeStorms,landslides';

  const R = 6371;
  const radLat = (latitude * Math.PI) / 180;
  const dLat = (radiusKm / R) * (180 / Math.PI);
  const dLng = (radiusKm / (R * Math.cos(radLat))) * (180 / Math.PI);
  const bboxStr = `${(longitude - dLng).toFixed(5)},${(latitude + dLat).toFixed(5)},${(longitude + dLng).toFixed(5)},${(latitude - dLat).toFixed(5)}`;

  const urlObj = new URL(`${baseUrl}/events`);
  urlObj.searchParams.set('bbox', bboxStr);
  if (startDate) urlObj.searchParams.set('start', startDate);
  if (endDate) urlObj.searchParams.set('end', endDate);
  urlObj.searchParams.set('category', categories);
  urlObj.searchParams.set('status', 'all');
  urlObj.searchParams.set('limit', '100');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(urlObj.toString(), {
      headers: { 'Accept': 'application/json', 'User-Agent': 'CoastWatch-Historical/1.0' },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) return [];
    const json = await response.json();
    const events = Array.isArray(json.events) ? json.events : [];
    const records = [];

    for (const ev of events) {
      const geometries = Array.isArray(ev.geometry) ? ev.geometry : [];
      let gIdx = 0;
      for (const geom of geometries) {
        if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
          const lng = Number(geom.coordinates[0]);
          const lat = Number(geom.coordinates[1]);
          const km = haversineKm(latitude, longitude, lat, lng);
          if (km != null && km <= radiusKm) {
            records.push({
              external_id: `EONET:${ev.id}:${gIdx}:${lat.toFixed(4)}:${lng.toFixed(4)}`,
              disaster_type: String(ev.categories?.[0]?.id || 'storm').toLowerCase().includes('flood') ? 'flood' : 'storm',
              location: ev.title || `Natural event near (${lat.toFixed(3)}, ${lng.toFixed(3)})`,
              description: `${ev.title || 'Event'} | Date: ${geom.date || 'unknown'}`,
              severity: 'medium',
              latitude: lat,
              longitude: lng,
              event_time: geom.date,
              source: 'NASA_EONET',
              source_type: 'HISTORICAL_EONET',
              source_url: ev.sources?.[0]?.url || 'https://eonet.gsfc.nasa.gov',
              km_from_center: +km.toFixed(1)
            });
            gIdx++;
          }
        }
      }
    }
    return records;
  } catch (_err) {
    return [];
  }
}

function storeHistoricalRecords(records) {
  const db = getDb();
  const existingStmt = db.prepare('SELECT id FROM disaster_reports WHERE external_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO disaster_reports (
      id, user_id, disaster_type, location, description, severity,
      latitude, longitude, verification_status, incident_status,
      source, source_type, is_seed, corroboration_status, external_id, source_url,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, 'verified', 'archived',
      ?, ?, 0, 'OFFICIAL_CORROBORATED', ?, ?,
      ?, ?
    )
  `);

  let saved = 0;
  let skipped = 0;

  db.exec('BEGIN');
  try {
    for (const r of records) {
      if (!r.external_id) continue;
      const existing = existingStmt.get(r.external_id);
      if (existing) {
        skipped += 1;
        continue;
      }
      try {
        const at = r.event_time ? String(r.event_time).replace('T', ' ').replace('Z', '').slice(0, 19) : null;
        insertStmt.run(
          uuidv4(),
          DEFAULT_USER_ID,
          r.disaster_type,
          r.location,
          r.description,
          r.severity,
          r.latitude,
          r.longitude,
          r.source || 'NRSC_ISRO',
          r.source_type || 'HISTORICAL_NRSC',
          r.external_id,
          r.source_url || 'https://bhuvan.nrsc.gov.in',
          at || new Date().toISOString().replace('T', ' ').slice(0, 19),
          new Date().toISOString().replace('T', ' ').slice(0, 19)
        );
        saved += 1;
      } catch (insertErr) {
        if (String(insertErr.message || '').includes('UNIQUE')) {
          skipped += 1;
        } else {
          throw insertErr;
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { saved, skipped };
}

function upsertSourceStatusForHistorical(source, configured, live, errorMsg, details) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO source_status (source, configured, live, last_fetch_at, last_success_at, last_error, details_json)
      VALUES (?, ?, ?, datetime('now'), ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        configured = excluded.configured,
        live = excluded.live,
        last_fetch_at = excluded.last_fetch_at,
        last_success_at = COALESCE(excluded.last_success_at, source_status.last_success_at),
        last_error = excluded.last_error,
        details_json = excluded.details_json
    `).run(
      source,
      configured ? 1 : 0,
      live ? 1 : 0,
      live ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
      errorMsg || null,
      JSON.stringify(details || {})
    );
  } catch (_e) {
    // noop
  }
}

async function fetchHistoricalData(params = {}) {
  const latitude = Number(params.latitude);
  const longitude = Number(params.longitude);
  const radiusKm = Number(params.radius_km || params.radiusKm || process.env.RISK_RADIUS_KM || 80);
  const startDate = params.start_date || params.startDate;
  const endDate = params.end_date || params.endDate;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('latitude and longitude are required numeric parameters');
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error('radius_km must be a positive number');
  }

  // 1. Fetch from NRSC/ISRO official inventory
  const nrscRecords = filterNrscRecords({ latitude, longitude, radiusKm, startDate, endDate });

  // 2. Fetch from NASA EONET if date range is recent or to supplement
  let eonetRecords = [];
  try {
    eonetRecords = await fetchFromEonet({ latitude, longitude, radiusKm, startDate, endDate });
  } catch (_e) {
    eonetRecords = [];
  }

  const combined = [...nrscRecords, ...eonetRecords];
  const fetched = combined.length;
  let saved = 0;
  let skipped = 0;

  if (combined.length) {
    const storeRes = storeHistoricalRecords(combined);
    saved = storeRes.saved;
    skipped = storeRes.skipped;
  }

  upsertSourceStatusForHistorical('NRSC_ISRO', true, true, null, {
    latitude,
    longitude,
    radiusKm,
    startDate,
    endDate,
    fetched,
    saved,
    skipped
  });

  return {
    records_fetched: fetched,
    records_saved: saved,
    records_skipped: skipped,
    source: 'NRSC/ISRO',
    message: 'Historical data synchronized successfully',
    date_range: { start: startDate, end: endDate },
    location: { latitude, longitude, radius_km: radiusKm },
    sample_records: combined.slice(0, 10).map(r => ({
      type: r.disaster_type,
      location: r.location,
      severity: r.severity,
      date: r.event_time ? String(r.event_time).slice(0, 10) : null,
      km: r.km_from_center
    }))
  };
}

function getLastHistoricalSync() {
  const db = getDb();
  try {
    const row = db.prepare("SELECT last_fetch_at, last_success_at, last_error, details_json FROM source_status WHERE source IN ('NRSC_ISRO', 'NASA_EONET') ORDER BY last_fetch_at DESC LIMIT 1").get();
    if (!row) return { source: 'NRSC/ISRO', last_sync_at: null, last_success_at: null, last_error: null, configured: true };
    let details = {};
    try { details = JSON.parse(row.details_json || '{}'); } catch (_) { details = {}; }
    return {
      source: 'NRSC/ISRO',
      last_sync_at: row.last_fetch_at,
      last_success_at: row.last_success_at,
      last_error: row.last_error,
      configured: true,
      details
    };
  } catch (_error) {
    return { source: 'NRSC/ISRO', last_sync_at: null, last_success_at: null, last_error: null, configured: true };
  }
}

module.exports = {
  fetchHistoricalData,
  getLastHistoricalSync,
  filterNrscRecords,
  storeHistoricalRecords
};
