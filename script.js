let map;
let currentLocation = null;
let selectedSeverity = null;
let reports = [];
let mapMarkers = [];
let userTrustScore = 85;
let currentUserId = null;
let sosActive = false;
let currentSosIncident = null;
let sosPollIntervalId = null;
let currentSosFilter = 'active';
let dashboardSosPollIntervalId = null;
const SOS_STATUS_ORDER = ['PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESCUE_ASSIGNED', 'RESOLVED'];

const SOS_STATUS_LABEL = {
  PENDING: 'SOS Submitted',
  ACKNOWLEDGED: 'Marked by Authority',
  IN_PROGRESS: 'Response in Progress',
  RESCUE_ASSIGNED: 'Rescue Team Assigned',
  RESOLVED: 'Resolved'
};

const SOS_STATUS_ICON = {
  PENDING: 'fa-bolt',
  ACKNOWLEDGED: 'fa-check-circle',
  IN_PROGRESS: 'fa-ambulance',
  RESCUE_ASSIGNED: 'fa-user-shield',
  RESOLVED: 'fa-check-double'
};

const SOS_STATUS_NOTE = {
  PENDING: 'Your distress signal has been sent to the CoastWatch emergency system.',
  ACKNOWLEDGED: 'An authority operator has acknowledged your SOS signal.',
  IN_PROGRESS: 'Emergency responders are mobilizing. Stay calm and keep your phone on.',
  RESCUE_ASSIGNED: 'A dedicated rescue team has been dispatched to your location.',
  RESOLVED: 'This SOS incident has been marked as resolved. Stay safe.'
};

const API_BASE = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin.startsWith('http') && !window.location.origin.includes('file://'))
    ? window.location.origin
    : 'http://localhost:3000';

// Social signals data
let socialSignals = [];

document.addEventListener('DOMContentLoaded', function () {
    initializeMap();
    setupFormHandlers();
    loadAppData();
    fetchSocialSignals(); // Fetch social intelligence data
    checkAuth();

    document.addEventListener('click', function (event) {
        const logoMenu = document.getElementById('logoMenu');
        const logo = document.querySelector('.logo');

        if (!logo.contains(event.target) && logoMenu.classList.contains('show')) {
            logoMenu.classList.remove('show');
        }
    });
});

async function loadAppData() {
    await Promise.all([
        loadCurrentUser(),
        loadReports(),
        loadDashboardStats()
    ]);
    await restoreSosFromStorage();
}

async function loadCurrentUser() {
    try {
        const response = await fetch(`${API_BASE}/api/users/me`);
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to load user');
        }

        currentUserId = data.user.id;
        userTrustScore = data.user.trustScore;

        const trustEl = document.querySelector('.trust-score');
        if (trustEl) {
            trustEl.innerHTML =
                `<i class="fas fa-star"></i> Trust Score: ${userTrustScore}`;
        }

        const welcome = document.querySelector('.user-info span');
        if (welcome) {
            welcome.textContent = `Welcome, ${data.user.displayName || data.user.username}`;
        }
    } catch (error) {
        console.error(error);
        showNotification('Could not load user profile from server', 'error');
    }
}

async function loadReports() {
    const container = document.getElementById('recentReports');
    if (container) {
        container.innerHTML = `
            <div class="report-card" style="grid-column: 1 / -1; text-align: center;">
                Loading reports...
            </div>
        `;
    }

    try {
        const response = await fetch(`${API_BASE}/api/reports`);
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to load reports');
        }

        reports = (data.reports || []).map(normalizeReport);
        populateRecentReports();
        refreshMapMarkers();
    } catch (error) {
        console.error(error);
        reports = [];
        if (container) {
            container.innerHTML = `
                <div class="report-card" style="grid-column: 1 / -1; text-align: center; color: #e74c3c;">
                    Unable to load reports. Make sure the backend is running.
                </div>
            `;
        }
        showNotification('Failed to load disaster reports', 'error');
    }
}

async function loadDashboardStats(silent = false) {
    const statusEl = document.getElementById('dashboardStatus');
    if (!silent) setDashboardNumbersLoading();

    if (statusEl && !silent) {
        statusEl.style.display = 'block';
        statusEl.textContent = 'Loading dashboard stats...';
        statusEl.style.color = '#f4f4f4';
    }

    try {
        const response = await fetch(`${API_BASE}/api/dashboard/stats`);
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to load dashboard stats');
        }

        const stats = data.stats;
        setStat('statTotalReports', stats.totalReports);
        setStat('statHighPriority', stats.highPriorityReports);
        setStat('statVerifiedReports', stats.verifiedReports);
        setStat('statActiveUsers', stats.activeUsers);
        setStat('statActiveIncidents', stats.activeIncidents);

        if (statusEl) {
            statusEl.style.display = 'none';
            statusEl.textContent = '';
        }
    } catch (error) {
        console.error(error);
        setDashboardNumbersUnavailable();
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.style.color = '#e74c3c';
            statusEl.textContent = 'Error loading dashboard data from the database.';
        }
    }
}

function setStat(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = Number(value).toLocaleString();
    }
}

function setDashboardNumbersLoading() {
    ['statTotalReports', 'statHighPriority', 'statVerifiedReports', 'statActiveUsers', 'statActiveIncidents']
        .forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = '…';
        });
}

function setDashboardNumbersUnavailable() {
    ['statTotalReports', 'statHighPriority', 'statVerifiedReports', 'statActiveUsers', 'statActiveIncidents']
        .forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = '—';
        });
}

function parseServerDate(value) {
    if (!value) return new Date();
    if (value instanceof Date) return value;
    if (typeof value === 'number') return new Date(value);
    const normalized = String(value).includes('T')
        ? String(value)
        : String(value).replace(' ', 'T') + 'Z';
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

const INDIAN_PLACES = [
    { name: 'Noida', lat: 28.5355, lng: 77.3910 },
    { name: 'Delhi', lat: 28.6139, lng: 77.2090 },
    { name: 'Gurugram', lat: 28.4595, lng: 77.0266 },
    { name: 'Ghaziabad', lat: 28.6692, lng: 77.4538 },
    { name: 'Faridabad', lat: 28.4089, lng: 77.3178 },
    { name: 'Mumbai', lat: 19.0760, lng: 72.8777 },
    { name: 'Thane', lat: 19.2183, lng: 72.9781 },
    { name: 'Navi Mumbai', lat: 19.0330, lng: 73.0297 },
    { name: 'Pune', lat: 18.5204, lng: 73.8567 },
    { name: 'Nagpur', lat: 21.1458, lng: 79.0882 },
    { name: 'Chennai', lat: 13.0827, lng: 80.2707 },
    { name: 'Coimbatore', lat: 11.0168, lng: 76.9558 },
    { name: 'Kolkata', lat: 22.5726, lng: 88.3639 },
    { name: 'Howrah', lat: 22.5726, lng: 88.3639 },
    { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
    { name: 'Hyderabad', lat: 17.3850, lng: 78.4867 },
    { name: 'Ahmedabad', lat: 23.0225, lng: 72.5714 },
    { name: 'Surat', lat: 21.1702, lng: 72.8311 },
    { name: 'Vadodara', lat: 22.3072, lng: 73.1812 },
    { name: 'Jaipur', lat: 26.9124, lng: 75.7873 },
    { name: 'Lucknow', lat: 26.8467, lng: 80.9462 },
    { name: 'Kanpur', lat: 26.4499, lng: 80.3319 },
    { name: 'Patna', lat: 25.5941, lng: 85.1376 },
    { name: 'Bhopal', lat: 23.2599, lng: 77.4126 },
    { name: 'Indore', lat: 22.7196, lng: 75.8577 },
    { name: 'Visakhapatnam', lat: 17.6868, lng: 83.2185 },
    { name: 'Vijayawada', lat: 16.5062, lng: 80.6480 },
    { name: 'Kochi', lat: 9.9312, lng: 76.2673 },
    { name: 'Thiruvananthapuram', lat: 8.5241, lng: 76.9366 },
    { name: 'Kozhikode', lat: 11.2588, lng: 75.7804 },
    { name: 'Goa', lat: 15.2993, lng: 74.1240 },
    { name: 'Panaji', lat: 15.4909, lng: 73.8278 },
    { name: 'Bhubaneswar', lat: 20.2961, lng: 85.8245 },
    { name: 'Cuttack', lat: 20.4625, lng: 85.8828 },
    { name: 'Guwahati', lat: 26.1445, lng: 91.7362 },
    { name: 'Shillong', lat: 25.5788, lng: 91.8933 },
    { name: 'Agartala', lat: 23.8315, lng: 91.2868 },
    { name: 'Imphal', lat: 24.8170, lng: 93.9368 },
    { name: 'Aizawl', lat: 23.7271, lng: 92.7173 },
    { name: 'Kohima', lat: 25.6751, lng: 94.1086 },
    { name: 'Itanagar', lat: 27.0844, lng: 93.6053 },
    { name: 'Gangtok', lat: 27.3389, lng: 88.6065 },
    { name: 'Shimla', lat: 31.1048, lng: 77.1734 },
    { name: 'Chandigarh', lat: 30.7333, lng: 76.7794 },
    { name: 'Amritsar', lat: 31.6340, lng: 74.8723 },
    { name: 'Ludhiana', lat: 30.9010, lng: 75.8573 },
    { name: 'Jammu', lat: 32.7266, lng: 74.8570 },
    { name: 'Srinagar', lat: 34.0837, lng: 74.7973 },
    { name: 'Dehradun', lat: 30.3165, lng: 78.0322 },
    { name: 'Ranchi', lat: 23.3441, lng: 85.3096 },
    { name: 'Raipur', lat: 21.2514, lng: 81.6296 },
    { name: 'Bhubaneswar', lat: 20.2961, lng: 85.8245 },
    { name: 'Puducherry', lat: 11.9416, lng: 79.8083 },
    { name: 'Port Blair', lat: 11.6234, lng: 92.7265 },
    { name: 'Kavaratti', lat: 10.5667, lng: 72.6417 },
    { name: 'Diu', lat: 20.7174, lng: 70.9824 },
    { name: 'Silvassa', lat: 20.2749, lng: 72.9967 },
    { name: 'Kandla', lat: 23.0333, lng: 70.2167 },
    { name: 'Mangaluru', lat: 12.9141, lng: 74.8560 },
    { name: 'Tiruchirappalli', lat: 10.7905, lng: 78.7047 },
    { name: 'Madurai', lat: 9.9252, lng: 78.1198 },
    { name: 'Meerut', lat: 28.9845, lng: 77.7064 },
    { name: 'Varanasi', lat: 25.3176, lng: 82.9739 },
    { name: 'Agra', lat: 27.1767, lng: 78.0081 },
    { name: 'Allahabad', lat: 25.4358, lng: 81.8463 },
    { name: 'Saharanpur', lat: 29.9680, lng: 77.5458 },
    { name: 'Aligarh', lat: 27.8974, lng: 78.0880 }
];

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function reverseGeocodeNearestCity(lat, lng) {
    if (lat == null || lng == null) return null;
    let best = null;
    let bestDist = Infinity;
    for (const p of INDIAN_PLACES) {
        const d = haversineKm(lat, lng, p.lat, p.lng);
        if (d < bestDist) {
            bestDist = d;
            best = p;
        }
    }
    if (!best) return null;
    return {
        name: best.name,
        distanceKm: bestDist,
        lat,
        lng
    };
}

function normalizeReport(report) {
    const lat = report.latitude ?? report.coordinates?.lat ?? null;
    const lng = report.longitude ?? report.coordinates?.lng ?? null;
    const timestamp = parseServerDate(report.createdAt || report.timestamp);

    return {
        id: report.id,
        type: report.disasterType || report.type,
        severity: report.severity,
        location: report.location,
        description: report.description,
        reporter: report.reporter,
        trustScore: report.trustScore,
        verified: report.verified || report.verificationStatus === 'verified',
        verificationStatus: report.verificationStatus || (report.verified ? 'verified' : 'pending'),
        incidentStatus: report.incidentStatus || 'active',
        latitude: lat,
        longitude: lng,
        coordinates: lat != null && lng != null ? [lat, lng] : null,
        timestamp
    };
}

function toggleLogoMenu() {
    event.stopPropagation();

    const menu = document.getElementById('logoMenu');
    menu.classList.toggle('show');
}

function showSafetyTips() {
    showTab('safety');
}

function showTab(tabName) {
    if (!requireRole(tabName)) {
        showNotification('Access Denied. You do not have permission to view this section.', 'error');
        return;
    }

    document.querySelectorAll('.content').forEach(content => {
        content.classList.remove('active');
    });

    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });

    document.getElementById(tabName).classList.add('active');

    const activeTab = document.querySelector(`[onclick="showTab('${tabName}')"]`);

    if (activeTab) {
        activeTab.classList.add('active');
    }

    if (tabName === 'sos' && activeTab) {
        activeTab.classList.add('sos-tab');
    }

    if (tabName === 'sos') {
        if (!sosActive || (currentSosIncident && currentSosIncident.status !== 'RESOLVED')) {
            restoreSosFromStorage();
        }
    }

    if (tabName === 'map' && map) {
        setTimeout(() => map.invalidateSize(), 100);
    }

    if (tabName === 'dashboard') {
        loadDashboardStats();
        loadAuthoritySosList();
        stopDashboardSosPolling();
        dashboardSosPollIntervalId = setInterval(() => {
            loadAuthoritySosList(true);
            loadDashboardStats(true);
        }, 5000);
    } else {
        stopDashboardSosPolling();
    }
}

function initializeMap() {
    map = L.map('mapContainer').setView([20.5937, 78.9629], 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const legend = L.control({
        position: 'bottomright'
    });

    legend.onAdd = function () {
        const div = L.DomUtil.create('div', 'info legend');

        div.style.background = 'rgba(255,255,255,0.9)';
        div.style.padding = '10px';
        div.style.borderRadius = '8px';
        div.style.fontSize = '12px';

        div.innerHTML = `
            <h4 style="margin: 0 0 5px 0; color: #333;">Risk Levels</h4>
            <div style="color: #333;">
                <i style="background: red; width: 12px; height: 12px; display: inline-block; border-radius: 50%; margin-right: 5px;"></i>High Risk<br>
                <i style="background: orange; width: 12px; height: 12px; display: inline-block; border-radius: 50%; margin-right: 5px;"></i>Medium Risk<br>
                <i style="background: green; width: 12px; height: 12px; display: inline-block; border-radius: 50%; margin-right: 5px;"></i>Low Risk<br>
            </div>
        `;

        return div;
    };

    legend.addTo(map);
}

function clearMapMarkers() {
    mapMarkers.forEach((marker) => map.removeLayer(marker));
    mapMarkers = [];
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function refreshMapMarkers() {
    if (!map) return;

    clearMapMarkers();

    const sevFilter = document.getElementById('mapSeverityFilter')?.value || 'all';
    const typeFilter = document.getElementById('mapHazardTypeFilter')?.value || 'all';

    // 1. Filter only active, non-historical, valid coordinate reports
    const activeReports = reports.filter((report) => {
        if (!report.coordinates || !Array.isArray(report.coordinates)) return false;
        const [lat, lng] = report.coordinates;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
        if (isTestNoiseReport(report)) return false;
        if (report.isHistorical) return false;
        if (report.sourceType && String(report.sourceType).startsWith('HISTORICAL_')) return false;
        if (report.incidentStatus === 'archived') return false;

        if (sevFilter !== 'all' && report.severity !== sevFilter) return false;
        if (typeFilter !== 'all') {
            const t = String(report.type || report.disasterType || '').toLowerCase();
            if (!t.includes(typeFilter.toLowerCase())) return false;
        }
        return true;
    });

    // 2. Spatial clustering: group points within 30km into consolidated representative clusters
    const clusters = [];
    const CLUSTER_RADIUS_KM = 30;

    for (const report of activeReports) {
        const [lat, lng] = report.coordinates;
        let matchedCluster = null;

        for (const c of clusters) {
            const dist = calculateDistanceKm(lat, lng, c.latitude, c.longitude);
            if (dist <= CLUSTER_RADIUS_KM) {
                matchedCluster = c;
                break;
            }
        }

        if (matchedCluster) {
            matchedCluster.reports.push(report);
            if (report.severity === 'high') matchedCluster.severity = 'high';
            else if (report.severity === 'medium' && matchedCluster.severity !== 'high') matchedCluster.severity = 'medium';
        } else {
            clusters.push({
                latitude: lat,
                longitude: lng,
                location: report.location,
                type: report.type || report.disasterType || 'Hazard',
                severity: report.severity || 'medium',
                reports: [report]
            });
        }
    }

    // 3. Render consolidated cluster markers
    clusters.forEach((cluster) => {
        const isHigh = cluster.severity === 'high';
        const isMedium = cluster.severity === 'medium';
        const color = isHigh ? '#e63946' : isMedium ? '#f39c12' : '#2ecc71';
        const markerSize = isHigh ? 16 : isMedium ? 13 : 10;
        const count = cluster.reports.length;

        const circle = L.circleMarker([cluster.latitude, cluster.longitude], {
            color: '#ffffff',
            fillColor: color,
            fillOpacity: 0.9,
            radius: markerSize,
            weight: 2
        }).addTo(map);

        const primaryReport = cluster.reports[0];
        const countBadge = count > 1 ? `<span style="background:rgba(255,255,255,0.25); padding:2px 6px; border-radius:4px; font-size:0.75rem; margin-left:6px;">${count} reports</span>` : '';

        circle.bindPopup(`
            <div style="font-family: inherit; line-height: 1.4; min-width: 220px;">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                    <span style="font-weight:700; color:${color}; text-transform:uppercase; font-size:0.85rem;">
                        ${cluster.severity.toUpperCase()} RISK ${countBadge}
                    </span>
                    <span style="font-size:0.75rem; color:#888;">${primaryReport.timestamp ? primaryReport.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                </div>
                <h4 style="margin: 0 0 6px 0; color:#1a1a1a;">${escapeHtml(hazardBadgeLabel(primaryReport))}</h4>
                <p style="margin: 0 0 4px 0; font-size:0.85rem;"><strong>Location:</strong> ${escapeHtml(cluster.location || 'Active Hazard Area')}</p>
                <p style="margin: 0 0 6px 0; font-size:0.85rem; color:#444;">${escapeHtml(primaryReport.description || 'Active incident in this region.')}</p>
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; border-top:1px solid #eee; padding-top:6px; margin-top:6px;">
                    <span style="color:#555;">Reporter: ${escapeHtml(displayReporterName(primaryReport))}</span>
                    <span style="color:${primaryReport.verified ? '#27ae60' : '#f39c12'}; font-weight:600;">
                        ${primaryReport.verified ? '✓ Verified' : '⚠ Active'}
                    </span>
                </div>
            </div>
        `);

        mapMarkers.push(circle);
    });

    // 4. Render verified social signals (if active and matches filter)
    let socialCount = 0;
    if (typeof socialSignals !== 'undefined' && (sevFilter === 'all' || sevFilter === 'medium' || sevFilter === 'high')) {
        socialSignals.filter(s => s.status === 'VERIFIED' && s.latitude && s.longitude).forEach(signal => {
            const marker = L.circleMarker([signal.latitude, signal.longitude], {
                color: '#9b59b6',
                fillColor: '#8e44ad',
                fillOpacity: 0.85,
                radius: 12,
                weight: 2
            }).addTo(map);

            marker.bindPopup(`
                <div style="min-width: 200px;">
                    <div style="background: #9b59b6; color: white; padding: 4px 8px; border-radius: 4px; display: inline-block; font-size: 0.8rem; font-weight: bold; margin-bottom: 8px;">
                        <i class="fab fa-twitter"></i> SOCIAL SIGNAL
                    </div>
                    <h4 style="margin:0 0 4px 0;">Potential ${escapeHtml(signal.hazard_type || 'Incident')}</h4>
                    <p style="margin:0 0 4px 0; font-size:0.85rem;"><strong>Confidence:</strong> ${signal.confidence_score}%</p>
                    <p style="margin:0 0 4px 0; font-size:0.85rem;"><strong>Location:</strong> ${escapeHtml(signal.location)}</p>
                    <p style="font-style: italic; font-size:0.85rem; margin:4px 0;">"${escapeHtml(signal.text)}"</p>
                    <div style="color: #27ae60; font-size:0.8rem; margin-top: 6px;">✓ Verified Incident</div>
                </div>
            `);

            mapMarkers.push(marker);
            socialCount++;
        });
    }

    // Update map counter badge
    const counterEl = document.getElementById('mapPointCounter');
    if (counterEl) {
        const totalPoints = clusters.length + socialCount;
        counterEl.innerHTML = `<i class="fas fa-dot-circle"></i> Active Hazards: ${totalPoints}`;
    }
}

function getCurrentLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function (position) {
                currentLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };

                const latStr = currentLocation.lat.toFixed(6);
                const lngStr = currentLocation.lng.toFixed(6);
                const lookup = reverseGeocodeNearestCity(currentLocation.lat, currentLocation.lng);

                document.getElementById('locationDisplay').style.display = 'block';

                if (lookup) {
                    document.getElementById('locationDisplay').innerHTML =
                        `📍 Current Location: <strong>${lookup.name}</strong> <span style="color:#bdc3c7;">(${latStr}, ${lngStr})</span>`;
                    document.getElementById('location').value = lookup.name;
                    showNotification(`Location captured: ${lookup.name}`);
                } else {
                    document.getElementById('locationDisplay').innerHTML =
                        `📍 Current Location: ${latStr}, ${lngStr}`;
                    document.getElementById('location').value =
                        `GPS: ${currentLocation.lat.toFixed(4)}, ${currentLocation.lng.toFixed(4)}`;
                    showNotification('Location captured successfully!');
                }
            },
            function (error) {
                showNotification(
                    'Error getting location: ' + error.message,
                    'error'
                );
            }
        );
    } else {
        showNotification(
            'Geolocation is not supported by this browser.',
            'error'
        );
    }
}

function selectSeverity(severity) {
    selectedSeverity = severity;

    document.querySelectorAll('.severity-option').forEach(option => {
        option.classList.remove('selected');
    });

    document
        .querySelector(`.severity-option.${severity}`)
        .classList.add('selected');
}

function setupFormHandlers() {
    document.getElementById('hazardForm').addEventListener('submit', function (e) {
        e.preventDefault();
        submitHazardReport();
    });

    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', handleFileSelection);
    }
}

let selectedFiles = [];

function handleFileSelection(e) {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
        if (selectedFiles.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) {
            return;
        }
        selectedFiles.push(file);
    });
    syncInputFiles();
    renderFilePreviews();
}

function syncInputFiles() {
    const fileInput = document.getElementById('fileInput');
    if (!fileInput) return;
    try {
        const dt = new DataTransfer();
        selectedFiles.forEach(f => dt.items.add(f));
        fileInput.files = dt.files;
    } catch (err) {
        // DataTransfer fallback: just rely on selectedFiles array
    }
}

function removeSelectedFile(index) {
    selectedFiles.splice(index, 1);
    syncInputFiles();
    renderFilePreviews();
}

function renderFilePreviews() {
    const container = document.getElementById('filePreviewContainer');
    if (!container) return;

    container.innerHTML = '';

    selectedFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-preview-item';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'file-preview-remove';
        removeBtn.type = 'button';
        removeBtn.innerHTML = '<i class="fas fa-times"></i>';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', () => removeSelectedFile(index));
        item.appendChild(removeBtn);

        if (file.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.alt = file.name;
            const reader = new FileReader();
            reader.onload = e => img.src = e.target.result;
            reader.readAsDataURL(file);
            item.appendChild(img);
        } else if (file.type.startsWith('video/')) {
            const vid = document.createElement('video');
            vid.muted = true;
            vid.playsInline = true;
            vid.preload = 'metadata';
            const reader = new FileReader();
            reader.onload = e => {
                vid.src = e.target.result;
                vid.addEventListener('loadeddata', () => {
                    try { vid.currentTime = 0.5; } catch (_) {}
                });
            };
            reader.readAsDataURL(file);
            item.appendChild(vid);
        } else {
            const iconBox = document.createElement('div');
            iconBox.className = 'file-preview-icon';
            iconBox.innerHTML = `
                <i class="fas fa-file-video"></i>
                <span>${(file.size / 1024 / 1024).toFixed(1)} MB</span>
            `;
            item.appendChild(iconBox);
        }

        const nameLabel = document.createElement('div');
        nameLabel.className = 'file-preview-name';
        nameLabel.textContent = file.name;
        item.appendChild(nameLabel);

        container.appendChild(item);
    });
}

function setReportFormStatus(message, type) {
    const statusEl = document.getElementById('reportFormStatus');
    if (!statusEl) return;

    statusEl.style.display = 'block';
    statusEl.textContent = message;

    if (type === 'error') {
        statusEl.style.color = '#e74c3c';
        statusEl.style.borderColor = 'rgba(231, 76, 60, 0.5)';
    } else if (type === 'success') {
        statusEl.style.color = '#27ae60';
        statusEl.style.borderColor = 'rgba(39, 174, 96, 0.5)';
    } else {
        statusEl.style.color = '#f4f4f4';
        statusEl.style.borderColor = 'rgba(0, 180, 216, 0.4)';
    }
}

function clearReportFormStatus() {
    const statusEl = document.getElementById('reportFormStatus');
    if (statusEl) {
        statusEl.style.display = 'none';
        statusEl.textContent = '';
    }
}

function setAiStatusBar(state, options = {}) {
    const bar = document.getElementById('aiVerificationStatusBar');
    if (!bar) return;
    bar.className = 'ai-status';
    bar.style.display = 'flex';

    const {
        topLabel = null,
        confidence = 0,
        matchState = null,
        verificationBonus = 0,
        model = null,
        message = null
    } = options;

    let icon = 'fa-robot';
    let title = message || '';
    let cls = 'ai-status-inconclusive';

    switch (state) {
        case 'analyzing':
            cls = 'ai-status-analyzing';
            icon = 'fa-spinner fa-spin';
            title = message || 'AI Analyzing evidence…';
            break;
        case 'consistent':
            cls = 'ai-status-consistent';
            icon = 'fa-check-circle';
            title = message || 'Evidence Consistent';
            break;
        case 'needs_human':
            cls = 'ai-status-human';
            icon = 'fa-user-shield';
            title = message || 'Needs Human Verification';
            break;
        case 'inconclusive':
            cls = 'ai-status-inconclusive';
            icon = 'fa-question-circle';
            title = message || 'Evidence Inconclusive';
            break;
        case 'none':
        default:
            bar.className = 'ai-status ai-status-none';
            bar.style.display = 'none';
            bar.innerHTML = '';
            return;
    }

    bar.classList.add(cls);

    let secondary = '';
    const parts = [];
    if (topLabel) parts.push(`Detected: ${topLabel}`);
    if (typeof confidence === 'number' && confidence > 0) parts.push(`Confidence: ${Math.round(confidence * 100)}%`);
    if (matchState) parts.push(`Match: ${matchState}`);
    if (typeof verificationBonus === 'number' && verificationBonus > 0) parts.push(`+${verificationBonus} trust`);
    if (model) parts.push(`${model.provider || ''} ${model.name || ''}`.trim());
    if (parts.length) secondary = `<div class="ai-status-secondary">${parts.join(' • ')}</div>`;

    bar.innerHTML = `<i class="fas ${icon}"></i><div><strong>${title}</strong></div>${secondary}`;
}

function aiStateBadgeFor(report) {
    const state = report.aiVerificationState || 'none';
    if (!state || state === 'none') return '';

    let text = 'AI Inconclusive';
    let icon = 'fa-question-circle';
    let cls = 'inconclusive';

    switch (state) {
        case 'analyzing':
            text = 'AI Analyzing';
            icon = 'fa-spinner fa-spin';
            cls = 'analyzing';
            break;
        case 'consistent':
            text = 'Evidence Consistent';
            icon = 'fa-check-circle';
            cls = 'consistent';
            break;
        case 'needs_human':
            text = 'Needs Human Verification';
            icon = 'fa-user-shield';
            cls = 'needs_human';
            break;
        case 'inconclusive':
            text = 'Evidence Inconclusive';
            icon = 'fa-question-circle';
            cls = 'inconclusive';
            break;
        default:
            return '';
    }

    const conf = typeof report.aiConfidence === 'number' && report.aiConfidence > 0
        ? ` ${Math.round(report.aiConfidence * 100)}%`
        : '';

    return `<span class="ai-card-badge ${cls}"><i class="fas ${icon}"></i>${text}${conf}</span>`;
}

function clearAiStatusBar() {
    setAiStatusBar('none');
}

async function submitHazardReport() {
    const submitBtn = document.getElementById('submitReportBtn');

    const disasterType = document.getElementById('hazardType').value;
    const location = document.getElementById('location').value;
    const severity = selectedSeverity;
    const description = document.getElementById('description').value;
    const userId = currentUserId || undefined;
    const latitude = currentLocation ? currentLocation.lat : null;
    const longitude = currentLocation ? currentLocation.lng : null;

    if (!disasterType || !location || !severity || !description) {
        setReportFormStatus('Please fill in all required fields (including severity).', 'error');
        showNotification('Please fill in all required fields', 'error');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    }

    setReportFormStatus('Submitting report to server...', 'loading');
    clearAiStatusBar();

    const hasEvidence = Array.isArray(selectedFiles) && selectedFiles.length > 0;
    if (hasEvidence) {
        setAiStatusBar('analyzing');
    }

    try {
        const fd = new FormData();
        fd.append('disasterType', disasterType);
        fd.append('location', location);
        fd.append('severity', severity);
        fd.append('description', description);
        if (userId) fd.append('userId', userId);
        if (latitude != null) fd.append('latitude', String(latitude));
        if (longitude != null) fd.append('longitude', String(longitude));
        if (hasEvidence) {
            for (const f of selectedFiles) {
                fd.append('evidence', f, f.name || 'upload');
            }
        }

        const response = await fetch(`${API_BASE}/api/reports`, {
            method: 'POST',
            body: fd
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to submit report');
        }

        if (data.report && data.report.trustScore != null) {
            userTrustScore = data.report.trustScore;
            document.querySelector('.trust-score').innerHTML =
                `<i class="fas fa-star"></i> Trust Score: ${userTrustScore}`;
        }

        let successTrustMsg = '+2 Trust Points';
        if (data.aiVerification && typeof data.aiVerification.verificationBonus === 'number' && data.aiVerification.verificationBonus > 0) {
            successTrustMsg = `+${2 + data.aiVerification.verificationBonus} Trust Points`;
        }

        document.getElementById('hazardForm').reset();
        selectedSeverity = null;
        currentLocation = null;
        selectedFiles = [];
        syncInputFiles();
        renderFilePreviews();

        document.querySelectorAll('.severity-option').forEach(option => {
            option.classList.remove('selected');
        });

        document.getElementById('locationDisplay').style.display = 'none';

        setReportFormStatus(
            `Report saved (ID: ${data.report.id}). ${successTrustMsg}`,
            'success'
        );

        const ai = data.aiVerification;
        if (ai && ai.state && ai.state !== 'none') {
            setAiStatusBar(ai.state, {
                topLabel: ai.topLabel,
                confidence: ai.topConfidence,
                matchState: ai.matchState,
                verificationBonus: ai.verificationBonus,
                model: ai.model,
                message: ai.state === 'consistent'
                    ? 'Evidence matches your report type.'
                    : ai.state === 'needs_human'
                        ? 'Evidence does not clearly match — flagged for review.'
                        : ai.state === 'inconclusive'
                            ? 'AI could not classify the evidence.'
                            : undefined
            });

            if (ai.state === 'needs_human') {
                showNotification('⚠ Report flagged for human verification', 'error');
            } else if (ai.state === 'consistent') {
                showNotification(`Evidence Consistent. ${successTrustMsg}`);
            } else {
                showNotification(`Disaster report submitted successfully! ${successTrustMsg}`);
            }
        } else if (hasEvidence) {
            setAiStatusBar('inconclusive', { message: 'Evidence Inconclusive' });
            showNotification('Disaster report submitted successfully! ' + successTrustMsg);
        } else {
            clearAiStatusBar();
            showNotification('Disaster report submitted successfully! ' + successTrustMsg);
        }

        await loadDashboardStats();
        showTab('map');
    } catch (error) {
        console.error(error);
        clearAiStatusBar();
        setReportFormStatus(error.message || 'Failed to submit report', 'error');
        showNotification(error.message || 'Failed to submit report', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Report';
        }
    }
}

function isTestNoiseReport(report) {
    const loc = String(report.location || '').toLowerCase();
    const desc = String(report.description || '').toLowerCase();
    const typ = String(report.type || '').toLowerCase();

    if (typ === 'flood' && desc === 'very high flooding save me') return true;
    if (desc.includes('hehehehe')) return true;
    if (loc.includes('28.5693') && loc.includes('77.3828')) return true;
    if (/testcity|diagnostic|exactflow|debugtest|finaltest/.test(loc.replace(/\s+/g, ''))) return true;
    if (desc.includes('diagnostic test') || desc.includes('fk debug') || desc.includes('testing exact route')) return true;
    if (desc === 'very severe fire test' || desc === 'fk diagnostic test') return true;
    return false;
}

function reportCardPriority(report) {
    const desc = String(report.description || '');
    if (desc.includes('Monsoon flooding in low-lying areas of Mumbai')) return 1;
    if (desc.includes('Tsunami warning issued for coastal areas of Tamil Nadu')) return 2;
    if (desc.includes('Tropical cyclone approaching Odisha coastline')) return 3;
    if (desc.includes('Waterlogging reported near Marina Beach')) return 4;
    return 50;
}

function hazardBadgeLabel(report) {
    const desc = String(report.description || '').toLowerCase();
    const type = String(report.type || '').toLowerCase();
    if (desc.includes('tsunami') || type === 'tsunami') return 'TSUNAMI';
    if (desc.includes('cyclone') || type === 'cyclone') return 'CYCLONE';
    if (type === 'storm') return 'STORM';
    return String(report.type || 'HAZARD').replace(/-/g, ' ').toUpperCase();
}

function displayReporterName(report) {
    const name = String(report.reporter || '').trim();
    if (!name || name === 'CurrentUser' || name === 'Current User') {
        return 'Current User';
    }
    return name;
}

function populateRecentReports() {
    const container = document.getElementById('recentReports');

    if (!reports.length) {
        container.innerHTML = `
            <div class="report-card" style="grid-column: 1 / -1; text-align: center;">
                No disaster reports in the database yet.
            </div>
        `;
        return;
    }

    const allReports = [...reports]
        .filter((r) => !isTestNoiseReport(r))
        .sort((a, b) => reportCardPriority(a) - reportCardPriority(b) || b.timestamp - a.timestamp);

    container.innerHTML = allReports
        .slice(0, 4)
        .map(report => `
            <div class="report-card ${report.severity === 'critical' ? 'critical' : report.severity}">
                <div class="report-header">
                    <span class="hazard-type">
                        ${hazardBadgeLabel(report)}
                    </span>

                    <span class="timestamp">
                        ${report.timestamp.toLocaleString()}
                    </span>
                </div>

                <h4>${report.location}</h4>

                <p>${report.description}</p>

                <div style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
                    <span>By: ${displayReporterName(report)}</span>

                    <span style="display: flex; align-items: center; gap: 10px;">
                        ${
                            report.verified
                                ? `<span style="color: #27ae60;"><i class="fas fa-check-circle"></i> Verified Trust: ${report.trustScore}%</span>`
                                : `<span style="color: #f1c40f;"><i class="fas fa-clock"></i> Pending</span>`
                        }
                    </span>
                </div>
            </div>
        `)
        .join('');
}

async function fetchSocialSignals() {
    try {
        const response = await fetch(`${API_BASE}/api/social/signals`);
        const data = await response.json();
        
        if (data.success) {
            socialSignals = data.signals;
            
            // Update banner based on provider and simulated status
            const hasSimulated = socialSignals.some(s => s.simulated);
            const demoBanner = document.getElementById('socialDemoBanner');
            if (demoBanner) {
                if (data.provider === 'x' && !hasSimulated) {
                    demoBanner.style.display = 'block';
                    demoBanner.style.background = '#2ecc71';
                    demoBanner.innerHTML = '<i class="fas fa-satellite-dish"></i> LIVE X DATA • OFFICIAL API';
                } else {
                    demoBanner.style.display = 'block';
                    demoBanner.style.background = '#f39c12';
                    demoBanner.innerHTML = '<i class="fas fa-flask"></i> DEMO MODE • SIMULATED SOCIAL DATA';
                }
            }
            
            // Update stats
            document.getElementById('statSocialTotal').textContent = socialSignals.length;
            document.getElementById('statSocialNew').textContent = socialSignals.filter(s => s.status === 'NEW').length;
            document.getElementById('statSocialReview').textContent = socialSignals.filter(s => s.status === 'UNDER REVIEW').length;
            document.getElementById('statSocialVerified').textContent = socialSignals.filter(s => s.status === 'VERIFIED').length;
            
            renderSocialSignals();
            
            // Re-render map to include verified social signals if needed
            refreshMapMarkers();
        }
    } catch (e) {
        console.error('Failed to fetch social signals:', e);
        document.getElementById('socialFeedContainer').innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #e74c3c;">Failed to load social intelligence data.</div>';
    }
}

function renderSocialSignals() {
    const container = document.getElementById('socialFeedContainer');
    if (!container) return;
    
    const statusFilter = document.getElementById('filterSocialStatus').value;
    const hazardFilter = document.getElementById('filterSocialHazard').value;
    
    let filtered = socialSignals.filter(s => {
        if (statusFilter !== 'ALL' && s.status !== statusFilter) return false;
        if (hazardFilter !== 'ALL' && s.hazard_type.toLowerCase() !== hazardFilter.toLowerCase()) return false;
        return true;
    });
    
    if (filtered.length === 0) {
        container.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #bdc3c7;">No signals found matching filters.</div>';
        return;
    }
    
    const role = localStorage.getItem('coastwatchRole');
    const isAdmin = role === 'ADMIN';

    container.innerHTML = filtered.map(signal => {
        let statusColor = '#bdc3c7';
        if (signal.status === 'NEW') statusColor = '#3498db';
        if (signal.status === 'UNDER REVIEW') statusColor = '#f39c12';
        if (signal.status === 'VERIFIED') statusColor = '#2ecc71';
        if (signal.status === 'DISMISSED') statusColor = '#e74c3c';
        
        let actionsHtml = '';
        if (isAdmin) {
            actionsHtml = `
                <div style="display: flex; gap: 10px; margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
                    ${signal.status === 'NEW' ? `<button onclick="handleSocialAction('${signal.id}', 'review')" style="flex: 1; background: #f39c12; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Review</button>` : ''}
                    ${signal.status !== 'VERIFIED' ? `<button onclick="handleSocialAction('${signal.id}', 'verify')" style="flex: 1; background: #2ecc71; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Verify</button>` : ''}
                    ${signal.status !== 'DISMISSED' ? `<button onclick="handleSocialAction('${signal.id}', 'dismiss')" style="flex: 1; background: #e74c3c; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Dismiss</button>` : ''}
                </div>
            `;
        }

        return `
            <div class="report-form" style="background: rgba(255,255,255,0.05); padding: 15px; border: 1px solid rgba(255,255,255,0.1); position: relative;">
                <div style="position: absolute; top: 15px; right: 15px; background: ${statusColor}; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold;">
                    ${signal.status}
                </div>
                <div style="margin-bottom: 10px; display: flex; align-items: center; gap: 10px;">
                    <i class="fab fa-${signal.source.toLowerCase() === 'x' ? 'twitter' : 'twitter'}" style="color: #1DA1F2; font-size: 1.2rem;"></i>
                    <strong>${signal.author || 'Unknown User'}</strong>
                    <span style="color: #bdc3c7; font-size: 0.85rem;">${new Date(signal.timestamp).toLocaleString()}</span>
                </div>
                <p style="margin-bottom: 15px; font-size: 0.95rem; line-height: 1.5;">"${signal.text}"</p>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 0.9rem; background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px;">
                    <div><i class="fas fa-exclamation-triangle" style="color: #f39c12;"></i> Hazard: <strong style="text-transform: capitalize;">${signal.hazard_type}</strong></div>
                    <div><i class="fas fa-map-marker-alt" style="color: #e74c3c;"></i> Location: <strong>${signal.location}</strong></div>
                    <div><i class="fas fa-tachometer-alt" style="color: ${signal.confidence_score > 75 ? '#2ecc71' : '#f39c12'};"></i> Confidence: <strong>${signal.confidence_score}%</strong></div>
                    <div><i class="fas fa-users" style="color: #3498db;"></i> Corroboration: <strong>${signal.corroboration_count} reports</strong></div>
                </div>
                
                ${actionsHtml}
            </div>
        `;
    }).join('');
}

async function handleSocialAction(id, action) {
    const role = localStorage.getItem('coastwatchRole');
    if (role !== 'ADMIN') {
        showNotification('Access Denied. Only Administrators can verify or dismiss signals.', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/social/signals/${id}/${action}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Role': role
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification(`Signal successfully marked as ${data.status}`, 'success');
            fetchSocialSignals();
        } else {
            showNotification(data.error || 'Failed to perform action', 'error');
        }
    } catch (e) {
        console.error('Error in handleSocialAction:', e);
        showNotification('Network error while processing action', 'error');
    }
}

function broadcastAlert() {
    const alertType =
        document.getElementById('alertType').value;

    const alertRadius =
        document.getElementById('alertRadius').value;

    const alertMessage =
        document.getElementById('alertMessage').value;

    if (!alertMessage.trim()) {
        showNotification(
            'Please enter an alert message',
            'error'
        );

        return;
    }

    showNotification(
        `${alertType.toUpperCase()} alert broadcasted to ${alertRadius}km radius`,
        'success'
    );

    document.getElementById('alertMessage').value = '';
}

function showNotification(message, type = 'success') {
    const notification =
        document.getElementById('notification');

    notification.textContent = message;

    notification.className =
        `notification ${type === 'error' ? 'error' : ''}`;

    notification.classList.add('show');

    setTimeout(() => {
        notification.classList.remove('show');
    }, 3000);
}

function getSosGpsLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            resolve({ available: false, error: 'Geolocation not supported by this browser.' });
            return;
        }
        const timeoutId = setTimeout(() => {
            resolve({ available: false, error: 'GPS timed out. Permission may be denied or signal unavailable.' });
        }, 8000);

        navigator.geolocation.getCurrentPosition(
            (position) => {
                clearTimeout(timeoutId);
                resolve({
                    available: true,
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                    accuracy: position.coords.accuracy
                });
            },
            (error) => {
                clearTimeout(timeoutId);
                let message = 'GPS permission denied or unavailable.';
                switch (error.code) {
                    case error.PERMISSION_DENIED:
                        message = 'GPS permission was denied. You can still activate SOS — authorities will contact you for your location.';
                        break;
                    case error.POSITION_UNAVAILABLE:
                        message = 'Your location is currently unavailable (no GPS signal).';
                        break;
                    case error.TIMEOUT:
                        message = 'GPS request timed out. Try again in an open area if possible.';
                        break;
                }
                resolve({ available: false, error: message });
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
    });
}

function sosStatusBadgeHTML(status) {
    const palette = {
        PENDING: { color: '#f07167', bg: 'rgba(240, 113, 103, 0.14)', border: 'rgba(240, 113, 103, 0.45)', icon: SOS_STATUS_ICON.PENDING },
        ACKNOWLEDGED: { color: '#48cae4', bg: 'rgba(72, 202, 228, 0.12)', border: 'rgba(72, 202, 228, 0.45)', icon: SOS_STATUS_ICON.ACKNOWLEDGED },
        IN_PROGRESS: { color: '#7dc4ff', bg: 'rgba(125, 196, 255, 0.12)', border: 'rgba(125, 196, 255, 0.45)', icon: SOS_STATUS_ICON.IN_PROGRESS },
        RESCUE_ASSIGNED: { color: '#b388eb', bg: 'rgba(179, 136, 235, 0.12)', border: 'rgba(179, 136, 235, 0.45)', icon: SOS_STATUS_ICON.RESCUE_ASSIGNED },
        RESOLVED: { color: '#48cae4', bg: 'rgba(72, 202, 228, 0.12)', border: 'rgba(72, 202, 228, 0.45)', icon: SOS_STATUS_ICON.RESOLVED }
    };
    const cfg = palette[status] || palette.PENDING;
    return `
        <span style="display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;background:${cfg.bg};border:1.5px solid ${cfg.border};color:${cfg.color};font-weight:bold;font-size:0.9rem;">
            <i class="fas ${cfg.icon}"></i> ${SOS_STATUS_LABEL[status] || status}
        </span>
    `;
}

function renderSosTimeline(incident) {
    const currentIndex = SOS_STATUS_ORDER.indexOf(incident.status);
    const timestampField = {
        PENDING: 'createdAt',
        ACKNOWLEDGED: 'acknowledgedAt',
        IN_PROGRESS: 'responseAt',
        RESCUE_ASSIGNED: 'assignedAt',
        RESOLVED: 'resolvedAt'
    };

    const container = document.getElementById('sosTimeline');
    if (!container) return;

    container.innerHTML = SOS_STATUS_ORDER.map((status, idx) => {
        const stateClass = idx < currentIndex ? 'done'
            : idx === currentIndex ? 'current'
            : 'pending';
        const tsValue = incident[timestampField[status]];
        const tsText = tsValue
            ? `<span class="sos-timeline-time"><i class="fas fa-clock"></i> ${parseServerDate(tsValue).toLocaleString()}</span>`
            : idx === currentIndex
                ? `<span class="sos-timeline-time"><i class="fas fa-spinner fa-spin"></i> In progress…</span>`
                : '';
        const noteText = (idx <= currentIndex && SOS_STATUS_NOTE[status])
            ? `<div class="sos-timeline-note">${SOS_STATUS_NOTE[status]}</div>`
            : '';
        return `
            <div class="sos-timeline-step ${stateClass}">
                <div class="sos-timeline-icon">
                    <i class="fas ${idx < currentIndex ? 'fa-check' : SOS_STATUS_ICON[status]}"></i>
                </div>
                <div class="sos-timeline-content">
                    <div class="sos-timeline-title">
                        <span>Step ${idx + 1} · ${SOS_STATUS_LABEL[status]}</span>
                        ${tsText}
                    </div>
                    ${noteText}
                </div>
            </div>
        `;
    }).join('');
}

function updateSosDisplay(incident) {
    if (!incident) return;
    currentSosIncident = incident;

    try {
        localStorage.setItem('coastwatch_sos_active_id', incident.id || '');
    } catch (_) { }

    const idBlock = document.getElementById('sosIdBlock');
    const idText = document.getElementById('sosIdText');
    const tsText = document.getElementById('sosTimestamp');
    if (idBlock && idText) {
        idBlock.style.display = 'block';
        idText.textContent = incident.sosShortId || incident.id;
    }
    if (tsText && incident.createdAt) {
        tsText.innerHTML = `<i class="fas fa-clock"></i> Activated: ${parseServerDate(incident.createdAt).toLocaleString()}`;
    }

    const locBlock = document.getElementById('sosLocationBlock');
    if (locBlock) {
        if (incident.locationAvailable && typeof incident.latitude === 'number') {
            const lookup = reverseGeocodeNearestCity(incident.latitude, incident.longitude);
            const latStr = incident.latitude.toFixed(6);
            const lngStr = incident.longitude.toFixed(6);
            locBlock.style.display = 'block';
            locBlock.style.background = 'rgba(72, 202, 228, 0.08)';
            locBlock.style.border = '1px solid rgba(72, 202, 228, 0.35)';
            locBlock.innerHTML = `
                <div style="font-size:0.8rem;color:#48cae4;margin-bottom:3px;"><i class="fas fa-map-marker-alt"></i> Location Captured</div>
                <div style="color:#e8eef7;font-size:0.92rem;font-weight:600;">
                    ${lookup ? `Near <strong>${lookup.name}</strong> (≈${lookup.distanceKm.toFixed(1)} km)` : 'Coordinates captured'}
                </div>
                <div style="font-size:0.75rem;color:#a9c6de;margin-top:2px;font-family:monospace;">
                    ${latStr}, ${lngStr}
                    ${typeof incident.accuracy === 'number' ? ` · accuracy ±${Math.round(incident.accuracy)}m` : ''}
                </div>
                <a href="https://www.google.com/maps?q=${encodeURIComponent(incident.latitude + ',' + incident.longitude)}"
                   target="_blank" rel="noopener noreferrer"
                   style="display:inline-block;margin-top:6px;font-size:0.78rem;color:#48cae4;text-decoration:underline;">
                    <i class="fas fa-external-link-alt"></i> Open in Google Maps
                </a>
            `;
        } else {
            locBlock.style.display = 'block';
            locBlock.style.background = 'rgba(240, 113, 103, 0.10)';
            locBlock.style.border = '1px solid rgba(240, 113, 103, 0.4)';
            locBlock.innerHTML = `
                <div style="font-size:0.8rem;color:#f07167;margin-bottom:3px;"><i class="fas fa-exclamation-triangle"></i> Location Unavailable</div>
                <div style="color:#e8eef7;font-size:0.92rem;">
                    GPS could not be captured. Authorities will call you for your exact location. If possible, call <strong><a href="tel:112" style="color:#48cae4;">112</a></strong> and share your position.
                </div>
            `;
        }
    }

    const statusBadgeEl = document.getElementById('sosCurrentStatusBadge');
    if (statusBadgeEl) {
        statusBadgeEl.style.display = 'block';
        statusBadgeEl.innerHTML = sosStatusBadgeHTML(incident.status);
    }

    renderSosTimeline(incident);

    const notesBlock = document.getElementById('sosNotesBlock');
    const notesText = document.getElementById('sosNotesText');
    if (notesBlock && notesText && incident.notes && incident.notes.trim()) {
        notesBlock.style.display = 'block';
        notesText.textContent = incident.notes;
    } else if (notesBlock) {
        notesBlock.style.display = 'none';
    }

    const warnBlock = document.getElementById('sosWarningBlock');
    const warnText = document.getElementById('sosWarningText');
    if (warnBlock && warnText) {
        if (!incident.locationAvailable) {
            warnBlock.style.display = 'block';
            warnText.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <strong>Location not shared.</strong> When authorities call, please state your exact location, nearest landmark, and any visible crossroads or buildings.`;
        } else if (incident.status === 'PENDING') {
            warnBlock.style.display = 'block';
            warnText.innerHTML = `<i class="fas fa-info-circle" style="color:#48cae4;"></i> <strong style="color:#48cae4;">Waiting for authority acknowledgment.</strong> This step confirms an operator has seen your SOS. The system automatically refreshes every few seconds.`;
        } else {
            warnBlock.style.display = 'none';
        }
    }

    if (incident.status === 'RESOLVED') {
        stopSosPolling();
        try { localStorage.removeItem('coastwatch_sos_active_id'); } catch (_) { }
    }
}

function stopSosPolling() {
    if (sosPollIntervalId) {
        clearInterval(sosPollIntervalId);
        sosPollIntervalId = null;
    }
}

async function pollSosStatus() {
    if (!currentSosIncident || !currentSosIncident.id) return;
    try {
        const response = await fetch(`${API_BASE}/api/sos/${encodeURIComponent(currentSosIncident.id)}`);
        const data = await response.json();
        if (response.ok && data.success && data.incident) {
            updateSosDisplay(data.incident);
        }
    } catch (err) {
        console.warn('SOS poll failed:', err);
    }
}

async function triggerSOS() {
    if (sosActive && currentSosIncident && currentSosIncident.status !== 'RESOLVED') {
        showNotification('SOS already active! Help is on the way. Status is being refreshed.', 'warning');
        return;
    }

    sosActive = true;
    currentSosIncident = null;

    const statusEl = document.getElementById('sosStatus');
    if (statusEl) statusEl.style.display = 'block';

    const timelineEl = document.getElementById('sosTimeline');
    if (timelineEl) {
        timelineEl.innerHTML = `
            <div class="sos-timeline-step current">
                <div class="sos-timeline-icon"><i class="fas fa-spinner fa-spin"></i></div>
                <div class="sos-timeline-content">
                    <div class="sos-timeline-title"><span>Capturing location and registering SOS…</span></div>
                    <div class="sos-timeline-note">Requesting GPS permission and connecting to emergency server.</div>
                </div>
            </div>
        `;
    }

    const sosButton = document.getElementById('sosButton');
    if (sosButton) {
        sosButton.innerHTML = `
            <i class="fas fa-satellite-dish"
               style="font-size: 3rem; margin-bottom: 10px; animation: spin 2s linear infinite;">
            </i>
            <div>REGISTERING…</div>
            <div style="font-size: 1rem; margin-top: 5px;">
                PLEASE WAIT
            </div>
        `;
    }

    let idBlock = document.getElementById('sosIdBlock');
    let locBlock = document.getElementById('sosLocationBlock');
    let badgeEl = document.getElementById('sosCurrentStatusBadge');
    let warnBlock = document.getElementById('sosWarningBlock');
    let notesBlock = document.getElementById('sosNotesBlock');
    if (idBlock) idBlock.style.display = 'none';
    if (locBlock) locBlock.style.display = 'none';
    if (badgeEl) badgeEl.style.display = 'none';
    if (warnBlock) warnBlock.style.display = 'none';
    if (notesBlock) notesBlock.style.display = 'none';

    const gps = await getSosGpsLocation();

    try {
        const payload = { userId: currentUserId || undefined };
        if (gps.available) {
            payload.latitude = gps.latitude;
            payload.longitude = gps.longitude;
        }

        const response = await fetch(`${API_BASE}/api/sos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Server rejected the SOS request');
        }

        updateSosDisplay(data.incident);

        if (sosButton) {
            sosButton.innerHTML = `
                <i class="fas fa-broadcast-tower"
                   style="font-size: 3rem; margin-bottom: 10px; animation: sosPulse 1.6s ease-in-out infinite;">
                </i>
                <div>SOS LIVE</div>
                <div style="font-size: 1rem; margin-top: 5px;">
                    STATUS BELOW
                </div>
            `;
        }

        if (data.message) {
            showNotification(data.message, gps.available ? 'error' : 'warning');
        } else if (!gps.available) {
            showNotification('SOS activated, but location could not be captured.', 'warning');
        }

        stopSosPolling();
        sosPollIntervalId = setInterval(pollSosStatus, 4000);
        pollSosStatus();

    } catch (error) {
        console.error('triggerSOS error:', error);
        sosActive = false;
        if (timelineEl) {
            timelineEl.innerHTML = `
                <div class="sos-timeline-step current">
                    <div class="sos-timeline-icon" style="background:rgba(240,113,103,0.15);border-color:rgba(240,113,103,0.55);color:#f07167;"><i class="fas fa-times-circle"></i></div>
                    <div class="sos-timeline-content">
                        <div class="sos-timeline-title"><span style="color:#f07167;">Failed to register SOS</span></div>
                        <div class="sos-timeline-note">${error.message || 'Unknown error.'} If this is a real emergency, please call <a href="tel:112" style="color:#48cae4;">112</a> immediately.</div>
                    </div>
                </div>
            `;
        }
        if (sosButton) {
            sosButton.innerHTML = `
                <i class="fas fa-exclamation-triangle" style="font-size: 3rem; margin-bottom: 10px;"></i>
                <div>RETRY SOS</div>
                <div style="font-size: 1rem; margin-top: 5px;">TAP TO TRY AGAIN</div>
            `;
        }
        showNotification('Failed to activate SOS: ' + (error.message || 'server error'), 'error');
    }
}

function resetSOS() {
    if (currentSosIncident && currentSosIncident.status && currentSosIncident.status !== 'RESOLVED') {
        if (!confirm('Resetting will stop tracking this SOS on this device. Emergency services may still be responding. Continue?')) {
            return;
        }
    }

    sosActive = false;
    currentSosIncident = null;
    stopSosPolling();

    try { localStorage.removeItem('coastwatch_sos_active_id'); } catch (_) { }

    const statusEl = document.getElementById('sosStatus');
    if (statusEl) statusEl.style.display = 'none';

    const sosButton = document.getElementById('sosButton');
    if (sosButton) {
        sosButton.innerHTML = `
            <i class="fas fa-exclamation-triangle"
               style="font-size: 3rem; margin-bottom: 10px;">
            </i>

            <div>SOS</div>

            <div style="font-size: 1rem; margin-top: 5px;">
                TAP FOR HELP
            </div>
        `;
    }

    showNotification('SOS tracking reset on this device.');
}

async function restoreSosFromStorage() {
    try {
        const savedId = localStorage.getItem('coastwatch_sos_active_id');
        if (!savedId) return;

        const response = await fetch(`${API_BASE}/api/sos/${encodeURIComponent(savedId)}`);
        const data = await response.json();
        if (!response.ok || !data.success || !data.incident) {
            localStorage.removeItem('coastwatch_sos_active_id');
            return;
        }

        const incident = data.incident;
        if (incident.status === 'RESOLVED') {
            localStorage.removeItem('coastwatch_sos_active_id');
        }

        sosActive = true;
        currentSosIncident = incident;

        const statusEl = document.getElementById('sosStatus');
        if (statusEl) statusEl.style.display = 'block';

        const sosButton = document.getElementById('sosButton');
        if (sosButton && incident.status !== 'RESOLVED') {
            sosButton.innerHTML = `
                <i class="fas fa-broadcast-tower"
                   style="font-size: 3rem; margin-bottom: 10px; animation: sosPulse 1.6s ease-in-out infinite;">
                </i>
                <div>SOS LIVE</div>
                <div style="font-size: 1rem; margin-top: 5px;">STATUS BELOW</div>
            `;
        } else if (sosButton) {
            sosButton.innerHTML = `
                <i class="fas fa-check-double" style="font-size: 3rem; margin-bottom: 10px; color: #48cae4;"></i>
                <div>SOS RESOLVED</div>
                <div style="font-size: 1rem; margin-top: 5px;">CASE CLOSED</div>
            `;
        }

        updateSosDisplay(incident);

        if (incident.status !== 'RESOLVED') {
            stopSosPolling();
            sosPollIntervalId = setInterval(pollSosStatus, 4000);
        }
    } catch (err) {
        console.warn('SOS restore failed:', err);
    }
}

function floatingSOSClick() {
    showTab('sos');

    window.scrollTo({
        top: 0,
        behavior: 'smooth'
    });

    setTimeout(() => {
        triggerSOS();
    }, 300);

    showNotification(
        'Emergency SOS Activated! Switching to emergency panel...',
        'error'
    );
}

function getShelterLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function (position) {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                document.getElementById('shelterLatitude').value = lat.toFixed(6);
                document.getElementById('shelterLongitude').value = lng.toFixed(6);
                const lookup = reverseGeocodeNearestCity(lat, lng);
                setSheltersStatus(
                    lookup
                        ? `📍 Location captured: <strong>${lookup.name}</strong> (${lat.toFixed(4)}, ${lng.toFixed(4)})`
                        : `📍 Location captured: ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
                    'info'
                );
                showNotification('Location captured for shelter search');
            },
            function (error) {
                setSheltersStatus('Error getting location: ' + error.message, 'error');
                showNotification('Error getting location: ' + error.message, 'error');
            }
        );
    } else {
        setSheltersStatus('Geolocation is not supported by this browser.', 'error');
        showNotification('Geolocation is not supported', 'error');
    }
}

function setSheltersStatus(message, type) {
    const statusEl = document.getElementById('sheltersStatus');
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.innerHTML = message;
    if (type === 'error') {
        statusEl.style.color = '#e74c3c';
        statusEl.style.borderColor = 'rgba(231, 76, 60, 0.5)';
    } else if (type === 'success') {
        statusEl.style.color = '#27ae60';
        statusEl.style.borderColor = 'rgba(39, 174, 96, 0.5)';
    } else {
        statusEl.style.color = '#f4f4f4';
        statusEl.style.borderColor = 'rgba(0, 180, 216, 0.4)';
    }
}

function statusBadge(status) {
    const s = String(status || 'unknown');
    const map = {
        open: { label: 'OPEN', color: '#48cae4', bg: 'rgba(0, 180, 216, 0.12)', border: 'rgba(0, 180, 216, 0.45)', icon: 'fa-door-open' },
        full: { label: 'FULL', color: '#90be6d', bg: 'rgba(72, 149, 239, 0.1)', border: 'rgba(72, 149, 239, 0.4)', icon: 'fa-users' },
        closed: { label: 'CLOSED', color: '#f07167', bg: 'rgba(240, 113, 103, 0.12)', border: 'rgba(240, 113, 103, 0.45)', icon: 'fa-lock' },
        evacuating: { label: 'EVACUATING', color: '#b388eb', bg: 'rgba(179, 136, 235, 0.1)', border: 'rgba(179, 136, 235, 0.45)', icon: 'fa-running' }
    };
    const cfg = map[s] || { label: s.toUpperCase(), color: '#90e0ef', bg: 'rgba(144, 224, 239, 0.1)', border: 'rgba(144, 224, 239, 0.4)', icon: 'fa-question-circle' };
    return `<span class="status-badge" style="background:${cfg.bg};border:1px solid ${cfg.border};color:${cfg.color};padding:4px 10px;border-radius:999px;font-size:0.8rem;font-weight:bold;display:inline-flex;align-items:center;gap:6px;"><i class="fas ${cfg.icon}"></i>${cfg.label}</span>`;
}

function riskBadge(level) {
    const l = String(level || 'unknown');
    const map = {
        low: { label: 'LOW RISK', color: '#48cae4', bg: 'rgba(0, 180, 216, 0.12)', border: 'rgba(0, 180, 216, 0.45)', icon: 'fa-shield-alt' },
        medium: { label: 'MEDIUM RISK', color: '#7dc4ff', bg: 'rgba(72, 149, 239, 0.12)', border: 'rgba(72, 149, 239, 0.45)', icon: 'fa-exclamation-triangle' },
        high: { label: 'HIGH RISK', color: '#f4a261', bg: 'rgba(244, 162, 97, 0.1)', border: 'rgba(244, 162, 97, 0.45)', icon: 'fa-radiation' },
        critical: { label: 'CRITICAL RISK', color: '#f07167', bg: 'rgba(240, 113, 103, 0.12)', border: 'rgba(240, 113, 103, 0.5)', icon: 'fa-skull-crossbones' }
    };
    const cfg = map[l] || { label: l.toUpperCase(), color: '#90e0ef', bg: 'rgba(144, 224, 239, 0.1)', border: 'rgba(144, 224, 239, 0.4)', icon: 'fa-question-circle' };
    return `<span class="risk-badge" style="background:${cfg.bg};border:1px solid ${cfg.border};color:${cfg.color};padding:4px 10px;border-radius:999px;font-size:0.8rem;font-weight:bold;display:inline-flex;align-items:center;gap:6px;"><i class="fas ${cfg.icon}"></i>${cfg.label}</span>`;
}

function roadBadge(road) {
    const r = String(road || 'unknown');
    const map = {
        open: { label: 'ROADS OPEN', color: '#48cae4', bg: 'rgba(0, 180, 216, 0.12)', border: 'rgba(0, 180, 216, 0.45)', icon: 'fa-road' },
        restricted: { label: 'ROADS RESTRICTED', color: '#7dc4ff', bg: 'rgba(72, 149, 239, 0.1)', border: 'rgba(72, 149, 239, 0.45)', icon: 'fa-traffic-light' },
        blocked: { label: 'ROADS BLOCKED', color: '#f07167', bg: 'rgba(240, 113, 103, 0.12)', border: 'rgba(240, 113, 103, 0.5)', icon: 'fa-ban' },
        unknown: { label: 'ROADS UNKNOWN', color: '#a9c6de', bg: 'rgba(169, 198, 222, 0.1)', border: 'rgba(169, 198, 222, 0.4)', icon: 'fa-question-circle' }
    };
    const cfg = map[r] || { label: r.toUpperCase(), color: '#90e0ef', bg: 'rgba(144, 224, 239, 0.1)', border: 'rgba(144, 224, 239, 0.4)', icon: 'fa-question-circle' };
    return `<span class="road-badge" style="background:${cfg.bg};border:1px solid ${cfg.border};color:${cfg.color};padding:4px 10px;border-radius:999px;font-size:0.8rem;font-weight:bold;display:inline-flex;align-items:center;gap:6px;"><i class="fas ${cfg.icon}"></i>${cfg.label}</span>`;
}

function capacityBar(used, total) {
    const u = Math.max(0, Number(used) || 0);
    const t = Math.max(1, Number(total) || 1);
    const pct = Math.min(100, Math.round((u / t) * 100));
    const color = pct < 70 ? '#00b4d8' : pct < 90 ? '#7dc4ff' : '#f07167';
    const avail = Math.max(0, t - u);
    const availColor = avail > 0 ? '#48cae4' : '#f07167';
    return `
        <div style="margin-top:0.5rem;">
            <div style="display:flex;justify-content:space-between;font-size:0.85rem;color:#cdd7e6;margin-bottom:4px;">
                <span><i class="fas fa-users"></i> Occupancy: ${u}/${t}</span>
                <span style="color:${availColor};font-weight:bold;"><i class="fas fa-chair"></i> ${avail} spots available</span>
            </div>
            <div style="background:rgba(144, 224, 239, 0.1);border-radius:999px;height:10px;overflow:hidden;">
                <div style="background:linear-gradient(90deg, ${color}, ${color}ee);width:${pct}%;height:100%;border-radius:999px;transition:width 0.5s;"></div>
            </div>
            <div style="font-size:0.75rem;color:#a9c6de;margin-top:3px;">${pct}% full</div>
        </div>
    `;
}

function suitabilityMeter(score, showLabel = true) {
    const s = Math.max(0, Math.min(1, Number(score) || 0));
    const pct = Math.round(s * 100);
    const color = pct >= 70 ? '#00b4d8' : pct >= 45 ? '#7dc4ff' : '#f07167';
    const label = pct >= 70 ? 'Excellent' : pct >= 45 ? 'Acceptable' : 'Poor';
    return `
        <div style="margin-top:0.5rem;">
            ${showLabel ? `<div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:4px;"><span style="color:#a9c6de;"><i class="fas fa-balance-scale"></i> Suitability Score</span><span style="color:${color};font-weight:bold;">${label} — ${pct}/100</span></div>` : ''}
            <div style="background:rgba(144, 224, 239, 0.1);border-radius:999px;height:12px;overflow:hidden;">
                <div style="background:linear-gradient(90deg, ${color}, ${color}dd);width:${pct}%;height:100%;border-radius:999px;transition:width 0.6s;"></div>
            </div>
        </div>
    `;
}

function amenitiesList(amenities) {
    if (!Array.isArray(amenities) || amenities.length === 0) return '';
    const iconMap = {
        water: 'fa-tint',
        electricity: 'fa-bolt',
        food: 'fa-utensils',
        first_aid: 'fa-first-aid',
        medical: 'fa-medkit',
        sanitation: 'fa-restroom',
        parking: 'fa-parking',
        emergency_power: 'fa-battery-full'
    };
    const labelMap = {
        water: 'Drinking Water',
        electricity: 'Electricity',
        food: 'Food Service',
        first_aid: 'First Aid Kit',
        medical: 'Medical Staff',
        sanitation: 'Sanitation',
        parking: 'Parking',
        emergency_power: 'Backup Power'
    };
    return `
        <div style="margin-top:0.8rem;">
            <div style="font-size:0.85rem;color:#a9c6de;margin-bottom:0.4rem;"><i class="fas fa-list"></i> Amenities</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
                ${amenities.map(a => `<span style="background:rgba(72, 202, 228, 0.08);border:1px solid rgba(72, 202, 228, 0.35);color:#90e0ef;padding:3px 8px;border-radius:6px;font-size:0.75rem;display:inline-flex;align-items:center;gap:5px;"><i class="fas ${iconMap[a] || 'fa-check'}"></i>${labelMap[a] || String(a)}</span>`).join('')}
            </div>
        </div>
    `;
}

function explanationList(explanations) {
    if (!Array.isArray(explanations) || explanations.length === 0) return '';
    return `
        <div style="margin-top:1rem;">
            <div style="font-size:0.95rem;color:#e8eef7;font-weight:bold;margin-bottom:0.6rem;"><i class="fas fa-lightbulb"></i> Why this shelter was selected</div>
            <div style="display:flex;flex-direction:column;gap:5px;">
                ${explanations.map(e => `
                    <div style="display:flex;gap:8px;align-items:flex-start;font-size:0.88rem;padding:6px 8px;border-radius:6px;background:${e.positive ? 'rgba(0, 180, 216, 0.08)' : 'rgba(240, 113, 103, 0.08)'};border-left:3px solid ${e.positive ? '#00b4d8' : '#f07167'};">
                        <i class="fas ${e.positive ? 'fa-check-circle' : 'fa-exclamation-circle'}" style="color:${e.positive ? '#48cae4' : '#f07167'};margin-top:2px;flex-shrink:0;"></i>
                        <span style="color:#e8eef7;line-height:1.4;">${e.text}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function scoreBreakdownTable(breakdown) {
    if (!breakdown || typeof breakdown !== 'object') return '';
    const keys = [
        { k: 'status', label: 'Shelter Status', icon: 'fa-door-open' },
        { k: 'capacity', label: 'Available Capacity', icon: 'fa-users' },
        { k: 'risk', label: 'Local Disaster Risk', icon: 'fa-shield-alt' },
        { k: 'roads', label: 'Road Accessibility', icon: 'fa-road' },
        { k: 'distance', label: 'Travel Distance', icon: 'fa-route' },
        { k: 'hazard', label: 'Nearby Hazards', icon: 'fa-exclamation-triangle' }
    ];
    const rows = keys
        .filter(k => breakdown[k.k])
        .map(k => {
            const b = breakdown[k.k];
            const scorePct = Math.round((Number(b.score) || 0) * 100);
            const weightPct = Math.round((Number(b.weight) || 0) * 100);
            const contribPct = Math.round((Number(b.contribution) || 0) * 100);
            const color = scorePct >= 70 ? '#48cae4' : scorePct >= 45 ? '#7dc4ff' : '#f07167';
            return `
                <tr>
                    <td style="padding:7px 10px;font-size:0.85rem;display:flex;align-items:center;gap:7px;"><i class="fas ${k.icon}"></i>${k.label}</td>
                    <td style="padding:7px 10px;font-size:0.85rem;color:${color};text-align:right;font-weight:bold;">${scorePct}/100</td>
                    <td style="padding:7px 10px;font-size:0.85rem;color:#a9c6de;text-align:right;">${weightPct}%</td>
                    <td style="padding:7px 10px;font-size:0.85rem;color:#e8eef7;text-align:right;font-weight:600;">+${contribPct}</td>
                </tr>
            `;
        }).join('');
    return `
        <details style="margin-top:1rem;background:rgba(0, 180, 216, 0.05);border-radius:8px;padding:0.5rem 1rem;">
            <summary style="cursor:pointer;font-size:0.9rem;color:#a9c6de;padding:4px 0;"><i class="fas fa-chart-pie"></i> View Suitability Score Breakdown (${keys.length} factors)</summary>
            <table style="width:100%;margin-top:0.5rem;border-collapse:collapse;">
                <thead>
                    <tr style="border-bottom:1px solid rgba(144, 224, 239, 0.12);">
                        <th style="padding:7px 10px;text-align:left;font-size:0.8rem;color:#a9c6de;font-weight:600;">Factor</th>
                        <th style="padding:7px 10px;text-align:right;font-size:0.8rem;color:#a9c6de;font-weight:600;">Raw</th>
                        <th style="padding:7px 10px;text-align:right;font-size:0.8rem;color:#a9c6de;font-weight:600;">Weight</th>
                        <th style="padding:7px 10px;text-align:right;font-size:0.8rem;color:#a9c6de;font-weight:600;">Contrib</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </details>
    `;
}

function routePanel(route) {
    if (!route || typeof route !== 'object') return '';
    const steps = Array.isArray(route.steps) ? route.steps : [];
    const roadColor = route.roadAccess === 'open' ? '#00b4d8' : route.roadAccess === 'restricted' ? '#7dc4ff' : route.roadAccess === 'blocked' ? '#f07167' : '#a9c6de';
    return `
        <div style="margin-top:1.2rem;border-top:1px solid rgba(144, 224, 239, 0.15);padding-top:1rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:0.6rem;">
                <div style="font-size:0.95rem;font-weight:bold;color:#e8eef7;"><i class="fas fa-map-signs"></i> Recommended Route</div>
                ${route.note ? `<span style="font-size:0.75rem;color:#7dc4ff;background:rgba(72, 149, 239, 0.08);padding:3px 8px;border-radius:6px;"><i class="fas fa-info-circle"></i>${route.note}</span>` : ''}
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.75rem;margin-bottom:0.8rem;">
                <div style="background:rgba(0, 180, 216, 0.06);border:1px solid rgba(0, 180, 216, 0.25);border-radius:8px;padding:0.7rem;text-align:center;">
                    <div style="font-size:0.75rem;color:#a9c6de;margin-bottom:3px;"><i class="fas fa-ruler"></i> Straight Distance</div>
                    <div style="font-size:1.2rem;font-weight:bold;color:#00b4d8;">${route.straightKm ?? '—'} km</div>
                </div>
                <div style="background:rgba(0, 180, 216, 0.06);border:1px solid rgba(0, 180, 216, 0.25);border-radius:8px;padding:0.7rem;text-align:center;">
                    <div style="font-size:0.75rem;color:#a9c6de;margin-bottom:3px;"><i class="fas fa-road"></i> Road Distance</div>
                    <div style="font-size:1.2rem;font-weight:bold;color:#48cae4;">${route.roadKm ?? '—'} km</div>
                </div>
                <div style="background:rgba(0, 180, 216, 0.06);border:1px solid rgba(0, 180, 216, 0.25);border-radius:8px;padding:0.7rem;text-align:center;">
                    <div style="font-size:0.75rem;color:#a9c6de;margin-bottom:3px;"><i class="fas fa-clock"></i> Estimated Travel</div>
                    <div style="font-size:1.2rem;font-weight:bold;color:#00b4d8;">${route.etaMinutes ?? '—'} min</div>
                </div>
                <div style="background:${roadColor}12;border:1px solid ${roadColor}44;border-radius:8px;padding:0.7rem;text-align:center;">
                    <div style="font-size:0.75rem;color:#a9c6de;margin-bottom:3px;"><i class="fas fa-route"></i> Road Status</div>
                    <div style="font-size:1.1rem;font-weight:bold;color:${roadColor};text-transform:capitalize;">${route.roadAccess ?? 'unknown'}</div>
                </div>
            </div>
            ${steps.length ? `
                <div style="background:rgba(0, 180, 216, 0.04);border-radius:8px;padding:0.8rem 1rem;">
                    <div style="font-size:0.85rem;color:#a9c6de;margin-bottom:0.5rem;"><i class="fas fa-walking"></i> Route Steps</div>
                    <div style="position:relative;">
                        ${steps.map((step, i) => `
                            <div style="display:flex;gap:10px;padding:0.4rem 0;position:relative;">
                                <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;">
                                    <div style="width:22px;height:22px;border-radius:50%;background:${i === 0 ? '#00b4d8' : i === steps.length - 1 ? '#48cae4' : 'rgba(72, 202, 228, 0.15)'};border:2px solid ${i === 0 ? '#00b4d8' : i === steps.length - 1 ? '#48cae4' : 'rgba(72, 202, 228, 0.3)'};display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:bold;color:white;z-index:1;">${i + 1}</div>
                                    ${i < steps.length - 1 ? '<div style="width:2px;background:rgba(72, 202, 228, 0.15);flex:1;margin:3px 0;"></div>' : ''}
                                </div>
                                <div style="flex:1;padding-top:1px;">
                                    <div style="font-size:0.9rem;color:#e8eef7;font-weight:600;line-height:1.35;">${step.instruction || ''}</div>
                                    ${step.note ? `<div style="font-size:0.8rem;color:#a9c6de;margin-top:3px;line-height:1.35;">${step.note}</div>` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

function shelterCardHTML(shelter, options = {}) {
    const { isRecommended = false } = options;
    const displayName = shelter.name || 'Unnamed Shelter';
    return `
        <div class="shelter-card ${isRecommended ? 'recommended' : ''}" style="background:rgba(72, 202, 228, 0.04);border-radius:12px;padding:1.2rem;border:1px solid rgba(72, 202, 228, 0.18);margin-bottom:1rem;${isRecommended ? 'border-color:rgba(0, 180, 216, 0.45);background:linear-gradient(135deg, rgba(0, 180, 216, 0.10), rgba(72, 149, 239, 0.06));' : ''}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
                <div style="flex:1;min-width:240px;">
                    <div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">
                        <h4 style="margin:0;color:#e8eef7;font-size:1.1rem;line-height:1.3;">${isRecommended ? '<i class="fas fa-star" style="color:#48cae4;"></i> ' : ''}${displayName}</h4>
                        ${shelter.isSample ? '<span style="font-size:0.7rem;background:rgba(0, 180, 216, 0.08);border:1px solid rgba(0, 180, 216, 0.3);color:#48cae4;padding:2px 6px;border-radius:4px;align-self:center;"><i class="fas fa-vial"></i> SAMPLE DATA</span>' : ''}
                    </div>
                    ${shelter.address ? `<div style="margin-top:4px;font-size:0.85rem;color:#a9c6de;"><i class="fas fa-map-marker-alt"></i> ${shelter.address}</div>` : ''}
                    ${shelter.shelterType ? `<div style="margin-top:3px;font-size:0.8rem;color:#7dc4ff;"><i class="fas fa-building"></i> ${shelter.shelterType}</div>` : ''}
                    <div style="margin-top:0.6rem;display:flex;gap:6px;flex-wrap:wrap;">
                        ${statusBadge(shelter.status)}
                        ${riskBadge(shelter.riskLevel)}
                        ${roadBadge(shelter.roadAccess)}
                    </div>
                </div>
                <div style="min-width:180px;text-align:right;">
                    ${typeof shelter.distanceKm === 'number' ? `
                        <div style="font-size:0.8rem;color:#a9c6de;margin-bottom:3px;"><i class="fas fa-location-arrow"></i> Distance</div>
                        <div style="font-size:1.5rem;font-weight:bold;color:#00b4d8;">${shelter.distanceKm}<span style="font-size:0.95rem;color:#a9c6de;font-weight:normal;"> km</span></div>
                    ` : ''}
                    ${typeof shelter.suitabilityScore === 'number' ? suitabilityMeter(shelter.suitabilityScore, true) : ''}
                </div>
            </div>
            ${capacityBar(shelter.currentOccupancy, shelter.totalCapacity)}
            ${amenitiesList(shelter.amenities)}
            ${shelter.hazardsWithin20km != null ? `
                <div style="margin-top:0.8rem;font-size:0.85rem;color:${shelter.hazardsWithin20km > 0 ? '#7dc4ff' : '#48cae4'};">
                    <i class="fas ${shelter.hazardsWithin20km > 0 ? 'fa-exclamation-triangle' : 'fa-check-circle'}"></i>
                    Active hazards within 20 km: <strong>${shelter.hazardsWithin20km}</strong>
                </div>
            ` : ''}
            ${explanationList(shelter.explanation)}
            ${scoreBreakdownTable(shelter.scoreBreakdown)}
            ${shelter.route ? routePanel(shelter.route) : ''}
            <div style="margin-top:1rem;display:flex;gap:0.75rem;flex-wrap:wrap;">
                <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(shelter.latitude + ',' + shelter.longitude)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary" style="background:#00b4d8;display:inline-flex;align-items:center;gap:6px;text-decoration:none;margin-top:0;">
                    <i class="fas fa-directions"></i> Get Directions
                </a>
                <button type="button" class="btn" onclick="showShelterOnMap(${shelter.latitude}, ${shelter.longitude}, ${JSON.stringify(displayName).replace(/\"/g, '&quot;')})" style="margin-top:0;background:#2a5298;">
                    <i class="fas fa-map-marker-alt"></i> View on Map
                </button>
            </div>
            ${shelter.lastUpdated ? `<div style="margin-top:0.8rem;font-size:0.75rem;color:#a9c6de;"><i class="fas fa-clock"></i> Last updated: ${parseServerDate(shelter.lastUpdated).toLocaleString()}</div>` : ''}
        </div>
    `;
}

function showShelterOnMap(lat, lng, name) {
    showTab('map');
    setTimeout(() => {
        if (map) {
            map.setView([lat, lng], 14);
            const marker = L.marker([lat, lng]).addTo(map);
            marker.bindPopup(`<div><strong>${name}</strong><br><em>Recommended Shelter</em></div>`).openPopup();
            mapMarkers.push(marker);
        }
    }, 150);
}

async function findShelters() {
    const latInput = document.getElementById('shelterLatitude');
    const lngInput = document.getElementById('shelterLongitude');
    const radiusInput = document.getElementById('shelterRadius');
    const resultArea = document.getElementById('sheltersResultArea');
    const recommendEl = document.getElementById('sheltersRecommended');
    const recLabel = document.getElementById('shelterRecLabel');
    const altWrap = document.getElementById('sheltersAlternativesWrap');
    const altEl = document.getElementById('sheltersAlternatives');
    const noticeEl = document.getElementById('sheltersSampleNotice');
    const noticeText = document.getElementById('sheltersSampleText');

    const latitude = latInput ? latInput.value.trim() : '';
    const longitude = lngInput ? lngInput.value.trim() : '';
    const radius = radiusInput ? radiusInput.value.trim() : '80';

    if (!latitude || !longitude) {
        setSheltersStatus('⚠ Please provide your latitude and longitude, or click <strong>"Use My Current Location"</strong>.', 'error');
        showNotification('Please enter your coordinates first', 'error');
        return;
    }
    if (Number.isNaN(Number(latitude)) || Number.isNaN(Number(longitude))) {
        setSheltersStatus('⚠ Invalid coordinates. Latitude and Longitude must be numbers.', 'error');
        showNotification('Invalid coordinates', 'error');
        return;
    }

    setSheltersStatus('<i class="fas fa-spinner fa-spin"></i> Analyzing shelters near you — scoring by status, capacity, risk, roads, hazards, and distance…', 'info');
    if (resultArea) resultArea.style.display = 'none';

    try {
        const url = `${API_BASE}/api/shelters/recommend?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&radius=${encodeURIComponent(radius)}&maxResults=6`;
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to get shelter recommendations');
        }

        const dataset = data.dataset || {};
        if (noticeEl && noticeText) {
            if (dataset.isSampleData || dataset.note) {
                noticeEl.style.display = 'block';
                noticeText.innerHTML = (dataset.note || '') + (dataset.shelterCount != null ? ` <em>(${dataset.shelterCount} shelters in result)</em>` : '');
            } else {
                noticeEl.style.display = 'none';
            }
        }

        const best = data.recommended;
        const alternatives = Array.isArray(data.alternatives) ? data.alternatives : [];

        if (!best) {
            setSheltersStatus(
                `No reachable shelters found within ${radius} km. Try increasing the search radius.`,
                'error'
            );
            showNotification('No shelters found — try a larger radius', 'error');
            if (resultArea) resultArea.style.display = 'none';
            return;
        }

        if (recommendEl) {
            if (recLabel) recLabel.textContent = dataset.shelterCount > 1 ? 'Best Recommended Shelter' : 'Only Shelter Available';
            recommendEl.innerHTML = shelterCardHTML(best, { isRecommended: true });
        }

        if (altEl && altWrap) {
            if (alternatives.length > 0) {
                altWrap.style.display = 'block';
                altEl.innerHTML = alternatives.map(s => shelterCardHTML(s, { isRecommended: false })).join('');
            } else {
                altWrap.style.display = 'none';
                altEl.innerHTML = '';
            }
        }

        if (resultArea) resultArea.style.display = 'block';

        const scoredAll = Array.isArray(data.allScored) ? data.allScored : [best];
        const bestScore = typeof best.suitabilityScore === 'number' ? Math.round(best.suitabilityScore * 100) : '—';
        setSheltersStatus(
            `<i class="fas fa-check-circle" style="color:#00b4d8;"></i> <strong>Found ${dataset.shelterCount || scoredAll.length} shelters.</strong> Best match scores <strong style="color:#48cae4;">${bestScore}/100</strong> suitability and is ${typeof best.distanceKm === 'number' ? best.distanceKm + ' km' : ''} away.`,
            'success'
        );
        showNotification(`${dataset.shelterCount || scoredAll.length} shelters ranked! Best match highlighted.`);
    } catch (error) {
        console.error(error);
        setSheltersStatus('❌ ' + (error.message || 'Failed to find shelters'), 'error');
        showNotification(error.message || 'Failed to find shelters', 'error');
        if (resultArea) resultArea.style.display = 'none';
    }
}

function setSosFilter(filter) {
    currentSosFilter = filter;
    ['active', 'resolved', 'all'].forEach(f => {
        const btn = document.getElementById(`sosFilter${f.charAt(0).toUpperCase() + f.slice(1)}`);
        if (btn) {
            if (f === filter) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });
    loadAuthoritySosList(false);
}

function stopDashboardSosPolling() {
    if (dashboardSosPollIntervalId) {
        clearInterval(dashboardSosPollIntervalId);
        dashboardSosPollIntervalId = null;
    }
}

function renderAuthoritySosCard(incident) {
    const currentIdx = SOS_STATUS_ORDER.indexOf(incident.status);
    const status = incident.status;
    const nextStatus = SOS_STATUS_ORDER[currentIdx + 1] || null;
    const isResolved = status === 'RESOLVED';
    const canAdvance = nextStatus !== null && !isResolved;
    const canResolve = !isResolved;

    const statusClass = (status || '').toLowerCase().replace(/_/g, '-');

    let locationHTML;
    if (incident.locationAvailable && typeof incident.latitude === 'number') {
        const lookup = reverseGeocodeNearestCity(incident.latitude, incident.longitude);
        const coords = `${incident.latitude.toFixed(5)}, ${incident.longitude.toFixed(5)}`;
        locationHTML = `
            <div class="sos-meta-item">
                <div class="sos-meta-label"><i class="fas fa-map-marker-alt"></i> Location (GPS)</div>
                <div class="sos-meta-value">
                    ${lookup ? `${lookup.name} (≈${lookup.distanceKm.toFixed(1)} km)` : coords}
                </div>
                <a href="https://www.google.com/maps?q=${encodeURIComponent(incident.latitude + ',' + incident.longitude)}"
                   target="_blank" rel="noopener noreferrer"
                   style="font-size:0.75rem;color:#48cae4;text-decoration:underline;">
                    <i class="fas fa-external-link-alt"></i> Open map
                </a>
            </div>
        `;
    } else {
        locationHTML = `
            <div class="sos-meta-item" style="background:rgba(240,113,103,0.08);border:1px solid rgba(240,113,103,0.25);">
                <div class="sos-meta-label" style="color:#f07167;"><i class="fas fa-exclamation-triangle"></i> Location Unavailable</div>
                <div class="sos-meta-value" style="font-size:0.8rem;font-weight:500;color:#e8eef7;">
                    User's GPS was not captured. Contact the user or use mobile network triangulation to locate.
                </div>
            </div>
        `;
    }

    return `
        <div class="sos-card ${statusClass}" data-sos-id="${incident.id}">
            <div class="sos-card-header">
                <div>
                    <div class="sos-card-id"><i class="fas fa-fingerprint"></i> ${incident.sosShortId || incident.id}</div>
                    <div style="margin-top:4px;">${sosStatusBadgeHTML(status)}</div>
                </div>
                <div class="sos-card-time">
                    <div><i class="fas fa-clock"></i> ${parseServerDate(incident.createdAt).toLocaleString()}</div>
                    ${incident.updatedAt && incident.updatedAt !== incident.createdAt
                        ? `<div style="margin-top:3px;opacity:0.75;font-size:0.7rem;">Updated ${parseServerDate(incident.updatedAt).toLocaleString()}</div>`
                        : ''}
                    ${incident.resolvedAt
                        ? `<div style="margin-top:3px;color:#48cae4;font-size:0.7rem;"><i class="fas fa-check-double"></i> Resolved ${parseServerDate(incident.resolvedAt).toLocaleString()}</div>`
                        : ''}
                </div>
            </div>
            <div class="sos-card-meta">
                ${locationHTML}
                <div class="sos-meta-item">
                    <div class="sos-meta-label"><i class="fas fa-shield-alt"></i> Workflow</div>
                    <div class="sos-meta-value" style="font-size:0.78rem;line-height:1.5;">
                        ${SOS_STATUS_ORDER.map((s, i) => `
                            <span style="${i < currentIdx || (isResolved && s === 'RESOLVED') ? 'color:#48cae4;' : i === currentIdx ? 'color:#f07167;font-weight:bold;' : 'color:#6f8aa5;'}">
                                ${i < currentIdx || (isResolved && s === 'RESOLVED') ? '<i class="fas fa-check"></i>' : i === currentIdx ? '<i class="fas fa-play"></i>' : '<i class="far fa-circle"></i>'}
                                ${SOS_STATUS_LABEL[s]}
                            </span>
                        `).join(' · ')}
                    </div>
                </div>
                ${incident.notes ? `
                    <div class="sos-meta-item">
                        <div class="sos-meta-label"><i class="fas fa-clipboard-list"></i> Notes</div>
                        <div class="sos-meta-value" style="font-size:0.82rem;font-weight:500;">${incident.notes}</div>
                    </div>
                ` : ''}
            </div>
            <div class="sos-card-actions">
                ${canAdvance ? `
                    <button class="sos-action-btn primary" onclick="updateSosStatus('${incident.id}', '${nextStatus}')">
                        <i class="fas fa-arrow-right"></i> Mark: ${SOS_STATUS_LABEL[nextStatus]}
                    </button>
                ` : ''}
                ${!isResolved ? `
                    <button class="sos-action-btn secondary" onclick="showSosAdvanceMenu('${incident.id}', '${status}')">
                        <i class="fas fa-step-forward"></i> Skip / Change status
                    </button>
                ` : ''}
                ${canResolve ? `
                    <button class="sos-action-btn resolve" onclick="updateSosStatus('${incident.id}', 'RESOLVED')">
                        <i class="fas fa-check-double"></i> Resolve & Auto-Remove
                    </button>
                ` : ''}
                <button class="sos-action-btn warn" onclick="promptSosNotes('${incident.id}')">
                    <i class="fas fa-edit"></i> Edit notes
                </button>
                ${isResolved ? `
                    <button class="sos-action-btn delete" onclick="deleteSosIncident('${incident.id}')" title="Permanently delete this SOS record">
                        <i class="fas fa-trash-alt"></i> Delete record
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

async function loadAuthoritySosList(silent = false) {
    const listEl = document.getElementById('authoritySosList');
    const summaryEl = document.getElementById('authoritySosSummary');
    if (!listEl) return;

    if (!silent && listEl.children.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; color:#bdc3c7; padding:1.5rem;">
                <i class="fas fa-spinner fa-spin"></i> Loading SOS incidents…
            </div>
        `;
    }

    try {
        const [listResp, statsResp] = await Promise.all([
            fetch(`${API_BASE}/api/sos?limit=100`),
            fetch(`${API_BASE}/api/sos/stats/summary`)
        ]);

        const listData = await listResp.json();
        const statsData = await statsResp.json();

        if (summaryEl && statsData.success && statsData.stats) {
            const s = statsData.stats;
            summaryEl.innerHTML = `
                <div class="sos-summary-tile critical">
                    <div class="sos-summary-number">${(s.byStatus.PENDING || 0)}</div>
                    <div class="sos-summary-label">Awaiting Ack</div>
                </div>
                <div class="sos-summary-tile active">
                    <div class="sos-summary-number">${(s.byStatus.ACKNOWLEDGED || 0) + (s.byStatus.IN_PROGRESS || 0)}</div>
                    <div class="sos-summary-label">Ack / In Progress</div>
                </div>
                <div class="sos-summary-tile progress">
                    <div class="sos-summary-number">${(s.byStatus.RESCUE_ASSIGNED || 0)}</div>
                    <div class="sos-summary-label">Rescue Assigned</div>
                </div>
                <div class="sos-summary-tile done">
                    <div class="sos-summary-number">${(s.byStatus.RESOLVED || 0)}</div>
                    <div class="sos-summary-label">Resolved</div>
                </div>
                <div class="sos-summary-tile">
                    <div class="sos-summary-number" style="color:#e8eef7;">${s.total || 0}</div>
                    <div class="sos-summary-label">Total (all time)</div>
                </div>
                <div class="sos-summary-tile">
                    <div class="sos-summary-number" style="color:#48cae4;">${s.active || 0}</div>
                    <div class="sos-summary-label">Active (in queue)</div>
                </div>
            `;
        }

        if (listData.success && Array.isArray(listData.incidents)) {
            const allIncidents = listData.incidents;
            const activeIncidents = allIncidents.filter(i => i.status !== 'RESOLVED');
            const resolvedIncidents = allIncidents.filter(i => i.status === 'RESOLVED');

            // Update badge counts on filter buttons
            const badgeActive = document.getElementById('sosBadgeActive');
            const badgeResolved = document.getElementById('sosBadgeResolved');
            const badgeAll = document.getElementById('sosBadgeAll');
            if (badgeActive) badgeActive.textContent = activeIncidents.length;
            if (badgeResolved) badgeResolved.textContent = resolvedIncidents.length;
            if (badgeAll) badgeAll.textContent = allIncidents.length;

            let displayedIncidents = [];
            if (currentSosFilter === 'active') {
                displayedIncidents = activeIncidents;
            } else if (currentSosFilter === 'resolved') {
                displayedIncidents = resolvedIncidents;
            } else {
                displayedIncidents = allIncidents;
            }

            if (displayedIncidents.length === 0) {
                if (currentSosFilter === 'active') {
                    listEl.innerHTML = `
                        <div style="text-align:center; padding:2.5rem 1.5rem; color:#a9c6de; background:rgba(0,0,0,0.2); border-radius:12px; border:1px dashed rgba(72, 202, 228, 0.25);">
                            <i class="fas fa-check-circle" style="font-size:2.5rem; color:#48cae4; margin-bottom:0.75rem; display:block;"></i>
                            <strong style="color:#e8eef7; font-size:1.1rem;">No Active SOS Emergencies</strong>
                            <div style="margin-top:0.4rem; font-size:0.88rem; color:#8aa2bb;">All emergency incidents are resolved. New alerts will appear here in real time.</div>
                        </div>
                    `;
                } else if (currentSosFilter === 'resolved') {
                    listEl.innerHTML = `
                        <div style="text-align:center; padding:2rem; color:#a9c6de; background:rgba(0,0,0,0.2); border-radius:10px;">
                            <i class="fas fa-archive" style="font-size:2rem; color:#8aa2bb; margin-bottom:0.5rem; display:block;"></i>
                            <div>No resolved SOS incidents on record.</div>
                        </div>
                    `;
                } else {
                    listEl.innerHTML = `
                        <div style="text-align:center; padding:2rem; color:#a9c6de; background:rgba(0,0,0,0.2); border-radius:10px;">
                            <i class="fas fa-inbox" style="font-size:2rem; color:#8aa2bb; margin-bottom:0.5rem; display:block;"></i>
                            <div>No SOS incidents recorded.</div>
                        </div>
                    `;
                }
            } else {
                let html = displayedIncidents.map(renderAuthoritySosCard).join('');
                if (currentSosFilter === 'resolved' && displayedIncidents.length > 0) {
                    html += `
                        <div style="text-align:right; margin-top:0.5rem;">
                            <button type="button" class="sos-action-btn delete" onclick="purgeResolvedSos()" style="font-size:0.82rem; padding:6px 14px;">
                                <i class="fas fa-trash-alt"></i> Purge All ${displayedIncidents.length} Resolved Record(s)
                            </button>
                        </div>
                    `;
                }
                listEl.innerHTML = html;
            }
        } else {
            listEl.innerHTML = `
                <div style="text-align:center; padding:1rem; color:#f07167;">
                    Failed to load SOS incidents: ${listData.error || 'Unknown error'}
                </div>
            `;
        }
    } catch (error) {
        console.error('loadAuthoritySosList error:', error);
        if (listEl && !silent) {
            listEl.innerHTML = `
                <div style="text-align:center; padding:1rem; color:#f07167;">
                    Network error loading SOS list: ${error.message}
                </div>
            `;
        }
    }
}

async function updateSosStatus(sosId, nextStatus, notes = undefined) {
    const cardEl = document.querySelector(`.sos-card[data-sos-id="${sosId}"]`);
    const isResolving = nextStatus === 'RESOLVED';

    // If resolving and on the active view, immediately start smooth exit animation
    if (isResolving && currentSosFilter === 'active' && cardEl) {
        cardEl.classList.add('auto-deleting');
    }

    try {
        const payload = { status: nextStatus };
        if (notes !== undefined) payload.notes = notes;
        if (currentUserId) payload.authorityId = currentUserId;
        if (nextStatus === 'RESCUE_ASSIGNED' && currentUserId) payload.assignedTo = currentUserId;

        const res = await fetch(`${API_BASE}/api/sos/${encodeURIComponent(sosId)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to update status');
        }

        if (isResolving) {
            showNotification('SOS marked as resolved and automatically cleared from active queue.', 'success');
            setTimeout(() => {
                loadAuthoritySosList(true);
            }, 350);
        } else {
            showNotification(data.message || 'Status updated.', 'success');
            loadAuthoritySosList(true);
        }
    } catch (error) {
        console.error('updateSosStatus error:', error);
        if (cardEl) cardEl.classList.remove('auto-deleting');
        showNotification('Could not update SOS status: ' + error.message, 'error');
    }
}

async function deleteSosIncident(sosId) {
    if (!confirm('Are you sure you want to permanently delete this SOS record?')) {
        return;
    }

    const cardEl = document.querySelector(`.sos-card[data-sos-id="${sosId}"]`);
    if (cardEl) cardEl.classList.add('auto-deleting');

    try {
        const res = await fetch(`${API_BASE}/api/sos/${encodeURIComponent(sosId)}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to delete SOS record');
        }

        showNotification('SOS incident permanently deleted.', 'success');
        setTimeout(() => {
            loadAuthoritySosList(true);
        }, 350);
    } catch (error) {
        console.error('deleteSosIncident error:', error);
        if (cardEl) cardEl.classList.remove('auto-deleting');
        showNotification('Failed to delete SOS: ' + error.message, 'error');
    }
}

async function purgeResolvedSos() {
    if (!confirm('Are you sure you want to permanently purge all resolved SOS records from the database?')) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/sos/purge/resolved`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to purge resolved records');
        }

        showNotification(data.message || 'Resolved SOS records purged.', 'success');
        loadAuthoritySosList(true);
    } catch (error) {
        console.error('purgeResolvedSos error:', error);
        showNotification('Failed to purge resolved SOS: ' + error.message, 'error');
    }
}

function showSosAdvanceMenu(sosId, currentStatus) {
    const statuses = SOS_STATUS_ORDER.filter(s => s !== currentStatus);
    const options = statuses.map((s, i) => `${i + 1}. ${SOS_STATUS_LABEL[s]} (${s})`).join('\n');
    const raw = prompt(
        `Jump/Change to which status?\n\nCurrent: ${SOS_STATUS_LABEL[currentStatus] || currentStatus}\n\nEnter number:\n${options}`,
        ''
    );
    if (raw == null) return;
    const idx = parseInt(String(raw).trim(), 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= statuses.length) {
        updateSosStatus(sosId, statuses[idx - 1]);
    } else {
        showNotification('Invalid selection.', 'error');
    }
}

function promptSosNotes(sosId) {
    const notes = prompt(
        'Enter authority notes for this SOS incident (visible to the user and response team):',
        ''
    );
    if (notes == null) return;
    updateSosStatus(sosId, currentSosIncident?.status || 'PENDING', notes.trim());
}

window.chtlConfig = {
    chatbotId: "3597779591"
};

// --- DEMO AUTHENTICATION SYSTEM ---
// The current access-code authentication is a demonstration mechanism. 
// In production, authentication should be performed by the backend using 
// secure password hashing/session or token-based authentication, with server-side role authorization.

const ROLE_PERMISSIONS = {
    USER: ['map', 'report', 'sos', 'social', 'shelters', 'risk', 'safety'],
    ADMIN: ['map', 'sos', 'social', 'risk', 'dashboard']
};

function requireRole(tabId) {
    const role = localStorage.getItem('coastwatchRole');
    if (!role) return false;
    const permissions = ROLE_PERMISSIONS[role] || [];
    return permissions.includes(tabId);
}

function checkAuth() {
    const isAuth = localStorage.getItem('coastwatchAuthenticated');
    const role = localStorage.getItem('coastwatchRole');
    
    if (isAuth === 'true' && role) {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('appContainer').style.display = 'block';
        
        // Update welcome text
        const welcomeText = document.getElementById('welcomeText');
        if (welcomeText) {
            welcomeText.textContent = `Welcome, ${role === 'ADMIN' ? 'Administrator' : 'User'}`;
        }
        
        updateNavigationForRole(role);
        
        // Show default tab for role if current is hidden
        const activeContent = document.querySelector('.content.active');
        if (!activeContent || activeContent.style.display === 'none' || !requireRole(activeContent.id)) {
            if (role === 'ADMIN') {
                showTab('dashboard');
            } else {
                showTab('map');
            }
        }
    } else {
        document.getElementById('loginScreen').style.display = 'flex';
        document.getElementById('appContainer').style.display = 'none';
    }
}

function handleLogin() {
    const code = document.getElementById('accessCode').value.trim();
    const errorEl = document.getElementById('loginError');
    
    if (code === 'COAST-USER-2026') {
        localStorage.setItem('coastwatchAuthenticated', 'true');
        localStorage.setItem('coastwatchRole', 'USER');
        errorEl.style.display = 'none';
        checkAuth();
    } else if (code === 'COAST-ADMIN-2026') {
        localStorage.setItem('coastwatchAuthenticated', 'true');
        localStorage.setItem('coastwatchRole', 'ADMIN');
        errorEl.style.display = 'none';
        checkAuth();
    } else {
        errorEl.style.display = 'block';
    }
}

function handleLoginKeyPress(e) {
    if (e.key === 'Enter') {
        handleLogin();
    }
}

function handleLogout() {
    localStorage.removeItem('coastwatchAuthenticated');
    localStorage.removeItem('coastwatchRole');
    document.getElementById('accessCode').value = '';
    
    // Hide active tabs
    document.querySelectorAll('.content').forEach(content => {
        content.classList.remove('active');
    });
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });

    checkAuth();
}

function updateNavigationForRole(role) {
    const permissions = ROLE_PERMISSIONS[role] || [];
    const tabs = document.querySelectorAll('.nav-tabs .tab');
    
    tabs.forEach(tab => {
        const onclickAttr = tab.getAttribute('onclick');
        if (onclickAttr) {
            const match = onclickAttr.match(/showTab\('([^']+)'\)/);
            if (match && match[1]) {
                const tabId = match[1];
                if (permissions.includes(tabId)) {
                    tab.style.display = 'flex';
                } else {
                    tab.style.display = 'none';
                }
            }
        }
    });
    
    const menuItems = document.querySelectorAll('.logo-menu-item');
    menuItems.forEach(item => {
        const onclickAttr = item.getAttribute('onclick');
        if (onclickAttr) {
            const match = onclickAttr.match(/showTab\('([^']+)'\)/);
            if (match && match[1]) {
                const tabId = match[1];
                if (!permissions.includes(tabId)) {
                    item.style.display = 'none';
                } else {
                    item.style.display = 'flex';
                }
            }
        }
    });
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function setRiskStatus(message, type = 'info') {
    const statusEl = document.getElementById('riskStatus');
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.innerHTML = message;
    if (type === 'error') {
        statusEl.style.color = '#e74c3c';
        statusEl.style.borderColor = 'rgba(231, 76, 60, 0.5)';
    } else if (type === 'success') {
        statusEl.style.color = '#27ae60';
        statusEl.style.borderColor = 'rgba(39, 174, 96, 0.5)';
    } else {
        statusEl.style.color = '#f4f4f4';
        statusEl.style.borderColor = 'rgba(72, 202, 228, 0.35)';
    }
}

function getRiskLocation() {
    if (!navigator.geolocation) {
        setRiskStatus('Geolocation is not supported by this browser.', 'error');
        showNotification('Geolocation is not supported', 'error');
        return;
    }
    navigator.geolocation.getCurrentPosition(
        function (position) {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            document.getElementById('riskLatitude').value = lat.toFixed(6);
            document.getElementById('riskLongitude').value = lng.toFixed(6);
            setRiskStatus(
                `📍 Location captured: ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
                'info'
            );
            showNotification('Location captured for risk estimate');
        },
        function (error) {
            setRiskStatus('Error getting location: ' + error.message, 'error');
            showNotification('Error getting location: ' + error.message, 'error');
        }
    );
}

function formatRiskWindow(window) {
    if (!window) return '—';
    const start = window.start ? new Date(window.start) : null;
    const end = window.end ? new Date(window.end) : null;
    const range = start && end && !Number.isNaN(start.getTime())
        ? `${start.toLocaleString()} → ${end.toLocaleString()}`
        : window.label || '—';
    return `${escapeHtml(window.label || '')}<div style="font-size:0.8rem;font-weight:500;color:#a9c6de;margin-top:4px;">${escapeHtml(range)}</div>`;
}

function coverageList(coverage) {
    if (!coverage) return '';
    const req = coverage.required || {};
    return `
        <div class="risk-meta-grid">
            <div class="risk-meta-item">
                <div class="risk-meta-label">Historical records</div>
                <div class="risk-meta-value">${coverage.historicalEventCount} / ${req.minHistoricalEvents} min</div>
            </div>
            <div class="risk-meta-item">
                <div class="risk-meta-label">Span (days)</div>
                <div class="risk-meta-value">${coverage.spanDays} / ${req.minSpanDays} min</div>
            </div>
            <div class="risk-meta-item">
                <div class="risk-meta-label">Distinct days</div>
                <div class="risk-meta-value">${coverage.uniqueDays} / ${req.minUniqueDays} min</div>
            </div>
            <div class="risk-meta-item">
                <div class="risk-meta-label">Current weather/alerts</div>
                <div class="risk-meta-value">${coverage.environmentalSignalCount} / ${req.minEnvironmentalSignals} min</div>
            </div>
        </div>
    `;
}

function renderRiskComponentBars(components) {
    if (!components) return '';
    const rows = [];
    if (components.historical) {
        for (const [k, v] of Object.entries(components.historical)) {
            rows.push({ group: 'Historical', name: k, value: Math.round(Number(v) * 100) });
        }
    }
    if (components.environmental) {
        for (const [k, v] of Object.entries(components.environmental)) {
            rows.push({ group: 'Environmental', name: k, value: Math.round(Number(v) * 100) });
        }
    }
    if (!rows.length) return '';
    return `
        <div style="margin-top:0.75rem;">
            <h5 style="margin:0 0 0.5rem 0; color:#48cae4; font-size:0.82rem;">Component Indicator Signals</h5>
            ${rows.map(r => `
                <div style="margin-bottom:6px; font-size:0.78rem;">
                    <div style="display:flex; justify-content:space-between; color:#a9c6de; margin-bottom:2px;">
                        <span><strong style="color:#e8eef7;">${escapeHtml(r.group)}</strong> · ${escapeHtml(r.name)}</span>
                        <span>${r.value}%</span>
                    </div>
                    <div style="height:5px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden;">
                        <div style="width:${Math.min(100, Math.max(0, r.value))}%; height:100%; background:linear-gradient(90deg, #00b4d8, #e74c3c); border-radius:3px;"></div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderEnvSummary(stats) {
    if (!stats) return '';
    const items = [
        stats.maxNearbyRainfallMm != null ? `Rain: ${stats.maxNearbyRainfallMm} mm` : null,
        stats.maxForecastRainfallMm != null ? `Forecast rain: ${stats.maxForecastRainfallMm} mm` : null,
        stats.maxNearbyWindKmh != null ? `Wind: ${stats.maxNearbyWindKmh} km/h` : null,
        stats.maxNearbyHumidityPct != null ? `Humidity: ${stats.maxNearbyHumidityPct}%` : null,
        stats.maxNearbyTemperatureC != null ? `Temp: ${stats.maxNearbyTemperatureC} °C` : null,
        stats.maxSoilMoisturePct != null ? `Soil moisture: ${stats.maxSoilMoisturePct}%` : null,
        stats.maxRiverLevel != null ? `River level: ${stats.maxRiverLevel}` : null
    ].filter(Boolean);
    if (!items.length) return '';
    return `<div style="font-size:0.8rem; color:#8ecae6; margin-top:0.4rem;"><i class="fas fa-smog"></i> Observed inputs: ${items.map(escapeHtml).join(' · ')}</div>`;
}

function renderMethodNote(method, limitations) {
    return `
        <div class="risk-disclaimer-box">
            <strong><i class="fas fa-shield-alt"></i> Model & Accuracy Status:</strong>
            <div style="margin-top:4px;">
                This future risk score is an indicator index combining historical records and current ingested weather/alert signals.
                <strong>It is not a guaranteed disaster prediction</strong>.
                ${method && method.evaluatedOnValidationDataset === false
                    ? '<div style="margin-top:3px; font-style:italic;">Note: This method has NOT been evaluated on a held-out validation dataset. No predictive accuracy or hit-rate is claimed.</div>'
                    : ''}
            </div>
        </div>
    `;
}

function renderRiskEstimateCard(data) {
    if (!data) return '';
    const loc = data.location || {};
    const win = data.timeWindow || {};
    const risk = data.riskEstimate;
    const gate = data.gate || {};
    const conf = data.confidence || {};
    const factors = data.contributingFactors || [];

    if (!data.available || !risk) {
        const missingList = (gate.missing || []).map((m) => `<li>${escapeHtml(m)}</li>`).join('');
        return `
            <div class="risk-card" style="border-color: rgba(243, 156, 18, 0.4);">
                <div class="risk-card-header">
                    <div>
                        <div class="risk-title" style="color:#f39c12;"><i class="fas fa-exclamation-circle"></i> Risk Estimate Withheld</div>
                        <div style="color:#a9c6de; font-size:0.88rem; margin-top:2px;">Location: <strong>${escapeHtml(loc.name || 'Selected area')}</strong> (${loc.latitude}, ${loc.longitude}) · Radius: ${loc.radiusKm || 80} km</div>
                    </div>
                    <span class="risk-band-pill moderate">Insufficient Data</span>
                </div>
                <p style="color:#f4f4f4; font-size:0.92rem; margin:0.5rem 0;">
                    A future risk score is only computed when sufficient local historical records and current environmental observations exist.
                </p>
                <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:12px; margin:0.75rem 0;">
                    <h5 style="margin:0 0 0.5rem 0; color:#f39c12; font-size:0.85rem;">Unmet Sufficiency Requirements</h5>
                    <ul style="margin:0; padding-left:1.2rem; color:#e8eef7; font-size:0.86rem; line-height:1.5;">
                        ${missingList || '<li>Data gate requirements were not satisfied.</li>'}
                    </ul>
                </div>
                ${coverageList(data.dataCoverage)}
                <div style="margin-top:1rem;">
                    <h5 style="margin:0 0 0.4rem 0; color:#48cae4; font-size:0.85rem;">How to Enable an Estimate</h5>
                    <p style="color:#bdc3c7; font-size:0.85rem; margin:0 0 0.5rem 0;">
                        Use the <strong>Fetch Historical Data</strong> button above to pull real historical disaster records for this area from NASA EONET, or widen your search radius.
                    </p>
                </div>
                ${renderMethodNote(data.method, data.limitations)}
            </div>
        `;
    }

    const bandKey = (risk.band || 'moderate').toLowerCase();
    const factorsList = factors.map((f) => `<li>${escapeHtml(f.text || f)}</li>`).join('');

    return `
        <div class="risk-card">
            <div class="risk-card-header">
                <div>
                    <div class="risk-title"><i class="fas fa-chart-line"></i> Future Risk Estimate</div>
                    <div style="color:#a9c6de; font-size:0.88rem; margin-top:2px;">
                        Location: <strong>${escapeHtml(loc.name)}</strong> (${loc.latitude}, ${loc.longitude}) · Radius: ${loc.radiusKm} km
                    </div>
                </div>
                <span class="risk-band-pill ${bandKey}">${escapeHtml(risk.bandLabel || bandKey)}</span>
            </div>

            <div class="risk-score-hero">
                <div class="risk-score-circle">
                    <span class="risk-score-number">${risk.score}</span>
                    <span class="risk-score-max">/ 100</span>
                </div>
                <div style="flex:1;">
                    <h4 style="margin:0 0 4px 0; color:#f4f4f4;">Primary Hazard Indicator: <span style="color:#00b4d8; text-transform:uppercase;">${escapeHtml(risk.primaryHazardType || 'Hazard')}</span></h4>
                    <p style="margin:0; color:#bdc3c7; font-size:0.88rem; line-height:1.4;">
                        Combined indicator index (40% historical disaster pattern + 60% active environmental/weather variables).
                    </p>
                    ${renderEnvSummary(risk.stats)}
                </div>
            </div>

            <div class="risk-breakdown-grid">
                <div class="risk-breakdown-box">
                    <div class="risk-breakdown-title">Historical Sub-score</div>
                    <div class="risk-breakdown-val">${risk.historicalScore} <span style="font-size:0.75rem; color:#a9c6de;">/ 100</span></div>
                    <div style="font-size:0.75rem; color:#8aa2bb;">From ${risk.stats?.eventCount || 0} local disaster records</div>
                </div>
                <div class="risk-breakdown-box">
                    <div class="risk-breakdown-title">Environmental Sub-score</div>
                    <div class="risk-breakdown-val">${risk.environmentalScore} <span style="font-size:0.75rem; color:#a9c6de;">/ 100</span></div>
                    <div style="font-size:0.75rem; color:#8aa2bb;">From current weather & warnings</div>
                </div>
                <div class="risk-breakdown-box">
                    <div class="risk-breakdown-title">Planning Time Window</div>
                    <div class="risk-breakdown-val" style="font-size:1rem; color:#e8eef7;">${formatRiskWindow(win)}</div>
                </div>
                <div class="risk-breakdown-box">
                    <div class="risk-breakdown-title">Confidence / Uncertainty</div>
                    <div class="risk-breakdown-val" style="font-size:1.1rem; color:#48cae4;">
                        ${Math.round((conf.score || 0) * 100)}%
                        <span style="font-size:0.75rem; color:#a9c6de;">(${escapeHtml(conf.label || '')} uncertainty)</span>
                    </div>
                    <div style="font-size:0.72rem; color:#8aa2bb; margin-top:2px;">Reflects data coverage & agreement</div>
                </div>
            </div>

            ${renderRiskComponentBars(risk.components)}

            <div style="margin-top:1rem;">
                <h5 style="margin:0 0 0.5rem 0; color:#48cae4; font-size:0.85rem;"><i class="fas fa-list-check"></i> Main Contributing Factors</h5>
                <ul class="risk-factors-list">
                    ${factorsList || '<li>No specific factors reported.</li>'}
                </ul>
            </div>

            <div style="margin-top:1rem;">
                <h5 style="margin:0 0 0.3rem 0; color:#a9c6de; font-size:0.8rem;">Data Coverage</h5>
                ${coverageList(data.dataCoverage)}
            </div>

            ${renderMethodNote(data.method, data.limitations)}
        </div>
    `;
}

async function estimateLocationRisk() {
    const lat = document.getElementById('riskLatitude').value.trim();
    const lng = document.getElementById('riskLongitude').value.trim();
    const radius = document.getElementById('riskRadius').value.trim() || 80;
    const horizon = document.getElementById('riskHorizon').value.trim() || 48;
    const name = document.getElementById('riskLocationName').value.trim();

    if (!lat || !lng) {
        setRiskStatus('Please enter latitude and longitude, or use "Use My Current Location".', 'error');
        return;
    }

    setRiskStatus('<i class="fas fa-spinner fa-spin"></i> Checking historical records and current environmental signals...', 'info');
    const resultArea = document.getElementById('riskResultArea');
    resultArea.style.display = 'none';

    try {
        const response = await fetch(`${API_BASE}/api/risk/estimate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                latitude: Number(lat),
                longitude: Number(lng),
                radiusKm: Number(radius),
                horizonHours: Number(horizon),
                locationName: name
            })
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            setRiskStatus(`Failed to compute risk estimate: ${data.error || 'Server error'}`, 'error');
            return;
        }

        setRiskStatus('Risk assessment completed.', 'success');
        resultArea.innerHTML = renderRiskEstimateCard(data);
        resultArea.style.display = 'block';
    } catch (error) {
        console.error('estimateLocationRisk error:', error);
        setRiskStatus(`Network error: ${error.message}`, 'error');
    }
}

async function scanRiskAreas() {
    const radius = document.getElementById('riskRadius').value.trim() || 80;
    const horizon = document.getElementById('riskHorizon').value.trim() || 48;
    const scanArea = document.getElementById('riskScanArea');
    scanArea.style.display = 'block';
    scanArea.innerHTML = '<div style="padding:1rem; text-align:center; color:#a9c6de;"><i class="fas fa-spinner fa-spin"></i> Scanning regional clusters for sufficient historical + environmental data...</div>';

    try {
        const response = await fetch(`${API_BASE}/api/risk/scan?radiusKm=${encodeURIComponent(radius)}&horizonHours=${encodeURIComponent(horizon)}`);
        const data = await response.json();
        if (!response.ok || !data.success) {
            scanArea.innerHTML = `<div style="color:#e74c3c; padding:1rem;">Failed to scan: ${escapeHtml(data.error || 'Error')}</div>`;
            return;
        }

        const estimates = data.estimates || [];
        if (!estimates.length) {
            scanArea.innerHTML = `
                <div class="risk-card" style="border-color:rgba(243, 156, 18, 0.4);">
                    <h4 style="margin:0 0 0.5rem 0; color:#f39c12;"><i class="fas fa-info-circle"></i> No Areas Meet Data Sufficiency Requirements</h4>
                    <p style="color:#e8eef7; font-size:0.9rem; margin:0;">
                        Across all scanned clusters, none currently meet the minimum threshold of ${data.thresholds?.minHistoricalEvents || 8} historical disaster events and active environmental signals.
                    </p>
                    <div style="margin-top:0.75rem;">
                        Use <strong>Fetch Historical Data</strong> for any coordinate to import real NASA EONET disaster history.
                    </div>
                </div>
            `;
            return;
        }

        scanArea.innerHTML = `
            <div style="margin-bottom:1rem;">
                <h3 style="color:#48cae4; margin:0 0 0.5rem 0;"><i class="fas fa-map-marked-alt"></i> Qualifying Risk Areas (${estimates.length})</h3>
                <p style="color:#a9c6de; font-size:0.88rem; margin:0;">Only areas with enough real historical data and current signals are displayed.</p>
            </div>
            ${estimates.map(renderRiskEstimateCard).join('')}
        `;
    } catch (error) {
        console.error('scanRiskAreas error:', error);
        scanArea.innerHTML = `<div style="color:#e74c3c; padding:1rem;">Error scanning areas: ${escapeHtml(error.message)}</div>`;
    }
}

async function fetchHistoricalAndRisk() {
    const lat = document.getElementById('riskLatitude').value.trim();
    const lng = document.getElementById('riskLongitude').value.trim();
    const radius = document.getElementById('riskRadius').value.trim() || 80;
    const name = document.getElementById('riskLocationName').value.trim();
    const startDate = document.getElementById('riskStartDate').value;
    const endDate = document.getElementById('riskEndDate').value;
    const btn = document.getElementById('fetchHistoricalBtn');

    if (!lat || !lng) {
        setRiskStatus('Please enter latitude and longitude before fetching historical data.', 'error');
        return;
    }

    if (btn) btn.disabled = true;
    setRiskStatus('<i class="fas fa-spinner fa-spin"></i> Fetching real historical disaster records from NRSC/ISRO & public disaster catalogs...', 'info');
    const resultArea = document.getElementById('riskResultArea');
    resultArea.style.display = 'none';

    try {
        const response = await fetch(`${API_BASE}/api/historical-data/fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                latitude: Number(lat),
                longitude: Number(lng),
                radius_km: Number(radius),
                start_date: startDate || undefined,
                end_date: endDate || undefined,
                location_name: name
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            const errDetail = data.error || (response.status === 404 ? 'API endpoint not found on backend server' : `HTTP error ${response.status}`);
            setRiskStatus(`Historical fetch failed: ${escapeHtml(errDetail)}`, 'error');
            return;
        }

        const summary = data.data_summary || {};
        const risk = data.risk_estimate?.riskEstimate || {};
        const coverage = data.risk_estimate?.dataCoverage || {};

        const histRecords = summary.historicalEventCount ?? coverage.historicalEventCount ?? data.records_saved;
        const spanDays = summary.spanDays ?? coverage.spanDays ?? 0;
        const uniqueDays = summary.uniqueDays ?? coverage.uniqueDays ?? 0;
        const histScore = summary.historicalScore != null ? summary.historicalScore : (risk.historicalScore != null ? risk.historicalScore : '—');
        const envScore = summary.environmentalScore != null ? summary.environmentalScore : (risk.environmentalScore != null ? risk.environmentalScore : '—');
        const finalScore = summary.finalScore != null ? summary.finalScore : (risk.score != null ? risk.score : '—');

        setRiskStatus(`
            <div style="font-weight:700; margin-bottom:4px; color:#2ecc71;">
                <i class="fas fa-check-circle"></i> ${escapeHtml(data.message || 'Historical data synchronized successfully')}
            </div>
            <div style="font-size:0.85rem; color:#a9c6de; margin-bottom:8px;">
                Source: <strong>${escapeHtml(data.source || 'NRSC/ISRO')}</strong> · Records fetched: ${data.records_fetched} · Saved: ${data.records_saved} · Skipped (duplicates): ${data.records_skipped}
            </div>
            <div class="risk-meta-grid" style="margin-top:6px; font-size:0.85rem;">
                <div class="risk-meta-item">
                    <div class="risk-meta-label">Historical records</div>
                    <div class="risk-meta-value">${histRecords}</div>
                </div>
                <div class="risk-meta-item">
                    <div class="risk-meta-label">Historical span</div>
                    <div class="risk-meta-value">${spanDays} days</div>
                </div>
                <div class="risk-meta-item">
                    <div class="risk-meta-label">Distinct days</div>
                    <div class="risk-meta-value">${uniqueDays}</div>
                </div>
                <div class="risk-meta-item">
                    <div class="risk-meta-label">Historical Risk Score</div>
                    <div class="risk-meta-value" style="color:#48cae4;">${histScore}/100</div>
                </div>
                <div class="risk-meta-item">
                    <div class="risk-meta-label">Environmental Risk Score</div>
                    <div class="risk-meta-value" style="color:#48cae4;">${envScore}/100</div>
                </div>
                <div class="risk-meta-item">
                    <div class="risk-meta-label">Final Risk Score</div>
                    <div class="risk-meta-value" style="color:#ff6b6b; font-weight:700;">${finalScore}/100</div>
                </div>
            </div>
        `, 'success');

        showNotification(`Historical Data: ${data.records_saved} new events added to database`);
        loadHistoricalSyncStatus();

        if (data.risk_estimate) {
            resultArea.innerHTML = renderRiskEstimateCard(data.risk_estimate);
            resultArea.style.display = 'block';
        }
    } catch (error) {
        console.error('fetchHistoricalAndRisk error:', error);
        setRiskStatus(`Historical fetch failed: ${escapeHtml(error.message || 'Network error')}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function loadHistoricalSyncStatus() {
    const el = document.getElementById('lastHistoricalSync');
    if (!el) return;
    try {
        const response = await fetch(`${API_BASE}/api/historical-data/status`);
        const data = await response.json();
        if (!response.ok || !data.success) return;
        const last = data.last_sync;
        if (last && (last.last_sync_at || last.last_success_at)) {
            const time = new Date(last.last_success_at || last.last_sync_at).toLocaleString();
            const details = last.details || {};
            el.style.display = 'block';
            el.innerHTML = `<i class="fas fa-info-circle"></i> Last Historical sync (${escapeHtml(last.source || 'NRSC/ISRO')}): <strong>${escapeHtml(time)}</strong> (${details.saved || 0} saved in last request).`;
        }
    } catch (error) {
        console.error(error);
    }
}

function initializeHistoricalDateDefaults() {
    const startEl = document.getElementById('riskStartDate');
    const endEl = document.getElementById('riskEndDate');
    if (!startEl || !endEl) return;
    if (!startEl.value || !endEl.value) {
        const today = new Date();
        const yearAgo = new Date(today.getTime() - 365 * 86400000);
        endEl.value = today.toISOString().slice(0, 10);
        startEl.value = yearAgo.toISOString().slice(0, 10);
    }
}
