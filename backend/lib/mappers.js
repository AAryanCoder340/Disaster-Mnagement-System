function mapReportRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    reporter: row.username || row.display_name || 'Citizen',
    trustScore: row.trust_score,
    disasterType: row.disaster_type,
    type: row.disaster_type,
    location: row.location,
    description: row.description,
    severity: row.severity,
    latitude: row.latitude,
    longitude: row.longitude,
    coordinates:
      row.latitude != null && row.longitude != null
        ? { lat: row.latitude, lng: row.longitude }
        : null,
    verificationStatus: row.verification_status,
    verified: row.verification_status === 'verified',
    corroborationStatus: row.corroboration_status || 'CITIZEN_REPORTED',
    incidentStatus: row.incident_status,
    incidentId: row.incident_id || null,
    source: row.source || 'CITIZEN',
    sourceType: row.source_type || 'CITIZEN_REPORT',
    isSeed: Boolean(row.is_seed),
    evidenceRef: row.evidence_ref || null,
    aiVerificationState: row.ai_verification_state || 'none',
    aiTopLabel: row.ai_top_label || null,
    aiConfidence: typeof row.ai_confidence === 'number' ? row.ai_confidence : 0,
    aiModelInfo: row.ai_model_info || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timestamp: row.created_at
  };
}

function mapIncidentRow(row) {
  return {
    id: row.id,
    disasterType: row.disaster_type,
    location: row.location_name,
    latitude: row.latitude,
    longitude: row.longitude,
    coordinates:
      row.latitude != null && row.longitude != null
        ? { lat: row.latitude, lng: row.longitude }
        : null,
    reportCount: row.report_count,
    firstReportedAt: row.first_reported_at,
    latestReportedAt: row.latest_reported_at,
    verificationStatus: row.verification_status,
    confidenceScore: row.confidence_score,
    officialCorroboration: Boolean(row.official_corroboration),
    incidentStatus: row.incident_status,
    sourceType: row.official_corroboration
      ? 'VERIFIED_INCIDENT'
      : Number(row.report_count) >= 3
        ? 'CORROBORATED'
        : 'CITIZEN_REPORT'
  };
}

function mapAlertRow(row) {
  return {
    id: row.id,
    source: row.source,
    sourceType: row.source_type,
    externalId: row.external_id,
    disasterType: row.disaster_type,
    warningType: row.warning_type,
    location: row.location_name,
    state: row.state,
    district: row.district,
    latitude: row.latitude,
    longitude: row.longitude,
    coordinates:
      row.latitude != null && row.longitude != null
        ? { lat: row.latitude, lng: row.longitude }
        : null,
    severity: row.severity,
    description: row.description,
    issuedAt: row.issued_at,
    validUntil: row.valid_until,
    observedAt: row.observed_at,
    fetchedAt: row.fetched_at,
    verificationStatus: row.verification_status,
    incidentStatus: row.incident_status,
    linkedIncidentId: row.linked_incident_id
  };
}

function mapSourceStatus(row) {
  return {
    source: row.source,
    configured: Boolean(row.configured),
    live: Boolean(row.live),
    lastFetchAt: row.last_fetch_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    details: row.details_json ? JSON.parse(row.details_json) : null
  };
}

module.exports = {
  mapReportRow,
  mapIncidentRow,
  mapAlertRow,
  mapSourceStatus
};
