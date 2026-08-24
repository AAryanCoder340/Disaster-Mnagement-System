const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { broadcast } = require('../lib/sse');

// --- Mock Data ---
const MOCK_DATA = [
  {
    id: 'mock-1',
    author: '@Mumbaikar123',
    text: 'Heavy flooding reported near Andheri after intense rainfall. Roads completely waterlogged.',
    timestamp: new Date().toISOString()
  },
  {
    id: 'mock-2',
    author: '@ChennaiUpdates',
    text: 'People trapped near the railway underpass in Chennai due to rising water.',
    timestamp: new Date(Date.now() - 3600000).toISOString()
  },
  {
    id: 'mock-3',
    author: '@AssamNews',
    text: 'Strong shaking felt across several areas of Guwahati. People are moving outside.',
    timestamp: new Date(Date.now() - 7200000).toISOString()
  },
  {
    id: 'mock-4',
    author: '@SuratFireWatch',
    text: 'Large fire reported near an industrial area in Surat. Thick smoke visible from nearby roads.',
    timestamp: new Date(Date.now() - 10800000).toISOString()
  },
  {
    id: 'mock-5',
    author: '@RandomUser',
    text: 'Just having a nice cup of tea while looking at the storm outside.',
    timestamp: new Date(Date.now() - 14400000).toISOString()
  }
];

// --- Hazard and Location Keywords ---
const HAZARD_KEYWORDS = {
  'flood': ['flood', 'flooding', 'waterlogged', 'waterlogging', 'inundation', 'submerged'],
  'earthquake': ['earthquake', 'tremor', 'shaking', 'quake'],
  'cyclone': ['cyclone', 'hurricane', 'typhoon', 'storm', 'strong winds'],
  'fire': ['fire', 'wildfire', 'blaze', 'smoke', 'burning'],
  'landslide': ['landslide', 'mudslide', 'rockfall']
};

const CITY_LOCATIONS = {
  'mumbai': { name: 'Mumbai, Maharashtra', lat: 19.0760, lng: 72.8777 },
  'andheri': { name: 'Mumbai, Maharashtra', lat: 19.1136, lng: 72.8697 },
  'chennai': { name: 'Chennai, Tamil Nadu', lat: 13.0827, lng: 80.2707 },
  'guwahati': { name: 'Guwahati, Assam', lat: 26.1445, lng: 91.7362 },
  'surat': { name: 'Surat, Gujarat', lat: 21.1702, lng: 72.8311 }
};

const SOCIAL_SEARCH_QUERY = '(flood OR flooding OR waterlogging OR earthquake OR tremor OR cyclone OR storm OR landslide OR mudslide OR wildfire OR fire) -is:retweet';

class SocialIntelligenceService {
  constructor() {
    this.provider = process.env.SOCIAL_DATA_PROVIDER || 'mock';
    this.bearerToken = process.env.X_BEARER_TOKEN;
  }

  async fetchSignals() {
    let posts = [];
    if (this.provider === 'x' && this.bearerToken) {
      posts = await this.fetchXData();
    } else {
      posts = this.fetchMockData();
    }
    
    const signals = [];
    for (const post of posts) {
      const signal = await this.analyzePost(post);
      if (signal) {
        signals.push(signal);
      }
    }
    
    this.saveSignals(signals);
    return signals;
  }

  fetchMockData() {
    return MOCK_DATA.map(d => ({
      ...d,
      simulated: true,
      source: 'SIMULATED'
    }));
  }

  async fetchXData() {
    console.log('Fetching data from X API...');
    try {
      const url = new URL('https://api.twitter.com/2/tweets/search/recent');
      url.searchParams.append('query', SOCIAL_SEARCH_QUERY);
      url.searchParams.append('tweet.fields', 'created_at,author_id');
      url.searchParams.append('expansions', 'author_id');
      url.searchParams.append('user.fields', 'username');
      url.searchParams.append('max_results', '15'); // Limit to 15 for demo

      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${this.bearerToken}`
        }
      });

      if (!response.ok) {
        console.error(`X API request failed: ${response.status} ${response.statusText}`);
        throw new Error('X API Error');
      }

      const data = await response.json();
      return this.normalizeXPost(data);
    } catch (e) {
      console.error('X API Error, falling back to mock. Details:', e.message);
      // Let UI know we are in fallback mode
      broadcast({ type: 'SOCIAL_PROVIDER_FALLBACK' });
      return this.fetchMockData();
    }
  }

  normalizeXPost(apiResponse) {
    if (!apiResponse || !apiResponse.data) return [];
    
    // Create a map for quick user lookups
    const userMap = {};
    if (apiResponse.includes && apiResponse.includes.users) {
      apiResponse.includes.users.forEach(user => {
        userMap[user.id] = user.username;
      });
    }

    return apiResponse.data.map(tweet => {
      const username = userMap[tweet.author_id];
      return {
        id: tweet.id,
        author: username ? `@${username}` : 'Unknown Author',
        text: tweet.text,
        timestamp: tweet.created_at || new Date().toISOString(),
        source: 'X',
        simulated: false
      };
    });
  }

  async analyzePost(post) {
    const text = post.text.toLowerCase();
    
    // 1. Hazard Classification
    let hazardType = 'Unknown';
    let maxHazardMatches = 0;
    
    for (const [hazard, keywords] of Object.entries(HAZARD_KEYWORDS)) {
      let matches = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) matches++;
      }
      if (matches > maxHazardMatches) {
        maxHazardMatches = matches;
        hazardType = hazard;
      }
    }
    
    if (maxHazardMatches === 0) return null; // Not disaster related

    // 2. Location Extraction
    let location = null;
    let lat = null;
    let lng = null;
    
    for (const [cityKey, locData] of Object.entries(CITY_LOCATIONS)) {
      if (text.includes(cityKey)) {
        location = locData.name;
        lat = locData.lat;
        lng = locData.lng;
        break;
      }
    }

    // 3. Confidence Score Calculation
    let confidence = 50; 
    if (maxHazardMatches > 1) confidence += 15;
    if (location) confidence += 20;

    // 4. Corroboration with CoastWatch Reports
    let corroborationCount = 0;
    if (lat !== null && lng !== null) {
      const db = getDb();
      const latRange = 0.1;
      const lngRange = 0.1;
      
      const reports = db.prepare(`
        SELECT count(*) as cnt FROM disaster_reports 
        WHERE disaster_type = ? 
        AND latitude BETWEEN ? AND ? 
        AND longitude BETWEEN ? AND ?
      `).get(
        hazardType, 
        lat - latRange, lat + latRange, 
        lng - lngRange, lng + lngRange
      );
      
      corroborationCount = reports ? reports.cnt : 0;
      if (corroborationCount > 0) {
        confidence += 15;
      }
    }
    
    confidence = Math.min(confidence, 100);
    
    return {
      id: post.id || uuidv4(),
      source: post.source || 'X',
      author: post.author,
      text: post.text,
      timestamp: post.timestamp || new Date().toISOString(),
      hazard_type: hazardType,
      location: location || 'Unknown',
      latitude: lat,
      longitude: lng,
      confidence_score: confidence,
      corroboration_count: corroborationCount,
      status: 'NEW',
      simulated: post.simulated ? 1 : 0,
      raw_json: JSON.stringify(post)
    };
  }

  saveSignals(signals) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO social_signals 
      (id, source, author, text, timestamp, hazard_type, location, latitude, longitude, confidence_score, corroboration_count, status, simulated, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let added = 0;
    try {
      db.exec('BEGIN TRANSACTION');
      for (const sig of signals) {
        const res = stmt.run(
          sig.id, sig.source, sig.author, sig.text, sig.timestamp, 
          sig.hazard_type, sig.location, sig.latitude, sig.longitude, 
          sig.confidence_score, sig.corroboration_count, sig.status, 
          sig.simulated, sig.raw_json
        );
        if (res && res.changes > 0) added++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('Transaction failed:', err);
      throw err;
    }
    
    if (added > 0) {
      broadcast({ type: 'SOCIAL_SIGNALS_UPDATED' });
    }
  }
}

let ingestInterval = null;
const service = new SocialIntelligenceService();

function startSocialIngest() {
  if (ingestInterval) return;
  console.log('Starting Social Disaster Intelligence ingest...');
  
  service.fetchSignals().catch(e => console.error('Social ingest error:', e));
  
  ingestInterval = setInterval(() => {
    service.fetchSignals().catch(e => console.error('Social ingest error:', e));
  }, 5 * 60 * 1000);
}

module.exports = {
  startSocialIngest,
  SocialIntelligenceService
};
