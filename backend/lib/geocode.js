/**
 * Static place centroids for mapping named IMD/SACHET locations.
 * These are geographic helpers only — not disaster observations.
 */
const PLACE_CENTROIDS = [
  { name: 'chennai', lat: 13.0827, lng: 80.2707 },
  { name: 'tamil nadu', lat: 11.1271, lng: 78.6569 },
  { name: 'mumbai', lat: 19.076, lng: 72.8777 },
  { name: 'maharashtra', lat: 19.7515, lng: 75.7139 },
  { name: 'odisha', lat: 20.9517, lng: 85.0985 },
  { name: 'bhubaneswar', lat: 20.2961, lng: 85.8245 },
  { name: 'kolkata', lat: 22.5726, lng: 88.3639 },
  { name: 'west bengal', lat: 22.9868, lng: 87.855 },
  { name: 'visakhapatnam', lat: 17.6868, lng: 83.2185 },
  { name: 'andhra pradesh', lat: 15.9129, lng: 79.74 },
  { name: 'kerala', lat: 10.8505, lng: 76.2711 },
  { name: 'kochi', lat: 9.9312, lng: 76.2673 },
  { name: 'goa', lat: 15.2993, lng: 74.124 },
  { name: 'gujarat', lat: 22.2587, lng: 71.1924 },
  { name: 'kandla', lat: 23.0333, lng: 70.2167 },
  { name: 'delhi', lat: 28.6139, lng: 77.209 },
  { name: 'andaman', lat: 11.7401, lng: 92.6586 },
  { name: 'nicobar', lat: 7.0, lng: 93.5 },
  { name: 'lakshadweep', lat: 10.5667, lng: 72.6417 },
  { name: 'puducherry', lat: 11.9416, lng: 79.8083 }
];

function geocodePlace(text) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return null;
  for (const place of PLACE_CENTROIDS) {
    if (hay.includes(place.name)) {
      return { latitude: place.lat, longitude: place.lng };
    }
  }
  return null;
}

function centroidOfPolygon(capPolygon) {
  if (!capPolygon || typeof capPolygon !== 'string') return null;
  const points = capPolygon
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number))
    .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!points.length) return null;
  const lat = points.reduce((s, p) => s + p[0], 0) / points.length;
  const lng = points.reduce((s, p) => s + p[1], 0) / points.length;
  return { latitude: lat, longitude: lng };
}

function nearestPlace(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  let best = null;
  let minKm = Infinity;
  for (const place of PLACE_CENTROIDS) {
    const dLat = (place.lat - lat) * (Math.PI / 180);
    const dLng = (place.lng - lng) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat * (Math.PI / 180)) * Math.cos(place.lat * (Math.PI / 180)) * Math.sin(dLng / 2) ** 2;
    const km = 6371 * 2 * Math.asin(Math.sqrt(a));
    if (km < minKm) {
      minKm = km;
      best = { name: place.name.charAt(0).toUpperCase() + place.name.slice(1), km: +km.toFixed(1) };
    }
  }
  return best;
}

module.exports = {
  PLACE_CENTROIDS,
  geocodePlace,
  centroidOfPolygon,
  nearestPlace
};
