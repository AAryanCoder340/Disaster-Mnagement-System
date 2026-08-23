const { normalizeDisasterType } = require('../lib/geo');
const { geocodePlace, centroidOfPolygon } = require('../lib/geocode');

function sachetRssUrl() {
  return (process.env.SACHET_RSS_URL || '').trim();
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
}

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const chunk = block.split(/<\/item>/i)[0] || '';
    items.push({
      title: extractTag(chunk, 'title'),
      link: extractTag(chunk, 'link'),
      description: extractTag(chunk, 'description'),
      pubDate: extractTag(chunk, 'pubDate'),
      guid: extractTag(chunk, 'guid'),
      author: extractTag(chunk, 'author')
    });
  }
  return items;
}

function identifierFromLink(link) {
  if (!link) return null;
  const match = String(link).match(/identifier=([^&]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchCapXml(identifier, etag) {
  const url = `https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${encodeURIComponent(identifier)}`;
  const headers = { Accept: 'application/xml,text/xml,*/*' };
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 304) {
    return { unchanged: true, etag };
  }
  const xml = await response.text();
  return {
    unchanged: false,
    status: response.status,
    ok: response.ok,
    xml,
    etag: response.headers.get('etag')
  };
}

function normalizeCapXml(xml, fallbackItem) {
  const identifier = extractTag(xml, 'identifier') || fallbackItem.guid || fallbackItem.link;
  const event = extractTag(xml, 'event') || fallbackItem.title || 'NDMA alert';
  const headline = extractTag(xml, 'headline') || fallbackItem.title;
  const description = extractTag(xml, 'description') || fallbackItem.description || headline;
  const areaDesc = extractTag(xml, 'areaDesc');
  const polygon = extractTag(xml, 'polygon');
  const sent = extractTag(xml, 'sent') || fallbackItem.pubDate;
  const expires = extractTag(xml, 'expires');
  const severityRaw = (extractTag(xml, 'severity') || '').toLowerCase();
  const sender = extractTag(xml, 'sender') || extractTag(xml, 'senderName') || fallbackItem.author;
  const coords = centroidOfPolygon(polygon) || geocodePlace(areaDesc || headline || description);
  let severity = 'medium';
  if (severityRaw.includes('extreme') || severityRaw.includes('severe')) severity = 'high';
  if (severityRaw.includes('minor')) severity = 'low';

  return {
    source: /imd/i.test(String(sender || '')) ? 'IMD_SACHET' : 'NDMA_SACHET',
    sourceType: /imd/i.test(String(sender || '')) ? 'IMD_WARNING' : 'NDMA_ALERT',
    externalId: `sachet-${identifier}`,
    disasterType: normalizeDisasterType(event),
    warningType: event,
    locationName: areaDesc || 'India',
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    severity,
    description: [headline, description].filter(Boolean).join(' — '),
    issuedAt: sent,
    validUntil: expires,
    raw: { identifier, sender }
  };
}

function normalizeRssItem(item) {
  const coords = geocodePlace(`${item.title || ''} ${item.description || ''}`);
  return {
    source: 'NDMA_SACHET',
    sourceType: 'NDMA_ALERT',
    externalId: `sachet-rss-${item.guid || item.link || item.title}`,
    disasterType: normalizeDisasterType(item.title || item.description),
    warningType: item.title || 'CAP alert',
    locationName: item.title || 'India',
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    severity: 'medium',
    description: item.description || item.title || 'NDMA SACHET RSS alert',
    issuedAt: item.pubDate,
    raw: item
  };
}

async function fetchSachetAlerts() {
  const rssUrl = sachetRssUrl();
  if (!rssUrl) {
    return {
      configured: false,
      live: false,
      error: 'SACHET RSS URL is not configured. The CapFeed page is HTML; set SACHET_RSS_URL to the official RSS XML endpoint from NDMA if you have it. CAP XML is documented as https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=...',
      alerts: []
    };
  }

  try {
    const response = await fetch(rssUrl, {
      headers: { Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
      signal: AbortSignal.timeout(25000)
    });
    const xml = await response.text();
    if (!response.ok) {
      return {
        configured: true,
        live: false,
        error: `SACHET RSS HTTP ${response.status}`,
        alerts: []
      };
    }
    if (!/<rss|<feed/i.test(xml)) {
      return {
        configured: true,
        live: false,
        error: 'SACHET_RSS_URL did not return RSS/Atom XML. Do not use the CapFeed HTML page as a live feed.',
        alerts: []
      };
    }

    const items = parseRssItems(xml).slice(0, 25);
    const alerts = [];
    for (const item of items) {
      const identifier = identifierFromLink(item.link) || identifierFromLink(item.guid);
      if (identifier) {
        try {
          const cap = await fetchCapXml(identifier);
          if (cap.ok && cap.xml && /<alert/i.test(cap.xml)) {
            alerts.push(normalizeCapXml(cap.xml, item));
            continue;
          }
        } catch (_error) {
          // Fall back to RSS item fields; do not fail the whole ingest.
        }
      }
      alerts.push(normalizeRssItem(item));
    }

    return {
      configured: true,
      live: true,
      error: null,
      alerts
    };
  } catch (error) {
    return {
      configured: true,
      live: false,
      error: error.message,
      alerts: []
    };
  }
}

module.exports = {
  fetchSachetAlerts,
  sachetRssUrl
};
