const express = require('express');
const { estimateRisk, scanRiskHotspots, getThresholds, LIMITATIONS } = require('../services/risk_estimator');

const router = express.Router();

router.get('/thresholds', (req, res) => {
  try {
    res.json({
      success: true,
      kind: 'risk_estimate',
      thresholds: getThresholds(),
      limitations: LIMITATIONS,
      disclaimer: 'Risk estimate only — not a guaranteed disaster prediction.',
      method: {
        evaluatedOnValidationDataset: false,
        accuracyClaim: null
      }
    });
  } catch (error) {
    console.error('GET /api/risk/thresholds error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to load risk thresholds' });
  }
});

router.get('/estimate', async (req, res) => {
  try {
    const { latitude, longitude, radiusKm, radius, horizonHours, locationName } = req.query;
    if (latitude == null || latitude === '' || longitude == null || longitude === '') {
      return res.status(400).json({
        success: false,
        error: 'latitude and longitude query parameters are required'
      });
    }
    const result = await estimateRisk({
      latitude,
      longitude,
      radiusKm: radiusKm != null ? radiusKm : radius,
      horizonHours,
      locationName
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('GET /api/risk/estimate error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to estimate risk' });
  }
});

router.post('/estimate', async (req, res) => {
  try {
    const { latitude, longitude, radiusKm, radius, horizonHours, locationName } = req.body || {};
    if (latitude == null || latitude === '' || longitude == null || longitude === '') {
      return res.status(400).json({
        success: false,
        error: 'latitude and longitude are required'
      });
    }
    const result = await estimateRisk({
      latitude,
      longitude,
      radiusKm: radiusKm != null ? radiusKm : radius,
      horizonHours,
      locationName
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('POST /api/risk/estimate error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to estimate risk' });
  }
});

router.get('/scan', async (req, res) => {
  try {
    const { radiusKm, radius, horizonHours } = req.query;
    const result = await scanRiskHotspots({
      radiusKm: radiusKm != null ? radiusKm : radius,
      horizonHours
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('GET /api/risk/scan error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to scan risk areas' });
  }
});

module.exports = router;
