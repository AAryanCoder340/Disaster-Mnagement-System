const { normalizeDisasterType } = require('../lib/geo');
const { geocodePlace } = require('../lib/geocode');

const IMD_WARNING_CODES = {
  1: 'No Warning',
  2: 'Heavy Rain',
  3: 'Heavy Snow',
  4: 'Thunderstorm & Lightning, Squall etc',
  5: 'Hailstorm',
  6: 'Dust Storm',
  7: 'Dust Raising Winds',
  8: 'Strong Surface Winds',
  9: 'Heat Wave',
  10: 'Hot Day',
  11: 'Warm Night',
  12: 'Cold Wave',
  13: 'Cold Day',
  14: 'Ground Frost',
  15: 'Fog',
  16: 'Very Heavy Rain',
  17: 'Extremely Heavy Rain'
};

const COLOR_SEVERITY = {
  1: 'high',
  2: 'high',
  3: 'medium',
  4: 'low'
};

function hasImdCredentials() {
  return Boolean(
    process.env.IMD_API_TOKEN ||
    process.env.IMD_JWT ||
    process.env.IMD_API_KEY
  );
}

function imdHeaders() {
  const headers = { Accept: 'application/json' };
  const token = process.env.IMD_API_TOKEN || process.env.IMD_JWT;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (process.env.IMD_API_KEY) headers['x-api-key'] = process.env.IMD_API_KEY;
  return headers;
}

async function fetchImd(path) {
  const url = `https://api.imd.gov.in${path}`;
  const response = await fetch(url, {
    headers: imdHeaders(),
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_error) {
    json = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    url,
    json,
    text: text.slice(0, 400)
  };
}

function asArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.result)) return payload.result;
  if (typeof payload === 'object') return [payload];
  return [];
}

function warningCodesToType(dayValue) {
  const codes = String(dayValue || '')
    .split(',')
    .map((c) => Number(c.trim()))
    .filter((n) => Number.isFinite(n) && n > 1);
  if (!codes.length) return null;
  const labels = codes.map((c) => IMD_WARNING_CODES[c] || `Warning ${c}`);
  const joined = labels.join(', ');
  return {
    disasterType: normalizeDisasterType(joined),
    warningType: joined
  };
}

function colorToSeverity(color) {
  return COLOR_SEVERITY[Number(color)] || 'medium';
}

function normalizeDistrictWarning(row) {
  const mapped = warningCodesToType(row.Day_1 || row.Day1);
  if (!mapped) return null;
  const location = row.District || row.district || 'Unknown district';
  const coords = geocodePlace(location);
  return {
    source: 'IMD',
    sourceType: 'IMD_WARNING',
    externalId: `imd-districtwarning-${row.Obj_id || row.District}-${row.Date || ''}`,
    disasterType: mapped.disasterType,
    warningType: mapped.warningType,
    locationName: location,
    state: row.State || null,
    district: location,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    severity: colorToSeverity(row.Day1_Color || row.Day_1_Color),
    description: `IMD district warning for ${location}: ${mapped.warningType}`,
    issuedAt: row.Date || null,
    raw: row
  };
}

function normalizeNowcast(row) {
  const message = row.message || row.Message || '';
  const color = row.color || row.Color;
  if (Number(color) === 1 && !message) return null;
  const location = row.District || row.district || row.Station || 'Unknown';
  const coords = geocodePlace(location);
  return {
    source: 'IMD',
    sourceType: 'NOWCAST',
    externalId: `imd-nowcast-${location}-${row.Date || ''}-${row.toi || ''}`,
    disasterType: normalizeDisasterType(message || 'storm'),
    warningType: message || 'District nowcast',
    locationName: location,
    district: location,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    severity: colorToSeverity(color),
    description: message || `IMD nowcast for ${location}`,
    issuedAt: row.Date || null,
    validUntil: row.Vupto || null,
    raw: row
  };
}

function normalizeRainfall(row) {
  const actual = Number(row['Daily Actual'] || row.DailyActual || row.actual || 0);
  if (!Number.isFinite(actual) || actual < 50) return null;
  const location = row.District || row.State || 'Unknown';
  const coords = geocodePlace(location);
  return {
    source: 'IMD',
    sourceType: 'RAINFALL',
    externalId: `imd-rainfall-${location}-${row.Date || ''}`,
    disasterType: 'flood',
    warningType: 'Heavy rainfall observation',
    locationName: location,
    state: row.State || null,
    district: row.District || null,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    severity: actual >= 150 ? 'high' : 'medium',
    description: `IMD rainfall ${actual} mm recorded at ${location}`,
    observedAt: row.Date || null,
    raw: row
  };
}

function normalizePortWarning(row) {
  const warning = String(row.Warning || row.warning || '').trim();
  if (!warning || warning.toUpperCase() === 'NIL' || warning.toUpperCase() === 'NO WARNING') {
    return null;
  }
  const location = row['Port Name'] || row.PortName || row.port || 'Unknown port';
  const coords = geocodePlace(location);
  return {
    source: 'IMD',
    sourceType: 'PORT_WARNING',
    externalId: `imd-port-${row['Port Id'] || row.PortId || location}-${row['Date of Issue'] || ''}`,
    disasterType: normalizeDisasterType(warning),
    warningType: 'Port warning',
    locationName: location,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    severity: /cyclone|storm|warning/i.test(warning) ? 'high' : 'medium',
    description: `IMD port warning for ${location}: ${warning}`,
    issuedAt: row['Date of Issue'] || row.Date || null,
    raw: row
  };
}

function normalizeCurrentWx(row) {
  const rain = Number(row['Last 24 hrs Rainfall'] || row.Rainfall || 0);
  if (!Number.isFinite(rain) || rain < 50) return null;
  const location = row.Station || row.station || 'Unknown station';
  const coords = geocodePlace(location);
  return {
    source: 'IMD',
    sourceType: 'WEATHER_OBSERVATION',
    externalId: `imd-wx-${row['Station Id'] || location}-${row['Date of Observation'] || ''}`,
    disasterType: 'flood',
    warningType: 'Heavy rainfall observation',
    locationName: location,
    latitude: coords?.latitude ?? row.Latitude ?? null,
    longitude: coords?.longitude ?? row.Longitude ?? null,
    severity: rain >= 150 ? 'high' : 'medium',
    description: `IMD current weather: ${rain} mm rainfall at ${location}`,
    observedAt: row['Date of Observation'] || null,
    raw: row
  };
}

async function fetchImdAlerts() {
  if (!hasImdCredentials()) {
    return {
      configured: false,
      live: false,
      error: 'IMD API credentials are not configured. Register at https://api.imd.gov.in/ and set IMD_API_TOKEN or IMD_API_KEY.',
      alerts: [],
      endpoints: []
    };
  }

  const endpoints = [
    { path: '/api/v1/districtwarning', sourceType: 'IMD_WARNING', normalize: normalizeDistrictWarning },
    { path: '/api/v1/districtnowcast', sourceType: 'NOWCAST', normalize: normalizeNowcast },
    { path: '/api/v1/districtrainfall', sourceType: 'RAINFALL', normalize: normalizeRainfall },
    { path: '/api/v1/portwarning', sourceType: 'PORT_WARNING', normalize: normalizePortWarning },
    { path: '/api/v1/current_wx', sourceType: 'WEATHER_OBSERVATION', normalize: normalizeCurrentWx }
  ];

  const alerts = [];
  const results = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetchImd(endpoint.path);
      results.push({
        path: endpoint.path,
        status: response.status,
        ok: response.ok
      });
      if (!response.ok) {
        continue;
      }
      for (const row of asArray(response.json)) {
        const normalized = endpoint.normalize(row);
        if (normalized) alerts.push(normalized);
      }
    } catch (error) {
      results.push({
        path: endpoint.path,
        ok: false,
        error: error.message
      });
    }
  }

  const anyOk = results.some((r) => r.ok);
  const firstError = results.find((r) => !r.ok);
  return {
    configured: true,
    live: anyOk,
    error: anyOk
      ? null
      : firstError
        ? `IMD request failed (${firstError.status || firstError.error}). JWT/API key may be invalid, pending approval, or IP-restricted.`
        : 'IMD returned no usable data',
    alerts,
    endpoints: results
  };
}

module.exports = {
  hasImdCredentials,
  fetchImdAlerts,
  IMD_WARNING_CODES
};
