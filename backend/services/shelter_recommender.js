const { getDb } = require('../db');
const { haversineKm, normalizeDisasterType } = require('../lib/geo');
const { v4: uuidv4 } = require('uuid');

const STATUS_SCORE = {
  open: 1.0,
  evacuating: 0.3,
  full: 0.05,
  closed: 0.0
};

const RISK_PENALTY = {
  low: 1.0,
  medium: 0.65,
  high: 0.25,
  critical: 0.0
};

const ROAD_ACCESS_BONUS = {
  open: 1.0,
  restricted: 0.55,
  unknown: 0.35,
  blocked: 0.0
};

const WEIGHTS = {
  status: 0.22,
  capacity: 0.18,
  risk: 0.20,
  roads: 0.15,
  distance: 0.15,
  hazard: 0.10
};

function calcDistanceScore(distanceKm, maxSearchKm) {
  if (distanceKm == null) return 0.2;
  const d = Math.max(0, Number(distanceKm));
  const cap = Math.max(1, Number(maxSearchKm) || 100);
  const ratio = Math.min(1, d / cap);
  return Math.max(0.02, 1 - ratio * ratio);
}

function calcCapacityScore(shelter) {
  const total = Math.max(1, Number(shelter.total_capacity) || 0);
  const occupied = Math.max(0, Number(shelter.current_occupancy) || 0);
  if (total <= 0) return 0.05;
  const occupancy = occupied / total;
  const remaining = 1 - occupancy;
  if (occupancy >= 1) return 0.05;
  if (occupancy >= 0.9) return Math.min(1, Math.max(0.05, 0.2 + remaining * 0.8));
  if (occupancy >= 0.7) return Math.min(1, Math.max(0.05, 0.5 + remaining * 0.8));
  return Math.min(1, Math.max(0.05, 0.7 + remaining * 0.3));
}

function calcNearbyHazardPenalty(shelter, activeHazards, radiusKm = 20) {
  if (!Array.isArray(activeHazards) || activeHazards.length === 0) return 1.0;
  let worst = 1.0;
  let nearbyCount = 0;
  let weighted = 0;
  for (const h of activeHazards) {
    if (!h || h.latitude == null || h.longitude == null) continue;
    const d = haversineKm(shelter.latitude, shelter.longitude, h.latitude, h.longitude);
    if (d == null) continue;
    if (d > radiusKm) continue;
    nearbyCount++;
    const sevWeight = Math.max(0.2, 1 - d / radiusKm);
    const sev = (h.severity === 'high') ? 1.0 : (h.severity === 'medium') ? 0.6 : 0.3;
    const impact = sevWeight * sev;
    weighted = Math.max(weighted, impact);
  }
  if (nearbyCount === 0) return 1.0;
  const countPenalty = Math.max(0.3, 1 - nearbyCount * 0.15);
  const nearestPenalty = Math.max(0.1, 1 - weighted);
  return countPenalty * 0.6 + nearestPenalty * 0.4;
}

function buildRouteInfo(shelterLat, shelterLng, userLat, userLng, roadAccess) {
  const straight = haversineKm(userLat, userLng, shelterLat, shelterLng);
  if (straight == null) return null;
  let roadFactor = 1.2;
  if (roadAccess === 'open') roadFactor = 1.15;
  else if (roadAccess === 'restricted') roadFactor = 1.55;
  else if (roadAccess === 'unknown') roadFactor = 1.35;
  else if (roadAccess === 'blocked') roadFactor = 2.8;
  const roadKm = +(straight * roadFactor).toFixed(2);
  const speedKmh = roadAccess === 'blocked' ? 10 : roadAccess === 'restricted' ? 25 : roadAccess === 'unknown' ? 30 : 45;
  const etaMin = Math.max(1, Math.round((roadKm / speedKmh) * 60));
  return {
    straightKm: +straight.toFixed(2),
    roadKm,
    etaMinutes: etaMin,
    roadAccess,
    steps: generateRouteSteps(userLat, userLng, shelterLat, shelterLng, roadAccess),
    provider: 'DEMO_ROUTING_SAMPLE',
    note: 'Sample routing data only — for development preview, not navigation.'
  };
}

function generateRouteSteps(ulat, ulng, slat, slng, roadAccess) {
  const bearing = initialBearing(ulat, ulng, slat, slng);
  const dir = cardinalDirection(bearing);
  const steps = [];
  steps.push({
    instruction: `Head ${dir} from your current location`,
    distanceMeters: null,
    note: 'Proceed toward the nearest main road'
  });
  if (roadAccess === 'restricted') {
    steps.push({
      instruction: 'Road restrictions reported',
      distanceMeters: null,
      note: 'Some segments may have checkpoints or partial closures — expect delays.'
    });
  } else if (roadAccess === 'blocked') {
    steps.push({
      instruction: '⚠ Direct route partially blocked',
      distanceMeters: null,
      note: 'Detour required. Follow local evacuation signage or contact 112 / disaster helpline before travel.'
    });
  } else if (roadAccess === 'unknown') {
    steps.push({
      instruction: 'Road status unknown on final segment',
      distanceMeters: null,
      note: 'Listen to local radio / alerts before final approach.'
    });
  }
  steps.push({
    instruction: 'Arrive at shelter location',
    distanceMeters: null,
    note: 'Follow staff directions for check-in at reception'
  });
  return steps;
}

function initialBearing(lat1, lon1, lat2, lon2) {
  const R = Math.PI / 180;
  const phi1 = lat1 * R, phi2 = lat2 * R;
  const dLambda = (lon2 - lon1) * R;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function cardinalDirection(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(((deg % 360) / 45) % 8);
  return dirs[idx];
}

function loadActiveHazards() {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT latitude, longitude, severity, disaster_type, created_at
      FROM disaster_reports
      WHERE incident_status = 'active'
        AND is_seed = 0
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND datetime(created_at) >= datetime('now', '-72 hours')
      UNION ALL
      SELECT latitude, longitude, severity, disaster_type, issued_at AS created_at
      FROM official_alerts
      WHERE incident_status = 'active'
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND (valid_until IS NULL OR datetime(valid_until) >= datetime('now'))
    `).all();
  } catch (_) {
    return [];
  }
}

function scoreShelter(shelter, userLat, userLng, activeHazards, searchKm) {
  const distanceKm = haversineKm(userLat, userLng, shelter.latitude, shelter.longitude);
  const statusScore = STATUS_SCORE[String(shelter.status || 'closed')] ?? 0;
  const capacityScore = calcCapacityScore(shelter);
  const riskScore = RISK_PENALTY[String(shelter.risk_level || 'critical')] ?? 0;
  const roadScore = ROAD_ACCESS_BONUS[String(shelter.road_access || 'blocked')] ?? 0;
  const distanceScore = calcDistanceScore(distanceKm, searchKm);
  const hazardScore = calcNearbyHazardPenalty(shelter, activeHazards);
  const raw =
    WEIGHTS.status * statusScore +
    WEIGHTS.capacity * capacityScore +
    WEIGHTS.risk * riskScore +
    WEIGHTS.roads * roadScore +
    WEIGHTS.distance * distanceScore +
    WEIGHTS.hazard * hazardScore;
  const suitability = Math.max(0, Math.min(1, raw));
  const breakdown = {
    status: { score: statusScore, weight: WEIGHTS.status, contribution: +(WEIGHTS.status * statusScore).toFixed(3) },
    capacity: { score: capacityScore, weight: WEIGHTS.capacity, contribution: +(WEIGHTS.capacity * capacityScore).toFixed(3) },
    risk: { score: riskScore, weight: WEIGHTS.risk, contribution: +(WEIGHTS.risk * riskScore).toFixed(3) },
    roads: { score: roadScore, weight: WEIGHTS.roads, contribution: +(WEIGHTS.roads * roadScore).toFixed(3) },
    distance: { score: distanceScore, weight: WEIGHTS.distance, contribution: +(WEIGHTS.distance * distanceScore).toFixed(3) },
    hazard: { score: hazardScore, weight: WEIGHTS.hazard, contribution: +(WEIGHTS.hazard * hazardScore).toFixed(3) }
  };
  return { distanceKm, suitability, breakdown };
}

function buildExplanation(shelter, scoreResult, hazardsNearbyCount) {
  const reasons = [];
  const { breakdown, distanceKm, suitability } = scoreResult;
  if (shelter.status === 'open') reasons.push({ key: 'status_open', positive: true, text: 'Shelter is currently open and accepting evacuees.' });
  else if (shelter.status === 'evacuating') reasons.push({ key: 'status_evac', positive: false, text: 'Shelter is in evacuation status — occupants are being moved; use only if no open option exists.' });
  else if (shelter.status === 'full') reasons.push({ key: 'status_full', positive: false, text: 'Shelter reported full — check backup alternatives below.' });
  else if (shelter.status === 'closed') reasons.push({ key: 'status_closed', positive: false, text: 'Shelter marked closed; avoid unless directed.' });
  const total = Math.max(1, Number(shelter.total_capacity) || 0);
  const occ = Math.max(0, Number(shelter.current_occupancy) || 0);
  const pct = total ? Math.round(occ / total * 100) : 0;
  const avail = Math.max(0, total - occ);
  if (pct < 70) reasons.push({ key: 'cap_low', positive: true, text: `Capacity is only ${pct}% full — ${avail} spots remaining.` });
  else if (pct < 90) reasons.push({ key: 'cap_mid', positive: true, text: `Capacity ${pct}% used (${avail} spots remaining).` });
  else reasons.push({ key: 'cap_high', positive: false, text: `Nearly full at ${pct}% occupancy.` });
  if (shelter.risk_level === 'low') reasons.push({ key: 'risk_low', positive: true, text: 'Shelter area carries low current disaster risk.' });
  else if (shelter.risk_level === 'medium') reasons.push({ key: 'risk_med', positive: true, text: 'Shelter area carries medium risk — acceptable fallback.' });
  else if (shelter.risk_level === 'high') reasons.push({ key: 'risk_high', positive: false, text: 'Shelter area carries high disaster risk; monitor updates.' });
  else reasons.push({ key: 'risk_crit', positive: false, text: 'Shelter in critical risk zone — not recommended unless last resort.' });
  if (shelter.road_access === 'open') reasons.push({ key: 'road_open', positive: true, text: 'Road access reported open.' });
  else if (shelter.road_access === 'restricted') reasons.push({ key: 'road_restr', positive: false, text: 'Roads partially restricted — add travel time buffer.' });
  else if (shelter.road_access === 'blocked') reasons.push({ key: 'road_blocked', positive: false, text: 'Road access blocked; detour required — confirm route before travel.' });
  else reasons.push({ key: 'road_unk', positive: false, text: 'Road status unknown — listen for local advisories.' });
  if (distanceKm != null) {
    if (distanceKm <= 5) reasons.push({ key: 'dist_close', positive: true, text: `Only ${distanceKm.toFixed(1)} km away — nearest reachable option.` });
    else if (distanceKm <= 20) reasons.push({ key: 'dist_ok', positive: true, text: `${distanceKm.toFixed(1)} km away — manageable travel.` });
    else reasons.push({ key: 'dist_far', positive: false, text: `${distanceKm.toFixed(1)} km away — greater travel cost.` });
  }
  if (hazardsNearbyCount > 0) reasons.push({ key: 'hazard_near', positive: false, text: `${hazardsNearbyCount} active hazard${hazardsNearbyCount === 1 ? '' : 's'} within 20 km of shelter — suitability penalized accordingly.` });
  else reasons.push({ key: 'hazard_clear', positive: true, text: 'No active hazards near this shelter within 20 km.' });
  return reasons;
}

function findBestShelters({ latitude, longitude, searchRadiusKm = 80, maxResults = 5, disasterType = null }) {
  const db = getDb();
  if (latitude == null || longitude == null) {
    throw new Error('latitude and longitude are required');
  }
  const lat = Number(latitude), lng = Number(longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) throw new Error('Invalid coordinates');
  const radius = Math.max(1, Number(searchRadiusKm) || 80);
  const activeHazards = loadActiveHazards();
  const allRows = db.prepare(`
    SELECT * FROM shelters
  `).all();
  const enriched = [];
  for (const row of allRows) {
    const d = haversineKm(lat, lng, row.latitude, row.longitude);
    if (d != null && d > radius * 2.5) continue;
    const score = scoreShelter(row, lat, lng, activeHazards, radius);
    const hazardsNear = activeHazards.filter(h => {
      if (h.latitude == null || h.longitude == null) return false;
      const hd = haversineKm(row.latitude, row.longitude, h.latitude, h.longitude);
      return hd != null && hd <= 20;
    });
    enriched.push({
      ...row,
      distance_km: score.distanceKm,
      suitability_score: score.suitability,
      score_breakdown: score.breakdown,
      hazards_within_20km: hazardsNear.length,
      available_spots: Math.max(0, (row.total_capacity || 0) - (row.current_occupancy || 0)),
      explanation: buildExplanation(row, score, hazardsNear.length),
      route: buildRouteInfo(row.latitude, row.longitude, lat, lng, row.road_access)
    });
  }
  enriched.sort((a, b) => {
    if (a.status === 'open' && b.status !== 'open') return -1;
    if (b.status === 'open' && a.status !== 'open') return 1;
    const suitDiff = (Number(b.suitability_score) || 0) - (Number(a.suitability_score) || 0);
    if (Math.abs(suitDiff) > 1e-9) return suitDiff;
    const distA = Number(a.distance_km) ?? Infinity;
    const distB = Number(b.distance_km) ?? Infinity;
    if (distA !== distB) return distA - distB;
    const availA = Number(a.available_spots) || 0;
    const availB = Number(b.available_spots) || 0;
    return availB - availA;
  });
  const top = enriched.slice(0, Math.max(1, Math.min(50, Number(maxResults) || 5)));
  const best = top[0] || null;
  return {
    requested: {
      latitude: lat, longitude: lng, searchRadiusKm: radius, maxResults, disasterType: disasterType ? normalizeDisasterType(disasterType) : null
    },
    dataset: {
      isSampleData: top.every(s => Number(s.is_sample)),
      shelterCount: top.length,
      note: top.every(s => Number(s.is_sample))
        ? '⚠ ALL SHELTERS LISTED ARE SYNTHETIC SAMPLE DATA FOR DEVELOPMENT / UI DESIGN ONLY. NOT REAL EMERGENCY SHELTERS.' : 'Hybrid dataset — contains sample + real shelter data.'
    },
    recommended: best ? mapShelter(best) : null,
    alternatives: top.slice(1).map(mapShelter),
    allScored: top.map(mapShelter)
  };
}

function mapShelter(s) {
  const a = s.amenities_json;
  let amenities = [];
  try { amenities = typeof a === 'string' ? JSON.parse(a) : Array.isArray(a) ? a : []; } catch (_) { amenities = []; }
  return {
    id: s.id,
    name: s.name,
    address: s.address,
    latitude: s.latitude,
    longitude: s.longitude,
    shelterType: s.shelter_type || null,
    totalCapacity: s.total_capacity || 0,
    currentOccupancy: s.current_occupancy || 0,
    availableSpots: s.available_spots ?? Math.max(0, (s.total_capacity || 0) - (s.current_occupancy || 0)),
    status: s.status,
    riskLevel: s.risk_level,
    roadAccess: s.road_access,
    distanceKm: typeof s.distance_km === 'number' ? +s.distance_km.toFixed(2) : s.distance_km,
    suitabilityScore: typeof s.suitability_score === 'number' ? +s.suitability_score.toFixed(3) : s.suitability_score,
    scoreBreakdown: s.score_breakdown || null,
    hazardsWithin20km: s.hazards_within_20km ?? null,
    amenities,
    explanation: s.explanation || [],
    route: s.route || null,
    source: s.source,
    sourceType: s.source_type,
    isSample: Boolean(s.is_sample),
    lastUpdated: s.last_updated,
    createdAt: s.created_at
  };
}

function listAllShelters() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM shelters ORDER BY name ASC').all();
  const anyReal = rows.some(r => !Number(r.is_sample));
  return {
    dataset: {
      isSampleData: !anyReal,
      count: rows.length,
      note: !anyReal
        ? '⚠ ALL SHELTERS ARE SYNTHETIC SAMPLE DATA FOR DEVELOPMENT / UI DESIGN ONLY.' : 'Dataset may contain authorized shelter records.'
    },
    shelters: rows.map(r => mapShelter({
      ...r,
      available_spots: Math.max(0, (r.total_capacity || 0) - (r.current_occupancy || 0)),
      distance_km: null,
      suitability_score: null,
      score_breakdown: null,
      hazards_within_20km: null,
      explanation: [],
      route: null
    }))
  };
}

module.exports = {
  findBestShelters,
  listAllShelters,
  scoreShelter,
  STATUS_SCORE,
  RISK_PENALTY,
  ROAD_ACCESS_BONUS,
  WEIGHTS
};
