function toRad(value) {
  return (value * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((n) => n == null || Number.isNaN(Number(n)))) {
    return null;
  }
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function normalizeDisasterType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'other';
  if (raw.includes('flood') || raw.includes('rain') || raw.includes('inundat')) return 'flood';
  if (raw.includes('cyclone') || raw.includes('storm') || raw.includes('tsunami') || raw.includes('squall')) {
    return 'storm';
  }
  if (raw.includes('fire')) return 'fire';
  if (raw.includes('quake')) return 'earthquake';
  if (raw.includes('landslide') || raw.includes('slide')) return 'landslide';
  if (raw.includes('heat')) return 'heat';
  if (raw.includes('cold') || raw.includes('snow')) return 'cold';
  if (raw.includes('lightning') || raw.includes('thunder')) return 'storm';
  return raw;
}

function sameHazardFamily(a, b) {
  return normalizeDisasterType(a) === normalizeDisasterType(b);
}

module.exports = {
  haversineKm,
  normalizeDisasterType,
  sameHazardFamily
};
