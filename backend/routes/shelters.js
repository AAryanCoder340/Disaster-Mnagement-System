const express = require('express');
const { getDb } = require('../db');
const { findBestShelters, listAllShelters } = require('../services/shelter_recommender');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    res.json({ success: true, ...listAllShelters() });
  } catch (error) {
    console.error('GET /api/shelters error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to list shelters' });
  }
});

router.get('/recommend', (req, res) => {
  try {
    const { latitude, longitude, radius, maxResults, disasterType } = req.query;
    if (latitude == null || latitude === '' || longitude == null || longitude === '') {
      return res.status(400).json({
        success: false,
        error: 'latitude and longitude query parameters are required (e.g. /api/shelters/recommend?latitude=28.5693&longitude=77.3828)'
      });
    }
    const result = findBestShelters({
      latitude,
      longitude,
      searchRadiusKm: radius,
      maxResults,
      disasterType
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('GET /api/shelters/recommend error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to recommend shelters' });
  }
});

router.post('/recommend', (req, res) => {
  try {
    const { latitude, longitude, searchRadiusKm, radius, maxResults, disasterType } = req.body || {};
    if (latitude == null || latitude === '' || longitude == null || longitude === '') {
      return res.status(400).json({
        success: false,
        error: 'latitude and longitude are required in the request body.'
      });
    }
    const result = findBestShelters({
      latitude,
      longitude,
      searchRadiusKm: searchRadiusKm != null ? searchRadiusKm : radius,
      maxResults,
      disasterType
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('POST /api/shelters/recommend error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to recommend shelters' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM shelters WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Shelter not found' });
    const availableSpots = Math.max(0, (row.total_capacity || 0) - (row.current_occupancy || 0));
    let amenities = [];
    try { amenities = row.amenities_json ? JSON.parse(row.amenities_json) : []; } catch (_) { amenities = []; }
    res.json({
      success: true,
      shelter: {
        id: row.id,
        name: row.name,
        address: row.address,
        latitude: row.latitude,
        longitude: row.longitude,
        shelterType: row.shelter_type || null,
        totalCapacity: row.total_capacity || 0,
        currentOccupancy: row.current_occupancy || 0,
        availableSpots,
        status: row.status,
        riskLevel: row.risk_level,
        roadAccess: row.road_access,
        amenities,
        source: row.source,
        sourceType: row.source_type,
        isSample: Boolean(row.is_sample),
        lastUpdated: row.last_updated,
        createdAt: row.created_at
      },
      dataset: {
        isSampleData: Boolean(row.is_sample),
        note: Boolean(row.is_sample) ? '⚠ Sample / synthetic record — for UI design only.' : 'Authoritative shelter record.'
      }
    });
  } catch (error) {
    console.error('GET /api/shelters/:id error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch shelter' });
  }
});

module.exports = router;
