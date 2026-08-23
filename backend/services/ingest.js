const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { fetchImdAlerts } = require('./imd');
const { fetchSachetAlerts } = require('./sachet');
const { linkOfficialAlertToIncidents } = require('../lib/clustering');
const { broadcast } = require('../lib/sse');

function upsertSourceStatus(source, payload) {
  const db = getDb();
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
    payload.configured ? 1 : 0,
    payload.live ? 1 : 0,
    payload.live ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
    payload.error || null,
    JSON.stringify(payload.details || {})
  );
}

function storeAlert(alert) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO official_alerts (
      id, source, source_type, external_id, disaster_type, warning_type,
      location_name, state, district, latitude, longitude, severity, description,
      issued_at, valid_until, observed_at, fetched_at, verification_status,
      incident_status, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'OFFICIAL_ALERT', 'active', ?)
    ON CONFLICT(external_id) DO UPDATE SET
      description = excluded.description,
      severity = excluded.severity,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      fetched_at = datetime('now'),
      issued_at = excluded.issued_at,
      valid_until = excluded.valid_until,
      observed_at = excluded.observed_at,
      raw_json = excluded.raw_json
  `).run(
    id,
    alert.source,
    alert.sourceType,
    alert.externalId,
    alert.disasterType,
    alert.warningType || null,
    alert.locationName || null,
    alert.state || null,
    alert.district || null,
    alert.latitude ?? null,
    alert.longitude ?? null,
    alert.severity || 'medium',
    alert.description || '',
    alert.issuedAt || null,
    alert.validUntil || null,
    alert.observedAt || null,
    JSON.stringify(alert.raw || {})
  );

  const stored = db.prepare('SELECT * FROM official_alerts WHERE external_id = ?').get(alert.externalId);
  linkOfficialAlertToIncidents(stored);
  return stored;
}

function storeObservation(alert) {
  const db = getDb();
  db.prepare(`
    INSERT INTO weather_observations (
      id, source, source_type, external_id, location_name, latitude, longitude,
      observed_at, fetched_at, description, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      description = excluded.description,
      fetched_at = datetime('now'),
      raw_json = excluded.raw_json
  `).run(
    uuidv4(),
    alert.source,
    alert.sourceType,
    alert.externalId,
    alert.locationName || null,
    alert.latitude ?? null,
    alert.longitude ?? null,
    alert.observedAt || null,
    alert.description || '',
    JSON.stringify(alert.raw || {})
  );
}

async function ingestOfficialSources() {
  const imd = await fetchImdAlerts();
  upsertSourceStatus('IMD', {
    configured: imd.configured,
    live: imd.live,
    error: imd.error,
    details: { endpoints: imd.endpoints || [] }
  });

  const sachet = await fetchSachetAlerts();
  upsertSourceStatus('NDMA_SACHET', {
    configured: sachet.configured,
    live: sachet.live,
    error: sachet.error,
    details: {}
  });

  let stored = 0;
  for (const alert of imd.alerts || []) {
    if (alert.sourceType === 'WEATHER_OBSERVATION' || alert.sourceType === 'RAINFALL') {
      storeObservation(alert);
    }
    storeAlert(alert);
    stored += 1;
  }
  for (const alert of sachet.alerts || []) {
    storeAlert(alert);
    stored += 1;
  }

  if (stored > 0) {
    broadcast('hazard-update', { reason: 'official-ingest', stored });
  }

  return { imd, sachet, stored };
}

function startOfficialIngest() {
  const minutes = Number(process.env.OFFICIAL_INGEST_MINUTES) || 15;
  const run = async () => {
    try {
      await ingestOfficialSources();
    } catch (error) {
      console.error('Official ingest failed:', error.message);
      upsertSourceStatus('IMD', {
        configured: Boolean(process.env.IMD_API_TOKEN || process.env.IMD_API_KEY || process.env.IMD_JWT),
        live: false,
        error: error.message
      });
    }
  };
  setTimeout(run, 2000);
  setInterval(run, minutes * 60 * 1000);
}

async function fetchLiveEnvironmentalSignals({ latitude, longitude, locationName }) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${Number(latitude).toFixed(4)}&longitude=${Number(longitude).toFixed(4)}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&hourly=precipitation&forecast_days=2`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const json = await response.json();
    const cur = json.current || {};
    const hourly = json.hourly?.precipitation || [];
    const forecastRain = hourly.slice(0, 24).reduce((sum, v) => sum + (Number(v) || 0), 0);

    const db = getDb();
    const externalId = `WEATHER:${Number(latitude).toFixed(3)}:${Number(longitude).toFixed(3)}:${new Date().toISOString().slice(0, 13)}`;
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.prepare(`
      INSERT INTO weather_observations (
        id, source, source_type, external_id, location_name, latitude, longitude,
        observed_at, fetched_at, rainfall_mm, temperature, description, raw_json
      ) VALUES (?, 'OPEN_METEO', 'WEATHER_OBSERVATION', ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        rainfall_mm = excluded.rainfall_mm,
        temperature = excluded.temperature,
        fetched_at = datetime('now'),
        raw_json = excluded.raw_json
    `).run(
      uuidv4(),
      externalId,
      locationName || `Live Weather Station (${Number(latitude).toFixed(2)}, ${Number(longitude).toFixed(2)})`,
      Number(latitude),
      Number(longitude),
      nowIso,
      Number(cur.precipitation || 0),
      Number(cur.temperature_2m || null),
      `Temp: ${cur.temperature_2m}°C, Humidity: ${cur.relative_humidity_2m}%, Wind: ${cur.wind_speed_10m} km/h, Rain: ${cur.precipitation} mm`,
      JSON.stringify({
        'Last 24 hrs Rainfall': Number(cur.precipitation || 0),
        'Next 24 hrs Forecast': +forecastRain.toFixed(1),
        'Temperature': Number(cur.temperature_2m || null),
        'Humidity': Number(cur.relative_humidity_2m || null),
        'Wind Speed': Number(cur.wind_speed_10m || null)
      })
    );
    return true;
  } catch (err) {
    console.error('Error fetching live environmental signals:', err.message);
    return null;
  }
}

module.exports = {
  ingestOfficialSources,
  startOfficialIngest,
  fetchLiveEnvironmentalSignals
};
