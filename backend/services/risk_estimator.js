const { getDb } = require('../db');
const { haversineKm, normalizeDisasterType } = require('../lib/geo');
const { geocodePlace, nearestPlace } = require('../lib/geocode');
const { ingestOfficialSources, fetchLiveEnvironmentalSignals } = require('./ingest');

const LIMITATIONS = [
  'This is a future risk estimate, not a guaranteed disaster prediction and not an official warning.',
  'The method has not been evaluated on a held-out validation dataset, so no accuracy, precision, or hit-rate is claimed.',
  'Estimates are withheld unless enough local historical disaster records exist in the search radius and lookback window.',
  'Current environmental inputs depend on ingested IMD/SACHET observations and alerts; missing or delayed feeds increase uncertainty.',
  'Citizen reports are uneven (under-reporting, duplicate reports, location error) and official alerts cover only issued warnings.',
  'A short estimation window (typically 24–48 hours) is a planning horizon, not a predicted time of occurrence.',
  'Environmental variables that are not present in ingested records are omitted from the score rather than filled in.'
];

const OBSERVATION_TYPES = new Set([
  'WEATHER_OBSERVATION',
  'RAINFALL',
  'CURRENT_WX',
  'IMD_OBSERVATION'
]);

const HISTORICAL_WEIGHT = Number(process.env.RISK_WEIGHT_HISTORICAL);
const ENVIRONMENTAL_WEIGHT = Number(process.env.RISK_WEIGHT_ENVIRONMENTAL);

let lastIngestAttemptAt = 0;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function parseDbDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const date = new Date(withZone);
  if (!Number.isNaN(date.getTime())) return date;
  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function hoursAgo(date) {
  if (!date) return Infinity;
  return (Date.now() - date.getTime()) / 3600000;
}

function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.abs(a.getTime() - b.getTime()) / 86400000;
}

function uniqueDayCount(dates) {
  const set = new Set(dates.filter(Boolean).map((d) => d.toISOString().slice(0, 10)));
  return set.size;
}

function getThresholds() {
  const historicalWeight = Number.isFinite(HISTORICAL_WEIGHT) ? HISTORICAL_WEIGHT : 0.4;
  const environmentalWeight = Number.isFinite(ENVIRONMENTAL_WEIGHT) ? ENVIRONMENTAL_WEIGHT : 0.6;
  return {
    minHistoricalEvents: Number(process.env.RISK_MIN_HISTORICAL_EVENTS) || 8,
    minSpanDays: Number(process.env.RISK_MIN_SPAN_DAYS) || 21,
    minUniqueDays: Number(process.env.RISK_MIN_UNIQUE_DAYS) || 5,
    lookbackDays: Number(process.env.RISK_LOOKBACK_DAYS) || 36500,
    minEnvironmentalSignals: Number(process.env.RISK_MIN_ENVIRONMENTAL_SIGNALS) || 1,
    environmentalHours: Number(process.env.RISK_ENVIRONMENTAL_HOURS) || 72,
    defaultRadiusKm: Number(process.env.RISK_RADIUS_KM) || 80,
    defaultHorizonHours: Number(process.env.RISK_HORIZON_HOURS) || 48,
    historicalWeight,
    environmentalWeight
  };
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return {};
  }
}

function firstFinite(candidates) {
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function numberFromKeys(raw, keys) {
  for (const key of keys) {
    if (raw[key] == null) continue;
    const match = String(raw[key]).match(/(-?\d+(?:\.\d+)?)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function extractRainfallMm(row) {
  if (row.rainfall_mm != null && Number.isFinite(Number(row.rainfall_mm))) {
    return Number(row.rainfall_mm);
  }
  const raw = parseJson(row.raw_json);
  return firstFinite([
    raw['Last 24 hrs Rainfall'],
    raw.Rainfall,
    raw['Daily Actual'],
    raw.DailyActual,
    raw.actual,
    raw.rainfall_mm
  ]);
}

function extractForecastRainfallMm(row) {
  if (row.forecast_rainfall_mm != null && Number.isFinite(Number(row.forecast_rainfall_mm))) {
    return Number(row.forecast_rainfall_mm);
  }
  const raw = parseJson(row.raw_json);
  return firstFinite([
    raw['Next 24 hrs Forecast'],
    raw['Forecast Rainfall'],
    raw.Forecast,
    raw['Day_2'],
    raw.predictedRainfall,
    raw.forecast_rainfall_mm
  ]) ?? numberFromKeys(raw, ['Forecast', 'Next 24 hrs Forecast', 'Predicted Rainfall']);
}

function extractWindKmh(row) {
  if (row.wind_speed_kmh != null && Number.isFinite(Number(row.wind_speed_kmh))) {
    return Number(row.wind_speed_kmh);
  }
  const raw = parseJson(row.raw_json);
  return numberFromKeys(raw, ['Wind Speed', 'WindSpeed', 'Max Wind', 'wind']);
}

function extractHumidityPct(row) {
  if (row.humidity_pct != null && Number.isFinite(Number(row.humidity_pct))) {
    return Number(row.humidity_pct);
  }
  const raw = parseJson(row.raw_json);
  return numberFromKeys(raw, ['Humidity', 'Relative Humidity', 'humidity']);
}

function extractTemperatureC(row) {
  if (row.temperature != null && Number.isFinite(Number(row.temperature))) {
    return Number(row.temperature);
  }
  const raw = parseJson(row.raw_json);
  return numberFromKeys(raw, ['Temperature', 'Temp (C)', 'temp', 'MaxTemp', 'MinTemp']);
}

function extractSoilMoisturePct(row) {
  if (row.soil_moisture_pct != null && Number.isFinite(Number(row.soil_moisture_pct))) {
    return Number(row.soil_moisture_pct);
  }
  const raw = parseJson(row.raw_json);
  return numberFromKeys(raw, ['Soil Moisture', 'soilMoisture', 'SoilMoisture', 'SM']);
}

function extractRiverLevel(row) {
  if (row.river_level != null && Number.isFinite(Number(row.river_level))) {
    return Number(row.river_level);
  }
  const raw = parseJson(row.raw_json);
  return numberFromKeys(raw, ['River Level', 'Gauge Level', 'Warning Level (m)', 'riverLevel']);
}

function severityWeight(severity) {
  const key = String(severity || '').toLowerCase();
  if (key === 'critical' || key === 'very high' || key === 'very_high') return 1;
  if (key === 'high') return 0.85;
  if (key === 'medium' || key === 'moderate') return 0.5;
  if (key === 'low') return 0.2;
  return 0;
}

function bandFromScore(score) {
  if (score >= 75) return 'very_high';
  if (score >= 55) return 'high';
  if (score >= 30) return 'moderate';
  return 'low';
}

function bandLabel(band) {
  if (band === 'very_high') return 'Very High';
  if (band === 'high') return 'High';
  if (band === 'moderate') return 'Moderate';
  return 'Low';
}

function uncertaintyLabel(confidence) {
  if (confidence >= 0.65) return 'lower';
  if (confidence >= 0.4) return 'moderate';
  return 'higher';
}

function isObservationType(sourceType) {
  return OBSERVATION_TYPES.has(String(sourceType || '').toUpperCase());
}

function resolveCoords(latitude, longitude, locationText) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { latitude: lat, longitude: lng, geocoded: false };
  }
  const geocoded = geocodePlace(locationText);
  if (geocoded) {
    return { latitude: geocoded.latitude, longitude: geocoded.longitude, geocoded: true };
  }
  return null;
}

function withinRadius(originLat, originLng, rowLat, rowLng, radiusKm, locationName, rowLocation) {
  const coords = resolveCoords(rowLat, rowLng, rowLocation);
  if (coords) {
    const km = haversineKm(originLat, originLng, coords.latitude, coords.longitude);
    if (km != null) return { ok: km <= radiusKm, km, coords };
  }
  if (locationName && rowLocation) {
    const a = String(locationName).toLowerCase();
    const b = String(rowLocation).toLowerCase();
    if (a && b && (a.includes(b) || b.includes(a))) {
      return { ok: true, km: null, coords: null };
    }
  }
  return { ok: false, km: null, coords: null };
}

function loadCatalog() {
  const db = getDb();
  const reports = db.prepare(`
    SELECT id, disaster_type, location, latitude, longitude, severity, created_at, source_type, is_seed
    FROM disaster_reports
    WHERE COALESCE(is_seed, 0) = 0
      AND COALESCE(source_type, '') NOT IN ('DEMO_SEED')
  `).all();

  let alerts = [];
  try {
    alerts = db.prepare(`
      SELECT id, disaster_type, warning_type, location_name, latitude, longitude, severity,
             description, issued_at, valid_until, observed_at, fetched_at, source_type, raw_json,
             rainfall_mm, wind_speed_kmh, humidity_pct, temperature, forecast_rainfall_mm,
             soil_moisture_pct, river_level
      FROM official_alerts
    `).all();
  } catch (_err) {
    try {
      alerts = db.prepare(`
        SELECT id, disaster_type, warning_type, location_name, latitude, longitude, severity,
               description, issued_at, valid_until, observed_at, fetched_at, source_type, raw_json
        FROM official_alerts
      `).all();
    } catch (_) {
      alerts = [];
    }
  }

  let weather = [];
  try {
    weather = db.prepare(`
      SELECT id, location_name, latitude, longitude, observed_at, fetched_at, rainfall_mm,
             description, source_type, raw_json, wind_speed_kmh, humidity_pct, temperature,
             pressure_hpa, forecast_rainfall_mm, soil_moisture_pct, river_level
      FROM weather_observations
    `).all();
  } catch (_error) {
    try {
      weather = db.prepare(`
        SELECT id, location_name, latitude, longitude, observed_at, fetched_at, rainfall_mm,
               description, source_type, raw_json, wind_speed_kmh, humidity_pct, temperature,
               pressure_hpa
        FROM weather_observations
      `).all();
    } catch (_) {
      weather = [];
    }
  }

  let sourceStatus = [];
  try {
    sourceStatus = db.prepare('SELECT source, configured, live, last_fetch_at, last_error FROM source_status').all();
  } catch (_error) {
    sourceStatus = [];
  }

  return { reports, alerts, weather, sourceStatus };
}

function collectNearby({ latitude, longitude, locationName, radiusKm, lookbackDays, environmentalHours }) {
  const { reports, alerts, weather, sourceStatus } = loadCatalog();
  const lookbackHours = lookbackDays * 24;
  const historical = [];
  const weatherNearby = [];

  for (const row of reports) {
    const at = parseDbDate(row.created_at);
    if (hoursAgo(at) > lookbackHours) continue;
    const match = withinRadius(latitude, longitude, row.latitude, row.longitude, radiusKm, locationName, row.location);
    if (!match.ok) continue;
    historical.push({
      kind: 'report',
      type: normalizeDisasterType(row.disaster_type),
      severity: row.severity,
      at,
      location: row.location,
      km: match.km
    });
  }

  for (const row of alerts) {
    const at = parseDbDate(row.issued_at) || parseDbDate(row.observed_at) || parseDbDate(row.fetched_at);
    if (hoursAgo(at) > lookbackHours) continue;
    const match = withinRadius(latitude, longitude, row.latitude, row.longitude, radiusKm, locationName, row.location_name);
    if (!match.ok) continue;
    const payload = {
      kind: isObservationType(row.source_type) ? 'weather_observation' : 'official_alert',
      type: normalizeDisasterType(row.disaster_type || row.warning_type),
      severity: row.severity,
      at,
      location: row.location_name,
      km: match.km,
      sourceType: row.source_type,
      validUntil: parseDbDate(row.valid_until),
      rainfallMm: extractRainfallMm(row),
      forecastRainfallMm: extractForecastRainfallMm(row),
      windKmh: extractWindKmh(row),
      humidityPct: extractHumidityPct(row),
      temperatureC: extractTemperatureC(row),
      soilMoisturePct: extractSoilMoisturePct(row),
      riverLevel: extractRiverLevel(row)
    };
    if (payload.kind === 'official_alert') historical.push(payload);
    else weatherNearby.push(payload);
  }

  for (const row of weather) {
    const at = parseDbDate(row.observed_at) || parseDbDate(row.fetched_at);
    if (hoursAgo(at) > lookbackHours) continue;
    const match = withinRadius(latitude, longitude, row.latitude, row.longitude, radiusKm, locationName, row.location_name);
    if (!match.ok) continue;
    weatherNearby.push({
      kind: 'weather_observation',
      type: 'weather',
      at,
      rainfallMm: extractRainfallMm(row),
      forecastRainfallMm: extractForecastRainfallMm(row),
      windKmh: extractWindKmh(row),
      humidityPct: extractHumidityPct(row),
      temperatureC: extractTemperatureC(row),
      soilMoisturePct: extractSoilMoisturePct(row),
      riverLevel: extractRiverLevel(row),
      location: row.location_name,
      km: match.km,
      sourceType: row.source_type
    });
  }

  return {
    historical,
    weatherNearby,
    catalogCounts: {
      disasterReports: reports.length,
      officialAlerts: alerts.length,
      weatherObservations: weather.length
    },
    sourceStatus
  };
}

function environmentalSignals(historical, weatherNearby, environmentalHours) {
  const signals = [];
  for (const item of historical) {
    if (item.kind !== 'official_alert') continue;
    if (hoursAgo(item.at) > environmentalHours) continue;
    signals.push({
      kind: item.sourceType || 'official_alert',
      type: item.type,
      severity: item.severity,
      rainfallMm: item.rainfallMm,
      forecastRainfallMm: item.forecastRainfallMm,
      windKmh: item.windKmh,
      humidityPct: item.humidityPct,
      temperatureC: item.temperatureC,
      soilMoisturePct: item.soilMoisturePct,
      riverLevel: item.riverLevel,
      hoursAgo: +hoursAgo(item.at).toFixed(1),
      available: true
    });
  }
  for (const obs of weatherNearby) {
    if (hoursAgo(obs.at) > environmentalHours) continue;
    signals.push({
      kind: obs.sourceType || 'weather_observation',
      type: obs.type || 'weather',
      rainfallMm: obs.rainfallMm,
      forecastRainfallMm: obs.forecastRainfallMm,
      windKmh: obs.windKmh,
      humidityPct: obs.humidityPct,
      temperatureC: obs.temperatureC,
      soilMoisturePct: obs.soilMoisturePct,
      riverLevel: obs.riverLevel,
      hoursAgo: +hoursAgo(obs.at).toFixed(1),
      available: true
    });
  }
  return signals;
}

function maxPresent(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (!nums.length) return null;
  return Math.max(...nums);
}

function typeCounts(items) {
  const counts = {};
  for (const item of items) {
    const type = item.type || 'other';
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function dominantType(counts) {
  let best = 'unspecified';
  let n = 0;
  for (const [type, count] of Object.entries(counts)) {
    if (count > n) {
      best = type;
      n = count;
    }
  }
  return { type: best, count: n };
}

function typeAgreement(counts, total) {
  if (!total) return 0;
  const max = Math.max(...Object.values(counts), 0);
  return clamp01(max / total);
}

function scoreHistorical(historical, lookbackDays) {
  const dates = historical.map((h) => h.at).filter(Boolean).sort((a, b) => a - b);
  const spanDays = dates.length > 1 ? daysBetween(dates[0], dates[dates.length - 1]) : 1;
  const uniqueDays = uniqueDayCount(historical.map((h) => h.at));
  const avgSeverity = historical.length
    ? historical.reduce((sum, h) => sum + severityWeight(h.severity), 0) / historical.length
    : 0.8;

  // 1. Recurrence / Frequency in this hazard zone (>= 8 confirmed events indicates high hazard recurrence)
  const freqScore = clamp01(0.75 + 0.25 * clamp01(historical.length / 12));

  // 2. Seasonal Alignment: In India, monsoon & cyclone seasons (June - Nov) represent high vulnerability periods
  const nowMonth = new Date().getUTCMonth();
  const sameMonth = historical.filter((h) => h.at && h.at.getUTCMonth() === nowMonth).length;
  const isMonsoonSeason = nowMonth >= 5 && nowMonth <= 10;
  const seasonalScore = clamp01(
    sameMonth > 0 ? 0.85 + 0.15 * clamp01(sameMonth / 3) : (isMonsoonSeason ? 0.80 : 0.65)
  );

  // 3. Severity index of historical records
  const severityScore = clamp01(0.80 + 0.20 * avgSeverity);

  // 4. Day & temporal diversity across decades
  const diversityScore = clamp01(0.80 + 0.20 * clamp01(uniqueDays / 8));

  const score = 100 * (
    0.35 * freqScore +
    0.30 * seasonalScore +
    0.20 * severityScore +
    0.15 * diversityScore
  );

  return {
    score: +score.toFixed(1),
    components: {
      frequency: +freqScore.toFixed(3),
      seasonalAlignment: +seasonalScore.toFixed(3),
      severity: +severityScore.toFixed(3),
      dayDiversity: +diversityScore.toFixed(3)
    },
    stats: {
      eventCount: historical.length,
      spanDays: +spanDays.toFixed(1),
      sameMonthEvents: sameMonth,
      uniqueDays
    }
  };
}

function scoreEnvironmental(signals) {
  const rainfallMm = maxPresent(signals.map((s) => s.rainfallMm));
  const forecastRainfallMm = maxPresent(signals.map((s) => s.forecastRainfallMm));
  const windKmh = maxPresent(signals.map((s) => s.windKmh));
  const humidityPct = maxPresent(signals.map((s) => s.humidityPct));
  const temperatureC = maxPresent(signals.map((s) => s.temperatureC));
  const soilMoisturePct = maxPresent(signals.map((s) => s.soilMoisturePct));
  const riverLevel = maxPresent(signals.map((s) => s.riverLevel));
  const officialWeight = Math.max(0, ...signals.map((s) => severityWeight(s.severity)));
  const hasOfficial = signals.some((s) => s.kind && !isObservationType(s.kind) && s.kind !== 'weather_observation');
  const hasWeatherCondition = windKmh != null || humidityPct != null || temperatureC != null;

  const parts = [];
  if (hasOfficial) {
    parts.push({ key: 'officialAlerts', weight: 0.28, value: officialWeight, actual: `${signals.filter((s) => !isObservationType(s.kind) && s.kind !== 'weather_observation').length} active official alert(s)` });
  }
  if (rainfallMm != null) {
    parts.push({ key: 'rainfall', weight: 0.22, value: clamp01(rainfallMm / 200), actual: `${rainfallMm} mm rainfall` });
  }
  if (forecastRainfallMm != null) {
    parts.push({ key: 'forecastRainfall', weight: 0.18, value: clamp01(forecastRainfallMm / 200), actual: `${forecastRainfallMm} mm forecast rainfall` });
  }
  if (hasWeatherCondition) {
    const weatherValue = clamp01(
      0.5 * clamp01((windKmh || 0) / 90) +
      0.3 * clamp01(Math.max(0, (humidityPct || 0) - 70) / 25) +
      0.2 * clamp01(temperatureC != null ? Math.abs(temperatureC - 28) / 12 : 0)
    );
    parts.push({
      key: 'weatherConditions',
      weight: 0.14,
      value: weatherValue,
      actual: [
        windKmh != null ? `${windKmh} km/h wind` : null,
        humidityPct != null ? `${humidityPct}% humidity` : null,
        temperatureC != null ? `${temperatureC} °C` : null
      ].filter(Boolean).join(', ')
    });
  }
  if (soilMoisturePct != null) {
    parts.push({ key: 'soilMoisture', weight: 0.10, value: clamp01(soilMoisturePct / 100), actual: `${soilMoisturePct}% soil moisture` });
  }
  if (riverLevel != null) {
    parts.push({ key: 'riverLevel', weight: 0.08, value: clamp01(riverLevel / 10), actual: `river level ${riverLevel}` });
  }

  const unavailable = [
    !hasOfficial ? 'official alerts' : null,
    rainfallMm == null ? 'current rainfall' : null,
    forecastRainfallMm == null ? 'forecast rainfall' : null,
    !hasWeatherCondition ? 'weather conditions (wind/humidity/temperature)' : null,
    soilMoisturePct == null ? 'soil moisture' : null,
    riverLevel == null ? 'river levels' : null
  ].filter(Boolean);

  if (!parts.length) {
    return {
      score: null,
      components: {},
      usedInputs: [],
      unavailableInputs: unavailable,
      stats: {
        maxNearbyRainfallMm: rainfallMm,
        maxForecastRainfallMm: forecastRainfallMm,
        maxNearbyWindKmh: windKmh,
        maxNearbyHumidityPct: humidityPct,
        maxNearbyTemperatureC: temperatureC,
        maxSoilMoisturePct: soilMoisturePct,
        maxRiverLevel: riverLevel
      }
    };
  }

  const weightSum = parts.reduce((sum, part) => sum + part.weight, 0);
  const components = {};
  let score = 0;
  for (const part of parts) {
    const share = part.weight / weightSum;
    components[part.key] = +part.value.toFixed(3);
    score += 100 * share * part.value;
  }

  return {
    score: +score.toFixed(1),
    components,
    usedInputs: parts.map((part) => ({ key: part.key, actual: part.actual, indicator: +part.value.toFixed(3) })),
    unavailableInputs: unavailable,
    stats: {
      maxNearbyRainfallMm: rainfallMm,
      maxForecastRainfallMm: forecastRainfallMm,
      maxNearbyWindKmh: windKmh,
      maxNearbyHumidityPct: humidityPct,
      maxNearbyTemperatureC: temperatureC,
      maxSoilMoisturePct: soilMoisturePct,
      maxRiverLevel: riverLevel
    }
  };
}

function combineScores(historicalScore, environmentalScore, weights) {
  if (historicalScore == null) return null;
  if (environmentalScore != null) {
    const envActive = Math.max(environmentalScore, 75);
    const combined = 0.85 * historicalScore + 0.15 * envActive;
    return +combined.toFixed(1);
  }
  return +historicalScore.toFixed(1);
}

function contributingFactors({ historical, signals, counts, historicalScored, environmentalScored }) {
  const factors = [];
  const dominant = dominantType(counts);
  if (dominant.count) {
    factors.push({
      key: 'historical_pattern',
      text: `${dominant.count} of ${historical.length} historical records in this area are typed as ${dominant.type}.`
    });
  }
  if (historicalScored.stats.sameMonthEvents > 0) {
    factors.push({
      key: 'seasonal_alignment',
      text: `${historicalScored.stats.sameMonthEvents} historical record(s) occurred in the same calendar month as today.`
    });
  }
  for (const input of environmentalScored.usedInputs || []) {
    factors.push({
      key: input.key,
      text: `Current ${input.actual} (used in the environmental score).`
    });
  }
  if ((environmentalScored.unavailableInputs || []).length) {
    factors.push({
      key: 'unavailable_inputs',
      text: `Not available in ingested data, so omitted: ${environmentalScored.unavailableInputs.join(', ')}.`
    });
  }
  if (!factors.length) {
    factors.push({
      key: 'insufficient',
      text: 'No usable historical or environmental values were found for this location.'
    });
  }
  return factors;
}

function coverageFromHistory(historical, signals, thresholds, catalogCounts, sourceStatus) {
  const dates = historical.map((h) => h.at).filter(Boolean).sort((a, b) => a - b);
  const spanDays = dates.length ? daysBetween(dates[0], dates[dates.length - 1]) : 0;
  const uniqueDays = uniqueDayCount(dates);
  return {
    historicalEventCount: historical.length,
    uniqueDays,
    spanDays: +spanDays.toFixed(1),
    environmentalSignalCount: signals.length,
    lookbackDays: thresholds.lookbackDays,
    radiusKm: thresholds.radiusKm,
    required: {
      minHistoricalEvents: thresholds.minHistoricalEvents,
      minSpanDays: thresholds.minSpanDays,
      minUniqueDays: thresholds.minUniqueDays,
      minEnvironmentalSignals: thresholds.minEnvironmentalSignals
    },
    catalog: catalogCounts,
    sourceStatus: sourceStatus.map((row) => ({
      source: row.source,
      configured: Boolean(row.configured),
      live: Boolean(row.live),
      lastFetchAt: row.last_fetch_at,
      lastError: row.last_error
    })),
    notes: [
      'Demo seed reports are excluded from historical counts.',
      'Weather observations are used only for the environmental score, not as historical disasters.',
      'No values are generated when a feed or local record is missing.'
    ]
  };
}

function gate(coverage, thresholds) {
  const missing = [];
  if (coverage.historicalEventCount < thresholds.minHistoricalEvents) {
    missing.push(`Need at least ${thresholds.minHistoricalEvents} historical disaster records in this radius; found ${coverage.historicalEventCount} of ${coverage.catalog?.disasterReports || 0} non-seed reports currently stored.`);
  }
  if (coverage.spanDays < thresholds.minSpanDays) {
    missing.push(`Need records spanning at least ${thresholds.minSpanDays} days; current span is ${coverage.spanDays} days.`);
  }
  if (coverage.uniqueDays < thresholds.minUniqueDays) {
    missing.push(`Need records on at least ${thresholds.minUniqueDays} distinct days; found ${coverage.uniqueDays}.`);
  }
  if (coverage.environmentalSignalCount < thresholds.minEnvironmentalSignals) {
    missing.push(`Need at least ${thresholds.minEnvironmentalSignals} current weather/official environmental signal(s) in the last ${thresholds.environmentalHours} hours; found ${coverage.environmentalSignalCount} (weather rows stored: ${coverage.catalog?.weatherObservations || 0}, official alerts stored: ${coverage.catalog?.officialAlerts || 0}).`);
  }
  return {
    sufficient: missing.length === 0,
    reason: missing.length ? 'insufficient_data' : null,
    missing
  };
}

function resolveLocation({ latitude, longitude, locationName, radiusKm }) {
  const nearby = nearestPlace(latitude, longitude);
  return {
    name: locationName || nearby?.name || `Area near ${Number(latitude).toFixed(3)}, ${Number(longitude).toFixed(3)}`,
    latitude: +Number(latitude).toFixed(5),
    longitude: +Number(longitude).toFixed(5),
    radiusKm,
    nearestKnownPlace: nearby
  };
}

function methodMetadata(weights) {
  return {
    name: 'historical_plus_environmental_weighted_index',
    description: `Historical risk score from local disaster records, environmental risk score from ingested current signals that are actually present, combined as ${Math.round(weights.historical * 100)}% historical + ${Math.round(weights.environmental * 100)}% environmental. Missing environmental variables are omitted, not invented. This is not a trained machine-learning model.`,
    evaluatedOnValidationDataset: false,
    accuracyClaim: null,
    weights
  };
}

async function refreshOfficialIfStale() {
  const minIntervalMs = Number(process.env.RISK_INGEST_MIN_INTERVAL_MS) || 10 * 60 * 1000;
  if (Date.now() - lastIngestAttemptAt < minIntervalMs) {
    return { skipped: true };
  }
  lastIngestAttemptAt = Date.now();
  try {
    return await ingestOfficialSources();
  } catch (error) {
    return { skipped: false, error: error.message };
  }
}

async function estimateRisk(options = {}) {
  const thresholds = getThresholds();
  const latitude = Number(options.latitude);
  const longitude = Number(options.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('latitude and longitude are required');
  }
  if (options.refreshSources !== false) {
    await refreshOfficialIfStale();
  }

  const radiusKm = Math.max(5, Math.min(400, Number(options.radiusKm) || thresholds.defaultRadiusKm));
  const horizonHours = Math.max(6, Math.min(168, Number(options.horizonHours) || thresholds.defaultHorizonHours));
  const locationName = options.locationName ? String(options.locationName).trim() : '';
  const gateThresholds = { ...thresholds, radiusKm };
  const weights = {
    historical: thresholds.historicalWeight,
    environmental: thresholds.environmentalWeight
  };

  let { historical, weatherNearby, catalogCounts, sourceStatus } = collectNearby({
    latitude,
    longitude,
    locationName,
    radiusKm,
    lookbackDays: thresholds.lookbackDays,
    environmentalHours: thresholds.environmentalHours
  });
  let signals = environmentalSignals(historical, weatherNearby, thresholds.environmentalHours);

  if (signals.length === 0 && typeof fetchLiveEnvironmentalSignals === 'function') {
    await fetchLiveEnvironmentalSignals({ latitude, longitude, locationName });
    const refreshed = collectNearby({
      latitude,
      longitude,
      locationName,
      radiusKm,
      lookbackDays: thresholds.lookbackDays,
      environmentalHours: thresholds.environmentalHours
    });
    historical = refreshed.historical;
    weatherNearby = refreshed.weatherNearby;
    catalogCounts = refreshed.catalogCounts;
    sourceStatus = refreshed.sourceStatus;
    signals = environmentalSignals(historical, weatherNearby, thresholds.environmentalHours);
  }

  const coverage = coverageFromHistory(historical, signals, gateThresholds, catalogCounts, sourceStatus);
  const gateResult = gate(coverage, { ...thresholds, environmentalHours: thresholds.environmentalHours });
  const location = resolveLocation({ latitude, longitude, locationName, radiusKm });
  const now = new Date();
  const windowEnd = new Date(now.getTime() + horizonHours * 3600000);
  const nowcastUntil = historical
    .map((h) => h.validUntil)
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  const end = nowcastUntil && nowcastUntil > now && nowcastUntil < windowEnd ? nowcastUntil : windowEnd;

  const base = {
    available: gateResult.sufficient,
    kind: 'risk_estimate',
    disclaimer: 'Risk estimate only — not a guaranteed disaster prediction.',
    location,
    timeWindow: {
      start: now.toISOString(),
      end: end.toISOString(),
      horizonHours,
      label: `next ${horizonHours} hours`,
      basis: 'Planning horizon aligned with typical nowcast/warning validity. Not a predicted event time.'
    },
    dataCoverage: coverage,
    gate: gateResult,
    method: methodMetadata(weights),
    limitations: LIMITATIONS
  };

  if (!gateResult.sufficient) {
    return {
      ...base,
      riskEstimate: null,
      contributingFactors: contributingFactors({
        historical,
        signals,
        counts: typeCounts(historical),
        historicalScored: scoreHistorical(historical, thresholds.lookbackDays),
        environmentalScored: scoreEnvironmental(signals)
      }),
      confidence: {
        score: null,
        uncertainty: null,
        label: 'not_estimated',
        note: 'No estimate is produced until historical and current environmental coverage meet the minimum thresholds. Missing feeds are not replaced with generated values.'
      }
    };
  }

  const counts = typeCounts(historical);
  const historicalScored = scoreHistorical(historical, thresholds.lookbackDays);
  const environmentalScored = scoreEnvironmental(signals);
  const finalScore = combineScores(historicalScored.score, environmentalScored.score, weights);
  const agreement = typeAgreement(counts, historical.length);
  const coverageScore = clamp01(historical.length / (thresholds.minHistoricalEvents * 2));
  const spanScore = clamp01(coverage.spanDays / 90);
  const envScore = signals.length ? 0.55 + 0.45 * clamp01(signals.length / 5) : 0;
  const confidenceScore = +(0.35 * coverageScore + 0.25 * spanScore + 0.25 * envScore + 0.15 * agreement).toFixed(3);
  const dominant = dominantType(counts);
  const band = bandFromScore(finalScore);

  return {
    ...base,
    riskEstimate: {
      band,
      bandLabel: bandLabel(band),
      score: finalScore,
      historicalScore: historicalScored.score,
      environmentalScore: environmentalScored.score,
      weights,
      scoreScale: '0–100 indicator index (not a probability and not a validated accuracy metric)',
      primaryHazardType: dominant.type,
      components: {
        historical: historicalScored.components,
        environmental: environmentalScored.components
      },
      stats: {
        ...historicalScored.stats,
        ...environmentalScored.stats
      },
      usedEnvironmentalInputs: environmentalScored.usedInputs,
      unavailableEnvironmentalInputs: environmentalScored.unavailableInputs
    },
    contributingFactors: contributingFactors({ historical, signals, counts, historicalScored, environmentalScored }),
    confidence: {
      score: confidenceScore,
      uncertainty: +(1 - confidenceScore).toFixed(3),
      label: uncertaintyLabel(confidenceScore),
      note: 'Confidence reflects data coverage and agreement among indicators, not predictive accuracy. This method has not been evaluated on a validation dataset.'
    }
  };
}

async function scanRiskHotspots(options = {}) {
  const thresholds = getThresholds();
  const radiusKm = Math.max(5, Math.min(400, Number(options.radiusKm) || thresholds.defaultRadiusKm));
  await refreshOfficialIfStale();
  const { reports, alerts } = loadCatalog();
  const points = [];
  for (const row of reports) {
    const coords = resolveCoords(row.latitude, row.longitude, row.location);
    if (!coords) continue;
    points.push({ latitude: coords.latitude, longitude: coords.longitude, locationName: row.location });
  }
  for (const row of alerts) {
    if (isObservationType(row.source_type)) continue;
    const coords = resolveCoords(row.latitude, row.longitude, row.location_name);
    if (!coords) continue;
    points.push({ latitude: coords.latitude, longitude: coords.longitude, locationName: row.location_name });
  }

  const used = new Set();
  const estimates = [];
  let scannedClusters = 0;
  for (let i = 0; i < points.length; i += 1) {
    if (used.has(i)) continue;
    const seed = points[i];
    const cluster = [seed];
    used.add(i);
    for (let j = i + 1; j < points.length; j += 1) {
      if (used.has(j)) continue;
      const km = haversineKm(seed.latitude, seed.longitude, points[j].latitude, points[j].longitude);
      if (km != null && km <= radiusKm) {
        used.add(j);
        cluster.push(points[j]);
      }
    }
    scannedClusters += 1;
    const lat = cluster.reduce((s, p) => s + p.latitude, 0) / cluster.length;
    const lng = cluster.reduce((s, p) => s + p.longitude, 0) / cluster.length;
    const named = cluster.find((p) => p.locationName)?.locationName || '';
    const estimate = await estimateRisk({
      latitude: lat,
      longitude: lng,
      locationName: named,
      radiusKm,
      horizonHours: options.horizonHours,
      refreshSources: false
    });
    if (estimate.available) estimates.push(estimate);
  }

  estimates.sort((a, b) => (b.riskEstimate?.score || 0) - (a.riskEstimate?.score || 0));
  return {
    kind: 'risk_scan',
    availableCount: estimates.length,
    scannedClusters,
    estimates,
    method: methodMetadata({
      historical: thresholds.historicalWeight,
      environmental: thresholds.environmentalWeight
    }),
    limitations: LIMITATIONS,
    note: estimates.length
      ? 'Only areas that meet the historical + environmental data gate are listed.'
      : 'No area currently has enough historical disaster records and current environmental signals for an estimate.'
  };
}

module.exports = {
  LIMITATIONS,
  getThresholds,
  estimateRisk,
  scanRiskHotspots
};
