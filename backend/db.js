const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { v4: uuidv4 } = require('uuid');

let db;

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addColumnIfMissing(table, column, definition) {
  if (!tableColumns(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      trust_score INTEGER NOT NULL DEFAULT 50,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS disaster_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      disaster_type TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
      latitude REAL,
      longitude REAL,
      verification_status TEXT NOT NULL DEFAULT 'pending',
      incident_status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS official_alerts (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_type TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      disaster_type TEXT,
      warning_type TEXT,
      location_name TEXT,
      state TEXT,
      district TEXT,
      latitude REAL,
      longitude REAL,
      severity TEXT,
      description TEXT,
      issued_at TEXT,
      valid_until TEXT,
      observed_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      verification_status TEXT NOT NULL DEFAULT 'OFFICIAL_ALERT',
      incident_status TEXT NOT NULL DEFAULT 'active',
      linked_incident_id TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS weather_observations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_type TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      location_name TEXT,
      latitude REAL,
      longitude REAL,
      observed_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      rainfall_mm REAL,
      temperature REAL,
      description TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      disaster_type TEXT NOT NULL,
      location_name TEXT,
      latitude REAL,
      longitude REAL,
      report_count INTEGER NOT NULL DEFAULT 0,
      first_reported_at TEXT,
      latest_reported_at TEXT,
      verification_status TEXT NOT NULL DEFAULT 'CITIZEN_REPORTED',
      confidence_score INTEGER NOT NULL DEFAULT 0,
      official_corroboration INTEGER NOT NULL DEFAULT 0,
      incident_status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS incident_reports (
      incident_id TEXT NOT NULL,
      report_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (incident_id, report_id),
      FOREIGN KEY (incident_id) REFERENCES incidents(id),
      FOREIGN KEY (report_id) REFERENCES disaster_reports(id)
    );

    CREATE TABLE IF NOT EXISTS source_status (
      source TEXT PRIMARY KEY,
      configured INTEGER NOT NULL DEFAULT 0,
      live INTEGER NOT NULL DEFAULT 0,
      last_fetch_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      details_json TEXT
    );

    CREATE TABLE IF NOT EXISTS evidence_files (
      id TEXT PRIMARY KEY,
      report_id TEXT,
      user_id TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT NOT NULL,
      access_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (report_id) REFERENCES disaster_reports(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ai_verifications (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      evidence_id TEXT,
      model_name TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      input_type TEXT NOT NULL DEFAULT 'image',
      detected_labels_json TEXT NOT NULL,
      top_label TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      user_selected_type TEXT NOT NULL,
      match_state TEXT NOT NULL,
      verification_state TEXT NOT NULL,
      verification_bonus INTEGER NOT NULL DEFAULT 0,
      flag_human_review INTEGER NOT NULL DEFAULT 0,
      raw_response_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (report_id) REFERENCES disaster_reports(id),
      FOREIGN KEY (evidence_id) REFERENCES evidence_files(id)
    );

    CREATE TABLE IF NOT EXISTS sos_incidents (
      id TEXT PRIMARY KEY,
      sos_short_id TEXT NOT NULL UNIQUE,
      user_id TEXT,
      latitude REAL,
      longitude REAL,
      location_available INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESCUE_ASSIGNED', 'RESOLVED')),
      acknowledged_at TEXT,
      assigned_at TEXT,
      response_at TEXT,
      resolved_at TEXT,
      assigned_to TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS social_signals (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      author TEXT,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      hazard_type TEXT,
      location TEXT,
      latitude REAL,
      longitude REAL,
      confidence_score INTEGER NOT NULL DEFAULT 0,
      corroboration_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'NEW',
      simulated INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shelters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      total_capacity INTEGER NOT NULL DEFAULT 0,
      current_occupancy INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'full', 'closed', 'evacuating')),
      risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
      road_access TEXT NOT NULL DEFAULT 'open' CHECK (road_access IN ('open', 'restricted', 'blocked', 'unknown')),
      shelter_type TEXT,
      amenities_json TEXT,
      source TEXT NOT NULL DEFAULT 'DEMO_SAMPLE',
      source_type TEXT NOT NULL DEFAULT 'SAMPLE_DATA',
      is_sample INTEGER NOT NULL DEFAULT 1,
      last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  addColumnIfMissing('disaster_reports', 'source', "TEXT NOT NULL DEFAULT 'CITIZEN'");
  addColumnIfMissing('disaster_reports', 'source_type', "TEXT NOT NULL DEFAULT 'CITIZEN_REPORT'");
  addColumnIfMissing('disaster_reports', 'is_seed', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('disaster_reports', 'incident_id', 'TEXT');
  addColumnIfMissing('disaster_reports', 'corroboration_status', "TEXT NOT NULL DEFAULT 'CITIZEN_REPORTED'");
  addColumnIfMissing('disaster_reports', 'evidence_ref', 'TEXT');
  addColumnIfMissing('disaster_reports', 'ai_verification_state', "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing('disaster_reports', 'ai_top_label', 'TEXT');
  addColumnIfMissing('disaster_reports', 'ai_confidence', 'REAL NOT NULL DEFAULT 0');
  addColumnIfMissing('disaster_reports', 'ai_model_info', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reports_severity ON disaster_reports(severity);
    CREATE INDEX IF NOT EXISTS idx_reports_verification ON disaster_reports(verification_status);
    CREATE INDEX IF NOT EXISTS idx_reports_incident ON disaster_reports(incident_status);
    CREATE INDEX IF NOT EXISTS idx_reports_created ON disaster_reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_reports_source ON disaster_reports(source_type);
    CREATE INDEX IF NOT EXISTS idx_alerts_source ON official_alerts(source, source_type);
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(incident_status);
    CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_incidents(status);
    CREATE INDEX IF NOT EXISTS idx_sos_created ON sos_incidents(created_at);
    CREATE INDEX IF NOT EXISTS idx_sos_user ON sos_incidents(user_id);
  `);

  migrateSosStatusEnum();

  relabelLegacySeedRows();
}

function migrateSosStatusEnum() {
  const oldStatuses = ['activated', 'received', 'assigned', 'response_in_progress', 'resolved'];
  const sample = db.prepare(
    `SELECT status FROM sos_incidents WHERE status IN (${oldStatuses.map(() => '?').join(',')}) LIMIT 1`
  ).get(...oldStatuses);

  const tableInfo = db.prepare("PRAGMA table_info('sos_incidents')").all();
  const statusCol = tableInfo.find(c => c.name === 'status');
  const needsCheckRebuild = (statusCol && String(statusCol.type || '').toUpperCase().includes("'ACTIVATED'"));

  if (!sample && !needsCheckRebuild) {
    return;
  }

  const statusMap = {
    activated: 'PENDING',
    received: 'ACKNOWLEDGED',
    assigned: 'RESCUE_ASSIGNED',
    response_in_progress: 'IN_PROGRESS',
    resolved: 'RESOLVED'
  };

  db.exec('PRAGMA foreign_keys = OFF;');

  const existingCols = tableInfo.map(c => c.name).join(', ');

  const selectCols = tableInfo.map(c => {
    if (c.name === 'status') {
      const whenClauses = Object.entries(statusMap)
        .map(([oldV, newV]) => `WHEN '${oldV}' THEN '${newV}'`)
        .join(' ');
      return `CASE status ${whenClauses} ELSE status END AS status`;
    }
    return c.name;
  }).join(', ');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sos_incidents_new (
      id TEXT PRIMARY KEY,
      sos_short_id TEXT NOT NULL UNIQUE,
      user_id TEXT,
      latitude REAL,
      longitude REAL,
      location_available INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESCUE_ASSIGNED', 'RESOLVED')),
      acknowledged_at TEXT,
      assigned_at TEXT,
      response_at TEXT,
      resolved_at TEXT,
      assigned_to TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );
  `);

  db.prepare(`INSERT INTO sos_incidents_new (${existingCols}) SELECT ${selectCols} FROM sos_incidents`).run();

  db.exec(`
    DROP TABLE IF EXISTS sos_incidents_old;
    ALTER TABLE sos_incidents RENAME TO sos_incidents_old;
    ALTER TABLE sos_incidents_new RENAME TO sos_incidents;
    DROP TABLE IF EXISTS sos_incidents_old;
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_incidents(status);
    CREATE INDEX IF NOT EXISTS idx_sos_created ON sos_incidents(created_at);
    CREATE INDEX IF NOT EXISTS idx_sos_user ON sos_incidents(user_id);
  `);

  db.exec('PRAGMA foreign_keys = ON;');
}

function relabelLegacySeedRows() {
  db.prepare(`
    UPDATE disaster_reports
    SET is_seed = 1,
        source = 'DEMO_SEED',
        source_type = 'DEMO_SEED',
        corroboration_status = 'DEMO_SEED',
        verification_status = 'verified',
        disaster_type = CASE description
          WHEN 'Tsunami warning issued for coastal areas of Tamil Nadu' THEN 'tsunami'
          WHEN 'Tropical cyclone approaching Odisha coastline' THEN 'cyclone'
          ELSE disaster_type
        END
    WHERE description IN (
      'Tsunami warning issued for coastal areas of Tamil Nadu',
      'Monsoon flooding in low-lying areas of Mumbai',
      'Tropical cyclone approaching Odisha coastline'
    )
  `).run();
}

function ensureCurrentUserPendingReport() {
  const userId = process.env.DEFAULT_USER_ID || '00000000-0000-4000-8000-000000000001';
  const description = 'Waterlogging reported near Marina Beach after heavy rain';
  const existing = db.prepare(
    'SELECT id FROM disaster_reports WHERE description = ?'
  ).get(description);
  if (existing) {
    db.prepare(`
      UPDATE disaster_reports
      SET user_id = ?,
          verification_status = 'pending',
          disaster_type = 'flood',
          location = 'Chennai, Tamil Nadu',
          severity = 'medium',
          latitude = 13.0827,
          longitude = 80.2707,
          source = 'CITIZEN',
          source_type = 'CITIZEN_REPORT',
          is_seed = 0,
          corroboration_status = 'CITIZEN_REPORTED'
      WHERE id = ?
    `).run(userId, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO disaster_reports (
      id, user_id, disaster_type, location, description, severity,
      latitude, longitude, verification_status, incident_status,
      source, source_type, is_seed, corroboration_status
    ) VALUES (?, ?, 'flood', 'Chennai, Tamil Nadu', ?, 'medium', 13.0827, 80.2707, 'pending', 'active', 'CITIZEN', 'CITIZEN_REPORT', 0, 'CITIZEN_REPORTED')
  `).run(uuidv4(), userId, description);
}

function initDatabase() {
  const dbPath = process.env.DATABASE_PATH || './data/coastwatch.db';
  const absolutePath = path.isAbsolute(dbPath)
    ? dbPath
    : path.join(__dirname, dbPath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  db = new DatabaseSync(absolutePath);
  db.exec('PRAGMA foreign_keys = ON;');
  migrateSchema();
  seedDefaultUser();
  seedSampleDataIfEmpty();
  ensureCurrentUserPendingReport();
  seedSampleSheltersIfEmpty();
  return db;
}

function seedDefaultUser() {
  const id = process.env.DEFAULT_USER_ID || '00000000-0000-4000-8000-000000000001';
  const username = process.env.DEFAULT_USERNAME || 'CurrentUser';
  const displayName = process.env.DEFAULT_DISPLAY_NAME || 'Current User';

  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!existing) {
    db.prepare(`
      INSERT INTO users (id, username, display_name, trust_score, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).run(id, username, displayName, 85);
  }
}

function seedSampleDataIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS total FROM disaster_reports').get().total;
  if (count > 0) return;

  const authorityUsers = [
    { id: uuidv4(), username: 'TamilNaduDM', display_name: 'Tamil Nadu DM', trust_score: 95 },
    { id: uuidv4(), username: 'MumbaiMC', display_name: 'Mumbai Municipal Corp', trust_score: 92 },
    { id: uuidv4(), username: 'ODMCyclone', display_name: 'Odisha Disaster Mgmt', trust_score: 97 }
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (id, username, display_name, trust_score, is_active)
    VALUES (?, ?, ?, ?, 1)
  `);
  for (const user of authorityUsers) {
    insertUser.run(user.id, user.username, user.display_name, user.trust_score);
  }

  const samples = [
    {
      user_id: authorityUsers[0].id,
      disaster_type: 'tsunami',
      location: 'Tamil Nadu',
      description: 'Tsunami warning issued for coastal areas of Tamil Nadu',
      severity: 'high',
      latitude: 11.1271,
      longitude: 78.6569,
      hours_ago: 1
    },
    {
      user_id: authorityUsers[1].id,
      disaster_type: 'flood',
      location: 'Mumbai, Maharashtra',
      description: 'Monsoon flooding in low-lying areas of Mumbai',
      severity: 'medium',
      latitude: 19.076,
      longitude: 72.8777,
      hours_ago: 0.5
    },
    {
      user_id: authorityUsers[2].id,
      disaster_type: 'cyclone',
      location: 'Odisha Coast',
      description: 'Tropical cyclone approaching Odisha coastline',
      severity: 'high',
      latitude: 20.9517,
      longitude: 85.0985,
      hours_ago: 1.5
    }
  ];

  const insertReport = db.prepare(`
    INSERT INTO disaster_reports (
      id, user_id, disaster_type, location, description, severity,
      latitude, longitude, verification_status, incident_status,
      source, source_type, is_seed, corroboration_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', 'active', 'DEMO_SEED', 'DEMO_SEED', 1, 'DEMO_SEED', datetime('now', ?), datetime('now', ?))
  `);

  for (const sample of samples) {
    const offset = `-${Math.round(sample.hours_ago * 60)} minutes`;
    insertReport.run(
      uuidv4(),
      sample.user_id,
      sample.disaster_type,
      sample.location,
      sample.description,
      sample.severity,
      sample.latitude,
      sample.longitude,
      offset,
      offset
    );
  }
}

function seedSampleSheltersIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS total FROM shelters').get().total;
  if (count > 0) return;

  const sampleShelters = [
    {
      name: 'SAMPLE — Noida Sector 27 Community Hall (Development Demo)',
      address: 'Sector 27, Near Golf Course, Noida, Uttar Pradesh',
      latitude: 28.5720,
      longitude: 77.3635,
      total_capacity: 400,
      current_occupancy: 120,
      status: 'open',
      risk_level: 'low',
      road_access: 'open',
      shelter_type: 'Community Center',
      amenities: JSON.stringify(['water', 'electricity', 'first_aid', 'food', 'sanitation', 'parking'])
    },
    {
      name: 'SAMPLE — Dadar West Municipal School (Development Demo)',
      address: 'Lakhamsi Napoo Road, Dadar West, Mumbai, Maharashtra',
      latitude: 19.0180,
      longitude: 72.8410,
      total_capacity: 250,
      current_occupancy: 210,
      status: 'open',
      risk_level: 'medium',
      road_access: 'restricted',
      shelter_type: 'School Building',
      amenities: JSON.stringify(['water', 'electricity', 'first_aid', 'food'])
    },
    {
      name: 'SAMPLE — Marina Beach Community Shelter (Development Demo)',
      address: 'Marina Beach Service Road, Triplicane, Chennai, Tamil Nadu',
      latitude: 13.0550,
      longitude: 80.2840,
      total_capacity: 600,
      current_occupancy: 600,
      status: 'full',
      risk_level: 'high',
      road_access: 'open',
      shelter_type: 'Dedicated Storm Shelter',
      amenities: JSON.stringify(['water', 'first_aid', 'sanitation', 'emergency_power'])
    },
    {
      name: 'SAMPLE — Cuttack Indoor Stadium (Development Demo)',
      address: 'Link Road, Cuttack, Odisha',
      latitude: 20.4620,
      longitude: 85.8830,
      total_capacity: 1500,
      current_occupancy: 320,
      status: 'open',
      risk_level: 'medium',
      road_access: 'open',
      shelter_type: 'Sports Complex',
      amenities: JSON.stringify(['water', 'electricity', 'food', 'sanitation', 'parking', 'medical'])
    },
    {
      name: 'SAMPLE — Kollam District Hospital Annex (Development Demo)',
      address: 'Asramam, Kollam, Kerala',
      latitude: 8.8890,
      longitude: 76.5890,
      total_capacity: 180,
      current_occupancy: 0,
      status: 'closed',
      risk_level: 'critical',
      road_access: 'blocked',
      shelter_type: 'Hospital Facility',
      amenities: JSON.stringify(['water', 'electricity', 'medical', 'food'])
    },
    {
      name: 'SAMPLE — Vishakhapatnam Zilla Parishad Hall (Development Demo)',
      address: 'Waltair Main Road, Visakhapatnam, Andhra Pradesh',
      latitude: 17.7230,
      longitude: 83.3010,
      total_capacity: 500,
      current_occupancy: 80,
      status: 'open',
      risk_level: 'low',
      road_access: 'open',
      shelter_type: 'Government Building',
      amenities: JSON.stringify(['water', 'electricity', 'first_aid', 'sanitation', 'parking'])
    },
    {
      name: 'SAMPLE — South Goa Multipurpose Hall (Development Demo)',
      address: 'Margao, South Goa, Goa',
      latitude: 15.2990,
      longitude: 73.9810,
      total_capacity: 300,
      current_occupancy: 45,
      status: 'open',
      risk_level: 'low',
      road_access: 'unknown',
      shelter_type: 'Community Center',
      amenities: JSON.stringify(['water', 'food', 'sanitation'])
    },
    {
      name: 'SAMPLE — Ahmedabad Town Hall (Development Demo)',
      address: 'Khanpur, Ahmedabad, Gujarat',
      latitude: 23.0170,
      longitude: 72.5730,
      total_capacity: 700,
      current_occupancy: 510,
      status: 'open',
      risk_level: 'medium',
      road_access: 'restricted',
      shelter_type: 'Public Building',
      amenities: JSON.stringify(['water', 'electricity', 'first_aid', 'food', 'sanitation'])
    },
    {
      name: 'SAMPLE — Guwahati Railway Auditorium (Development Demo)',
      address: 'Paltan Bazaar, Guwahati, Assam',
      latitude: 26.1810,
      longitude: 91.7460,
      total_capacity: 420,
      current_occupancy: 190,
      status: 'evacuating',
      risk_level: 'high',
      road_access: 'restricted',
      shelter_type: 'Auditorium',
      amenities: JSON.stringify(['water', 'electricity', 'first_aid', 'sanitation'])
    },
    {
      name: 'SAMPLE — Kolkata Salt Lake Stadium Annexe (Development Demo)',
      address: 'Salt Lake Stadium Complex, Bidhannagar, Kolkata, West Bengal',
      latitude: 22.5680,
      longitude: 88.4060,
      total_capacity: 2000,
      current_occupancy: 400,
      status: 'open',
      risk_level: 'low',
      road_access: 'open',
      shelter_type: 'Sports Complex',
      amenities: JSON.stringify(['water', 'electricity', 'food', 'sanitation', 'parking', 'medical', 'emergency_power'])
    }
  ];

  const insertStmt = db.prepare(`
    INSERT INTO shelters (
      id, name, address, latitude, longitude,
      total_capacity, current_occupancy, status, risk_level,
      road_access, shelter_type, amenities_json,
      source, source_type, is_sample, last_updated, created_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      'DEMO_SAMPLE', 'SAMPLE_DATA', 1, datetime('now'), datetime('now')
    )
  `);

  for (const s of sampleShelters) {
    insertStmt.run(
      uuidv4(),
      s.name,
      s.address,
      s.latitude,
      s.longitude,
      s.total_capacity,
      s.current_occupancy,
      s.status,
      s.risk_level,
      s.road_access,
      s.shelter_type,
      s.amenities
    );
  }
}

module.exports = {
  initDatabase,
  getDb
};
