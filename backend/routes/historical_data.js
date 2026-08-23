const express = require('express');
const { fetchHistoricalData, getLastHistoricalSync } = require('../services/historical_fetcher');
const { estimateRisk } = require('../services/risk_estimator');

const router = express.Router();

function parseIsoDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

router.get('/status', (req, res) => {
  try {
    const sync = getLastHistoricalSync();
    res.json({
      success: true,
      source: 'NRSC/ISRO',
      configured: true,
      last_sync: sync,
      defaults: {
        radius_km: Number(process.env.RISK_RADIUS_KM) || 80,
        lookback_days: Number(process.env.RISK_LOOKBACK_DAYS) || 36500,
        dataset: 'India Flood Inventory 1967–2023 / NRSC-ISRO & NASA EONET'
      },
      disclaimer: 'This fetches real curated historical disaster records from NRSC/ISRO and NASA EONET. No data is fabricated.',
      method_not_validated: 'Risk scores based on these records are indicator indexes, not validated predictions.'
    });
  } catch (error) {
    console.error('GET /api/historical-data/status error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to read historical data sync status' });
  }
});

router.post('/fetch', async (req, res) => {
  const input = req.body || {};
  const latitude = input.latitude;
  const longitude = input.longitude;
  const radius_km = input.radius_km || input.radiusKm || input.radius;
  const start_date = input.start_date || input.startDate;
  const end_date = input.end_date || input.endDate;

  try {
    if (latitude == null || latitude === '' || longitude == null || longitude === '') {
      return res.status(400).json({
        success: false,
        error: 'latitude and longitude body parameters are required'
      });
    }
    const latNum = Number(latitude);
    const lngNum = Number(longitude);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({
        success: false,
        error: 'latitude and longitude must be numeric'
      });
    }
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      return res.status(400).json({
        success: false,
        error: 'latitude must be -90..90 and longitude must be -180..180'
      });
    }
    const radiusNum = Number(radius_km || process.env.RISK_RADIUS_KM || 80);
    if (!Number.isFinite(radiusNum) || radiusNum <= 0 || radiusNum > 1000) {
      return res.status(400).json({
        success: false,
        error: 'radius_km must be between 1 and 1000 km'
      });
    }

    const startIso = parseIsoDate(start_date);
    const endIso = parseIsoDate(end_date);

    // 1. Fetch and store real historical disaster records
    const fetchResult = await fetchHistoricalData({
      latitude: latNum,
      longitude: lngNum,
      radius_km: radiusNum,
      start_date: startIso,
      end_date: endIso
    });

    // 2. Automatically compute Future Risk Estimate using:
    // Historical Risk (40%) + Environmental Risk (60%)
    let riskResult = null;
    try {
      riskResult = await estimateRisk({
        latitude: latNum,
        longitude: lngNum,
        radiusKm: radiusNum,
        locationName: input.location_name || input.locationName || '',
        refreshSources: false
      });
    } catch (riskErr) {
      console.error('Error recalculating risk after historical sync:', riskErr);
      riskResult = { error: riskErr.message || String(riskErr) };
    }

    const dataSummary = {
      historicalEventCount: riskResult?.dataCoverage?.historicalEventCount ?? fetchResult.records_saved,
      spanDays: riskResult?.dataCoverage?.spanDays ?? 0,
      uniqueDays: riskResult?.dataCoverage?.uniqueDays ?? 0,
      historicalScore: riskResult?.riskEstimate?.historicalScore ?? null,
      environmentalScore: riskResult?.riskEstimate?.environmentalScore ?? null,
      finalScore: riskResult?.riskEstimate?.score ?? null,
      band: riskResult?.riskEstimate?.bandLabel ?? null
    };

    return res.json({
      success: true,
      records_fetched: fetchResult.records_fetched,
      records_saved: fetchResult.records_saved,
      records_skipped: fetchResult.records_skipped,
      source: fetchResult.source || 'NRSC/ISRO',
      message: 'Historical data synchronized successfully',
      data_summary: dataSummary,
      risk_estimate: riskResult,
      disclaimer: 'Risk estimate only — not a guaranteed disaster prediction.',
      safety_note: 'Historical records from NRSC/ISRO are real curated natural-event data. The combined Future Risk Estimate is an indicator index (40% historical + 60% environmental) and has not been evaluated on a held-out validation dataset.'
    });
  } catch (error) {
    console.error('POST /api/historical-data/fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch historical disaster data',
      source: 'NRSC/ISRO',
      message: error.message || 'Error occurred during historical synchronization'
    });
  }
});

module.exports = router;
