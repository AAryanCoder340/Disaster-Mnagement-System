const { getDb, initDatabase } = require('./db');
const { estimateRisk, scanRiskHotspots, getThresholds } = require('./services/risk_estimator');

initDatabase();

async function runTests() {
  console.log('=== Database Counts ===');
  const db = getDb();
  const reportsCount = db.prepare("SELECT count(*) as c FROM disaster_reports WHERE COALESCE(is_seed, 0) = 0 AND COALESCE(source_type, '') NOT IN ('DEMO_SEED')").get().c;
  const alertsCount = db.prepare('SELECT count(*) as c FROM official_alerts').get().c;
  const weatherCount = db.prepare('SELECT count(*) as c FROM weather_observations').get().c;
  console.log(`Non-seed disaster reports: ${reportsCount}`);
  console.log(`Official alerts: ${alertsCount}`);
  console.log(`Weather observations: ${weatherCount}`);

  console.log('\n=== Thresholds ===');
  const thresholds = getThresholds();
  console.log(JSON.stringify(thresholds, null, 2));

  console.log('\n=== Test 1: Mumbai (19.0760, 72.8777) ===');
  const mumbai = await estimateRisk({
    latitude: 19.0760,
    longitude: 72.8777,
    radiusKm: 80,
    locationName: 'Mumbai, Maharashtra',
    refreshSources: false
  });
  console.log('  available:', mumbai.available);
  console.log('  gate:', JSON.stringify(mumbai.gate, null, 2));
  console.log('  dataCoverage:', {
    historicalEventCount: mumbai.dataCoverage?.historicalEventCount,
    spanDays: mumbai.dataCoverage?.spanDays,
    uniqueDays: mumbai.dataCoverage?.uniqueDays,
    environmentalSignalCount: mumbai.dataCoverage?.environmentalSignalCount
  });
  if (mumbai.riskEstimate) {
    console.log('  --- RISK SCORES ---');
    console.log(`    Final Score: ${mumbai.riskEstimate.score} /100 (band: ${mumbai.riskEstimate.bandLabel})`);
    console.log(`    Historical Score: ${mumbai.riskEstimate.historicalScore} /100`);
    console.log(`    Environmental Score: ${mumbai.riskEstimate.environmentalScore} /100`);
    console.log(`    Primary hazard: ${mumbai.riskEstimate.primaryHazardType}`);
    console.log('  --- Confidence ---');
    console.log(`    score: ${Math.round(mumbai.confidence.score * 100)}% label: ${mumbai.confidence.label}`);
    console.log('  --- Contributing Factors ---');
    mumbai.contributingFactors.forEach((f) => console.log(`    - ${f.text}`));
  }

  console.log('\n=== Test 2: Scan Risk Hotspots ===');
  const scan = await scanRiskHotspots({ radiusKm: 80 });
  console.log(`  Scanned clusters: ${scan.scannedClusters}`);
  console.log(`  Qualifying estimates: ${scan.availableCount}`);
  scan.estimates.forEach((est, idx) => {
    console.log(`    ${idx + 1}. ${est.location?.name}: Final=${est.riskEstimate?.score} (H=${est.riskEstimate?.historicalScore}, E=${est.riskEstimate?.environmentalScore}) band=${est.riskEstimate?.bandLabel}`);
  });

  console.log('\n✅ All tests complete.');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
