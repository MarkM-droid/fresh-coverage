/**
 * enrich_facilities.js — Load facility data from Flex Drivers wiki and warehouse.ninja
 * Run: node scripts/enrich_facilities.js
 */
import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'coverage.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const RETAILER_ID = 'amazon_same_day';

// ── Type mapping from Flex wiki labels ────────────────────────────────────────
function mapFlexType(label, code) {
  const l = (label || '').toLowerCase();
  const prefix = (code || '').replace(/\d+$/,'').toUpperCase();
  
  if (l.includes('sub same') || l.includes('subsameday') || prefix === 'V') return 'ssd_fulfillment';
  if (l.includes('fresh online') || l.includes('prime now') || prefix === 'U') return 'fresh_hub';
  if (l.includes('fresh store') || prefix === 'M') return 'amazon_fresh_store';
  if (l.includes('whole foods') || prefix === 'C') return 'whole_foods_node';
  if (l.includes('amzl') || l.includes('amazon.com') || prefix === 'D') return 'delivery_station';
  if (l.includes('amxl') || prefix === 'H') return 'amxl_delivery';
  if (l.includes('community') || prefix === 'R') return 'community_delivery';
  if (l.includes('retail delivery') || prefix === 'P') return 'retail_delivery';
  if (l.includes('neighborhood') || prefix === 'N') return 'neighborhood_delivery';
  if (l.includes('rural') || prefix === 'W') return 'rural_delivery_station';
  return 'amazon_facility';
}

// ── Parse Flex Drivers wiki HTML ──────────────────────────────────────────────
async function scrapeFlexWiki() {
  console.log('Fetching Flex Drivers wiki...');
  const resp = await fetch('https://www.reddit.com/r/AmazonFlexDrivers/wiki/lists/warehouses/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research bot)' }
  });
  const html = await resp.text();
  
  const facilities = [];
  
  // Pattern: ID\nName (City) - Type\n[lat,lng](maps link)
  // Extract table rows — each facility has code, name, location link
  const rows = html.match(/([A-Z][A-Z0-9]{2,7})\n([^\n]+)\n\[([0-9.-]+),\s*([0-9.-]+)\]/g) || [];
  
  // Better: parse the structured table content
  // The wiki has format: CODE\nCity (CODE) - Type\n[lat,lng](url)
  const blockRe = /([A-Z][A-Z0-9]{2,7})\n([^\n\[]+)\n\[([0-9.\-]+),\s*([0-9.\-]+)\]/g;
  let match;
  while ((match = blockRe.exec(html)) !== null) {
    const [, code, nameLine, lat, lng] = match;
    // Extract type from name line
    const typeMatch = nameLine.match(/[-–]\s*(.+)$/);
    const label = typeMatch ? typeMatch[1].trim() : '';
    // Extract city from name line  
    const cityMatch = nameLine.match(/^([^(]+)/);
    const cityRaw = cityMatch ? cityMatch[1].trim() : '';
    
    facilities.push({
      code,
      label,
      cityRaw,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      type: mapFlexType(label, code),
    });
  }
  
  // Also try alternative pattern where coords come on same line
  const altRe = /\|\s*([A-Z][A-Z0-9]{2,7})\s*\|([^|]+)\|([^|]+)\|\s*\[([0-9.\-]+),\s*([0-9.\-]+)\]/g;
  while ((match = altRe.exec(html)) !== null) {
    const [, code, name, location, lat, lng] = match;
    const label = name.replace(/\([^)]+\)/, '').trim();
    facilities.push({
      code,
      label,
      cityRaw: location.trim(),
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      type: mapFlexType(label, code),
    });
  }
  
  console.log(`Parsed ${facilities.length} facilities from Flex wiki`);
  return facilities;
}

// ── Insert/update locations ───────────────────────────────────────────────────
const upsert = db.prepare(`
  INSERT OR IGNORE INTO locations
    (retailer_id, address_raw, city, state, zip, lat, lng, type, source_url, 
     confidence_tier, discovered_at, dma_id)
  VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'inferred', strftime('%s','now'), NULL)
`);

const updateCoords = db.prepare(`
  UPDATE locations SET lat=?, lng=?
  WHERE retailer_id=? AND address_raw=? AND (lat IS NULL OR lng IS NULL)
`);

const updateType = db.prepare(`
  UPDATE locations SET type=?
  WHERE retailer_id=? AND address_raw LIKE ? AND type NOT IN ('ssd_fulfillment','fresh_hub','whole_foods_node')
`);

// ── Step 1: Reclassify existing facilities by code prefix ─────────────────────
console.log('\n=== Step 1: Reclassify existing facilities by prefix ===');

const allLocations = db.prepare(`SELECT rowid, address_raw, type FROM locations WHERE retailer_id=?`).all(RETAILER_ID);
let reclassified = 0;

for (const loc of allLocations) {
  const codeMatch = loc.address_raw.match(/\b([A-Z][A-Z0-9]{2,7})\b/);
  if (!codeMatch) continue;
  const code = codeMatch[1];
  const prefix = code.replace(/\d+$/, '');
  
  let newType = null;
  if (['V'].includes(prefix) || /^V[A-Z]{2}\d/.test(code)) newType = 'ssd_fulfillment';
  else if (['U'].includes(prefix) || /^U[A-Z]{2}\d/.test(code)) newType = 'fresh_hub';
  else if (['M'].includes(prefix) || /^M[A-Z]{2}\d/.test(code)) newType = 'amazon_fresh_store';
  else if (/^[A-Z]{3}\d$/.test(code) && ['SC','DC'].includes(loc.type)) { /* keep */ }
  
  if (newType && newType !== loc.type) {
    db.prepare(`UPDATE locations SET type=? WHERE rowid=?`).run(newType, loc.rowid);
    reclassified++;
  }
}
console.log(`Reclassified ${reclassified} locations by prefix`);

// ── Step 2: Load Flex wiki data ───────────────────────────────────────────────
console.log('\n=== Step 2: Loading Flex Drivers wiki ===');
let flexAdded = 0;
let flexUpdated = 0;

try {
  const flexFacilities = await scrapeFlexWiki();
  
  // Filter to US only (lat between 24-50, lng between -125 and -65)
  const usFacilities = flexFacilities.filter(f => 
    f.lat >= 24 && f.lat <= 50 && f.lng >= -125 && f.lng <= -65
  );
  console.log(`US facilities: ${usFacilities.length}`);
  
  const tx = db.transaction(() => {
    for (const f of usFacilities) {
      const addressRaw = `${f.code} - ${f.cityRaw}`;
      const r = upsert.run(RETAILER_ID, addressRaw, f.cityRaw, '', f.lat, f.lng, f.type, 'flex_drivers_wiki');
      if (r.changes > 0) flexAdded++;
      else {
        // Try to update coords on existing record
        const u = updateCoords.run(f.lat, f.lng, RETAILER_ID, addressRaw);
        if (u.changes > 0) flexUpdated++;
      }
    }
  });
  tx();
  console.log(`Added: ${flexAdded}, Updated coords: ${flexUpdated}`);
} catch (err) {
  console.log('Flex wiki error:', err.message);
}

// ── Step 3: Match new locations to DMAs ──────────────────────────────────────
console.log('\n=== Step 3: Matching locations to DMAs via coordinates ===');
const dmaMatch = db.prepare(`
  UPDATE locations SET dma_id = (
    SELECT z.dma_id FROM zip_master z
    WHERE z.lat IS NOT NULL
    ORDER BY ((z.lat - locations.lat)*(z.lat - locations.lat) + (z.lng - locations.lng)*(z.lng - locations.lng)) ASC
    LIMIT 1
  )
  WHERE dma_id IS NULL AND lat IS NOT NULL AND source_url IN ('flex_drivers_wiki','brave_place_2026-03-23')
`);
const dmaResult = dmaMatch.run();
console.log(`Matched ${dmaResult.changes} locations to DMAs`);

// ── Step 4: Upgrade DMA place_probe_status ────────────────────────────────────
console.log('\n=== Step 4: Upgrading DMA place_probe_status ===');
const upgradeToFresh = db.prepare(`
  UPDATE dmas SET place_probe_status = 'has_fresh'
  WHERE place_probe_status IN ('has_facility', 'no_facility', 'unprobed')
    AND id IN (
      SELECT DISTINCT dma_id FROM locations
      WHERE retailer_id = ? AND type IN ('ssd_fulfillment', 'fresh_hub', 'whole_foods_node')
        AND dma_id IS NOT NULL
    )
`).run(RETAILER_ID);
console.log(`Upgraded ${upgradeToFresh.changes} DMAs to has_fresh`);

// ── Step 5: Summary ───────────────────────────────────────────────────────────
console.log('\n=== Summary ===');
const byType = db.prepare(`SELECT type, COUNT(*) as n FROM locations WHERE retailer_id=? GROUP BY type ORDER BY n DESC`).all(RETAILER_ID);
console.log('Facility types:');
byType.forEach(r => console.log(` ${r.type.padEnd(25)} ${r.n}`));

const statusSummary = db.prepare('SELECT place_probe_status, COUNT(*) as n FROM dmas GROUP BY place_probe_status ORDER BY n DESC').all();
console.log('\nDMA status:');
statusSummary.forEach(r => console.log(` ${(r.place_probe_status||'null').padEnd(20)} ${r.n}`));

const ssdDMAs = db.prepare(`
  SELECT DISTINCT d.name, d.tier FROM locations l
  JOIN dmas d ON d.id = l.dma_id
  WHERE l.retailer_id=? AND l.type='ssd_fulfillment'
  ORDER BY d.tier, d.name
`).all(RETAILER_ID);
console.log(`\nDMAs with confirmed SSD facilities (${ssdDMAs.length}):`);
ssdDMAs.forEach(d => console.log(` ${d.name} (${d.tier})`));

db.close();
console.log('\nDone.');
