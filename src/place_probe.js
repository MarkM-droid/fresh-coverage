/**
 * place_probe.js — Brave Place Search probe for Amazon facility discovery
 *
 * Uses Brave's Place Search API (lat/lng + radius) to find Amazon facilities
 * near each DMA centroid. Filters for distribution/fulfillment/delivery
 * facility types and excludes corporate offices, data centers, retail stores, etc.
 *
 * Results are written to the locations table and city_coverage is updated.
 *
 * Usage:
 *   node src/place_probe.js [--max 50] [--radius 25000] [--dry-run]
 *
 * Options:
 *   --max      max DMAs to probe this session (default: 50)
 *   --radius   search radius in meters (default: 25000 = ~15 miles)
 *   --dry-run  print results without writing to DB
 *
 * Env: BRAVE_API_KEY
 */

import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH  = join(PROJECT_ROOT, 'data', 'coverage.db');
const LOGS_DIR = join(PROJECT_ROOT, 'logs');

const PLACE_SEARCH_URL = 'https://api.search.brave.com/res/v1/local/place_search';
const RETAILER_ID = 'amazon_same_day';
const DELAY_MS = 1500;

// Multiple queries per DMA to maximize coverage — Brave index is sparse
const PLACE_QUERIES = [
  'Amazon Fresh',
  'Amazon warehouse',
  'Amazon fulfillment center',
  'Amazon delivery station',
];

// ─── Facility name patterns to INCLUDE ────────────────────────────────────────
// Amazon internal station codes: 3-letter airport code + digit(s), e.g. LAX6, SNY1, DH05
const STATION_CODE = /\b[A-Z]{2,4}\d{1,2}\b/;

const INCLUDE_PATTERNS = [
  /amazon\s+fresh\s+(?!pickup|store|market|bakery|deli|seafood|meat|produce|floral)/i,  // Amazon Fresh distribution (not pickup/retail/in-store dept)
  /amazon\s+same.?day/i,
  /amazon\s+delivery\s+station/i,
  /amazon\s+fulfillment/i,
  /amazon\s+(dss|d\d|dh\d|da\d)\d*/i,          // Delivery station codes DSS, D1, DH05 etc.
  /amazon\s+warehouse/i,
  /amazon\s+sortation/i,
  /amazon\s+logistics/i,
  /amazon\s+distribution/i,
  /amazon\s+sub.?same/i,
  /amazon\s+flex/i,
];

// ─── Facility name/category patterns to EXCLUDE ───────────────────────────────
const EXCLUDE_PATTERNS = [
  /amazon\s+fresh\s+pickup/i,       // Retail pickup locations
  /amazon\s+fresh\s+store/i,
  /amazon\s+fresh\s+bakery/i,       // Whole Foods in-store bakery (appears as Amazon Fresh Bakery)
  /amazon\s+fresh\s+market/i,
  /amazon\s+fresh\s+pickup/i,       // Customer pickup locations
  /amazon\s+go/i,                   // Amazon Go retail stores
  /whole\s+foods\s+(market)?$/i,    // Whole Foods retail stores
  /^whole\s+foods/i,
  /amazon\s+books/i,
  /amazon\s+4\s*star/i,
  /amazon\s+pop.?up/i,
  /aws\b/i,
  /amazon\s+web\s+services/i,
  /data\s+center/i,
  /corporate\s+headquarters/i,
  /amazon\s+hq/i,
  /amazon\.com\s+hq/i,
  /customer\s+service\s+center/i,
  /call\s+center/i,
  /^the\s+fresh\s+market/i,         // The Fresh Market retail chain (unrelated)
  /freshdirect/i,                   // FreshDirect (competitor)
  /^fresh\b/i,                      // Generic "Fresh" branded places
  /3pl\s+warehouse/i,               // Third-party logistics, not Amazon
  /amazon\s+prep\s+center/i,        // FBA prep services (not Amazon-operated)
  /fba\s+fulfillment/i,
  /prep\s+services/i,               // Third-party prep services
  /^whole\s+foods/i,                // Whole Foods retail (any variant)
  /whole\s+foods\s+market/i,
];

// Category strings from Brave POI that suggest logistics (helpful signal)
const LOGISTICS_CATEGORIES = [
  'warehouse', 'fulfillment', 'distribution', 'logistics',
  'delivery', 'freight', 'shipping', 'storage',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg, logFile) {
  const line = `[place_probe] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  if (logFile) try { appendFileSync(logFile, line + '\n'); } catch {}
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : null; };
  return {
    maxDMAs:  parseInt(get('--max') || '50', 10),
    radius:   parseInt(get('--radius') || '25000', 10),
    dryRun:   args.includes('--dry-run'),
  };
}

function classifyFacility(result) {
  const name = result.title || '';
  const cats = (result.categories || []).join(' ').toLowerCase();
  const desc = (result.description || '').toLowerCase();

  // Hard exclude by name pattern
  for (const pat of EXCLUDE_PATTERNS) {
    if (pat.test(name)) return 'exclude';
  }

  // Exclude by category — grocery/bakery/retail categories = retail store not a facility
  const retailCats = ['grocery', 'bakery', 'supermarket', 'retail', 'food', 'restaurant', 'cafe', 'coffee'];
  if (/amazon/i.test(name) && retailCats.some(c => cats.includes(c))) return 'exclude';

  // Hard include — name matches known facility type
  for (const pat of INCLUDE_PATTERNS) {
    if (pat.test(name)) return 'include';
  }

  // Station code pattern: "Amazon XYZ1" where XYZ1 is an internal code
  if (/amazon/i.test(name) && STATION_CODE.test(name)) return 'include';

  // Soft include — name contains "Amazon" and categories suggest logistics
  if (/amazon/i.test(name)) {
    for (const cat of LOGISTICS_CATEGORIES) {
      if (cats.includes(cat) || desc.includes(cat)) return 'include';
    }
    // Amazon with "building" category = likely unlabeled facility
    if (cats.includes('building')) return 'include';
    // Amazon with no useful category — flag as review
    return 'review';
  }

  return 'skip';
}

function inferFacilityType(name) {
  if (/fresh/i.test(name)) return 'fresh_distribution';
  if (/same.?day|sub.?same/i.test(name)) return 'ssd_fulfillment';
  if (/delivery\s+station/i.test(name)) return 'delivery_station';
  if (/fulfillment/i.test(name)) return 'fulfillment_center';
  if (/sortation/i.test(name)) return 'sortation_center';
  if (/warehouse/i.test(name)) return 'warehouse';
  if (/distribution/i.test(name)) return 'distribution_center';
  if (/logistics/i.test(name)) return 'logistics_facility';
  if (/flex/i.test(name)) return 'delivery_station'; // Flex = pickup at delivery station
  return 'amazon_facility';
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const { maxDMAs, radius, dryRun } = parseArgs();
const apiKey = process.env.BRAVE_API_KEY;
if (!apiKey) { console.error('BRAVE_API_KEY not set'); process.exit(1); }

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
const logFile = join(LOGS_DIR, `place_probe_${new Date().toISOString().slice(0,10)}.log`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Get DMAs with centroid coordinates, prioritized by tier
// Skip DMAs we've already place-probed today
const today = new Date().toISOString().slice(0, 10);
const dmas = db.prepare(`
  SELECT d.id, d.name, d.tier, d.centroid_lat, d.centroid_lng
  FROM dmas d
  WHERE d.centroid_lat IS NOT NULL
    AND d.centroid_lng IS NOT NULL
    AND d.tier NOT IN ('micro')
    AND d.id NOT IN (
      SELECT DISTINCT dma_id FROM locations
      WHERE source_url LIKE 'brave_place_%'
        AND discovered_at >= strftime('%s', ?)
    )
  ORDER BY
    CASE d.tier WHEN 'mega' THEN 1 WHEN 'large' THEN 2 WHEN 'mid' THEN 3 WHEN 'small' THEN 4 ELSE 5 END,
    d.tv_homes DESC
  LIMIT ?
`).all(today, maxDMAs);

log(`Starting place probe: ${dmas.length} DMAs, radius=${radius}m, dryRun=${dryRun}`, logFile);

// Prepared statements
const insertLocation = db.prepare(`
  INSERT OR IGNORE INTO locations
    (retailer_id, address_raw, address_normalized, city, state, zip, lat, lng,
     type, source_url, discovered_at, dma_id, radius_miles)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), ?, ?)
`);

const upsertCity = db.prepare(`
  INSERT INTO city_coverage (retailer_id, city, state, available, first_seen, last_confirmed,
                             source, source_url, notes, confidence, dma_id)
  VALUES (?, ?, ?, 1, strftime('%s','now'), strftime('%s','now'),
          'brave_place', ?, ?, 85, ?)
  ON CONFLICT(retailer_id, city, state) DO UPDATE SET
    available = 1,
    last_confirmed = strftime('%s','now'),
    confidence = MAX(confidence, 85),
    source = 'brave_place',
    notes = excluded.notes
`);

const upsertDmaCoverage = db.prepare(`
  INSERT INTO dma_coverage (retailer_id, dma_id, cities_total, cities_confirmed,
                            cities_unavailable, cities_unknown, coverage_pct, confidence, last_updated)
  SELECT ?, d.id,
    COUNT(DISTINCT c.id) as total,
    SUM(CASE WHEN cc.available=1 THEN 1 ELSE 0 END) as confirmed,
    SUM(CASE WHEN cc.available=0 THEN 1 ELSE 0 END) as unavailable,
    SUM(CASE WHEN cc.available IS NULL THEN 1 ELSE 0 END) as unknown,
    ROUND(100.0 * SUM(CASE WHEN cc.available=1 THEN 1 ELSE 0 END) / COUNT(DISTINCT c.id), 1),
    70,
    strftime('%s','now')
  FROM dmas d
  JOIN cities c ON c.dma_id = d.id
  LEFT JOIN city_coverage cc ON cc.city=c.city AND cc.state=c.state AND cc.retailer_id=?
  WHERE d.id = ?
  GROUP BY d.id
  ON CONFLICT(retailer_id, dma_id) DO UPDATE SET
    cities_confirmed = excluded.cities_confirmed,
    coverage_pct = excluded.coverage_pct,
    last_updated = excluded.last_updated
`);

const insertSignal = db.prepare(`
  INSERT INTO signals (retailer_id, dma_id, city, state, zip, signal_type,
                       source, source_url, snippet, confidence, discovered_at)
  VALUES (?, ?, ?, ?, ?, 'facility_address', 'brave_place', ?, ?, ?, strftime('%s','now'))
`);

let totalFound = 0;
let totalNew = 0;
let totalReview = 0;

for (let i = 0; i < dmas.length; i++) {
  const dma = dmas[i];

  // Run multiple queries per DMA, deduplicate by coordinate key
  const seenCoords = new Set();
  const allResults = [];

  for (const query of PLACE_QUERIES) {
    const params = new URLSearchParams({
      q: query,
      latitude: dma.centroid_lat,
      longitude: dma.centroid_lng,
      radius,
      count: 20,
      country: 'US',
    });

    try {
      const resp = await fetch(`${PLACE_SEARCH_URL}?${params}`, {
        headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' }
      });
      if (resp.status === 429) {
        log(`Rate limited — pausing 30s...`, logFile);
        await sleep(30000);
        // retry this query
        const resp2 = await fetch(`${PLACE_SEARCH_URL}?${params}`, {
          headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' }
        });
        const d2 = await resp2.json();
        (d2.results || []).forEach(r => { const k = `${r.coordinates?.[0]},${r.coordinates?.[1]}`; if (!seenCoords.has(k)) { seenCoords.add(k); allResults.push(r); } });
      } else if (resp.ok) {
        const d = await resp.json();
        (d.results || []).forEach(r => { const k = `${r.coordinates?.[0]},${r.coordinates?.[1]}`; if (!seenCoords.has(k)) { seenCoords.add(k); allResults.push(r); } });
      }
    } catch (err) {
      log(`Fetch error for ${dma.name} query "${query}": ${err.message}`, logFile);
    }
    await sleep(DELAY_MS);
  }

  const results = allResults;
  const sourceTag = `brave_place_${today}`;

  let dmaFound = 0;
  let dmaReview = 0;

  for (const r of results) {
    const decision = classifyFacility(r);
    if (decision === 'skip') continue;

    const addr = r.postal_address || {};
    const city = addr.addressLocality || '';
    const state = addr.addressRegion || '';
    const zip = addr.postalCode || '';
    const lat = r.coordinates?.[0];
    const lng = r.coordinates?.[1];
    const addrRaw = addr.displayAddress || r.title;
    const facilityType = inferFacilityType(r.title);
    const snippet = `${r.title} — ${addrRaw}`;
    const radiusMiles = Math.round(radius / 1609);

    if (decision === 'review') {
      dmaReview++;
      totalReview++;
      log(`  REVIEW: "${r.title}" @ ${addrRaw} (${city}, ${state}) [${(r.categories||[]).join(', ')}]`, logFile);
      continue;
    }

    // decision === 'include'
    dmaFound++;
    totalFound++;
    log(`  FOUND: "${r.title}" [${facilityType}] @ ${addrRaw} (${city}, ${state} ${zip})`, logFile);

    if (!dryRun) {
      const existing = db.prepare(
        `SELECT id FROM locations WHERE retailer_id=? AND lat=? AND lng=?`
      ).get(RETAILER_ID, lat, lng);

      if (!existing) {
        totalNew++;
        insertLocation.run(
          RETAILER_ID, addrRaw, addrRaw, city, state, zip,
          lat, lng, facilityType, sourceTag, dma.id, radiusMiles
        );
        insertSignal.run(RETAILER_ID, dma.id, city, state, zip, sourceTag, snippet, 85);
      }

      if (city && state) {
        upsertCity.run(RETAILER_ID, city, state, sourceTag, snippet, dma.id);
      }
    }
  }

  log(`DMA ${i+1}/${dmas.length}: ${dma.name} (${dma.tier}) — ${dmaFound} facilities, ${dmaReview} for review`, logFile);

  // Update DMA coverage rollup
  if (!dryRun && dmaFound > 0) {
    upsertDmaCoverage.run(RETAILER_ID, RETAILER_ID, dma.id);
  }

  if (i < dmas.length - 1) await sleep(DELAY_MS);
}

log(`\nDone. ${totalFound} facilities found (${totalNew} new locations), ${totalReview} flagged for review across ${dmas.length} DMAs`, logFile);

if (dryRun) log('DRY RUN — no DB writes made', logFile);
