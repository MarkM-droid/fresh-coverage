/**
 * load_wiki_full.js — Parse and load complete Flex wiki V/U/C facility data
 */
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'coverage.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const RETAILER_ID = 'amazon_same_day';

console.log('Fetching Flex Drivers wiki...');
const resp = await fetch('https://www.reddit.com/r/AmazonFlexDrivers/wiki/lists/warehouses.json?raw_json=1', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
});

if (!resp.ok) { console.error('Failed:', resp.status); process.exit(1); }
const data = await resp.json();
const content = data?.data?.content_md || '';
console.log('Wiki content length:', content.length, 'chars');

// Parse entries: CODE\nCity Name - Type\n[lat,lng](maps url)
const entries = [];
const blockRe = /\n([A-Z][A-Z0-9]{2,6})\n([^\n\[]{3,80})\n\[(-?[0-9]+\.[0-9]+),\s*(-?[0-9]+\.[0-9]+)\]/g;
let m;
while ((m = blockRe.exec(content)) !== null) {
  const [, code, nameLine, lat, lng] = m;
  const latF = parseFloat(lat), lngF = parseFloat(lng);
  
  // US only
  if (latF < 24 || latF > 50 || lngF < -125 || lngF > -65) continue;
  
  const typeMatch = nameLine.match(/[-–]\s*(.+)$/);
  const label = typeMatch ? typeMatch[1].trim() : '';
  const cityMatch = nameLine.match(/^(.+?)\s*(?:\([^)]+\))?\s*[-–]/);
  const cityRaw = cityMatch ? cityMatch[1].trim() : nameLine.split('-')[0].trim();
  
  entries.push({ code, label, cityRaw, lat: latF, lng: lngF });
}

console.log('Parsed US entries:', entries.length);

// Map label to type
function mapType(label, code) {
  const l = label.toLowerCase();
  const prefix = code[0];
  if (l.includes('sub same') || prefix === 'V') return 'ssd_fulfillment';
  if (l.includes('fresh online') || l.includes('prime now') || prefix === 'U') return 'fresh_hub';
  if (l.includes('fresh store') || l.includes('amazon fresh') || code.startsWith('M')) return 'amazon_fresh_store';
  if (l.includes('whole foods') || code.startsWith('C')) return 'whole_foods_node';
  if (l.includes('amzl') || l.includes('amazon.com') || prefix === 'D') return 'delivery_station';
  if (l.includes('amxl') || prefix === 'H') return 'amxl_delivery';
  if (l.includes('community') || prefix === 'R') return 'community_delivery';
  if (l.includes('retail delivery') || prefix === 'P') return 'retail_delivery';
  if (l.includes('neighborhood') || prefix === 'N') return 'neighborhood_delivery';
  if (prefix === 'W') return 'rural_delivery_station';
  return 'amazon_facility';
}

// Count by type
const typeCounts = {};
entries.forEach(e => {
  const t = mapType(e.label, e.code);
  typeCounts[t] = (typeCounts[t]||0)+1;
});
console.log('\nEntries by type:');
Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]).forEach(([t,n]) => console.log(' ', t.padEnd(25), n));

// Filter to grocery-relevant types only for loading
const GROCERY_TYPES = new Set(['ssd_fulfillment','fresh_hub','whole_foods_node']);
const groceryEntries = entries.filter(e => GROCERY_TYPES.has(mapType(e.label, e.code)));
console.log('\nGrocery-relevant entries:', groceryEntries.length);

// Insert
const insert = db.prepare(`
  INSERT OR IGNORE INTO locations
    (retailer_id, address_raw, city, state, zip, lat, lng, type, source_url, confidence_tier, discovered_at)
  VALUES (?, ?, ?, '', '', ?, ?, ?, 'flex_drivers_wiki_full', 'inferred', strftime('%s','now'))
`);

// Match to DMA by city name
const getDMA = db.prepare(`
  SELECT dma_id FROM zip_master WHERE LOWER(city)=LOWER(?) AND state=? AND dma_id IS NOT NULL LIMIT 1
`);

let added = 0, updated = 0;

const tx = db.transaction(() => {
  for (const e of groceryEntries) {
    const type = mapType(e.label, e.code);
    const addrRaw = `${e.code} - ${e.cityRaw}`;
    
    // Try to extract state from cityRaw (e.g. "Norcross GA" or "Austin TX")
    const stateMatch = e.cityRaw.match(/\b([A-Z]{2})$/);
    const state = stateMatch ? stateMatch[1] : '';
    const city = state ? e.cityRaw.slice(0, -3).trim() : e.cityRaw;
    
    const r = insert.run(RETAILER_ID, addrRaw, city, e.lat, e.lng, type);
    if (r.changes) {
      added++;
      // Match to DMA
      if (city && state) {
        const dmaRow = getDMA.get(city, state);
        if (dmaRow) {
          db.prepare('UPDATE locations SET state=?, dma_id=? WHERE address_raw=? AND retailer_id=?')
            .run(state, dmaRow.dma_id, addrRaw, RETAILER_ID);
        }
      }
    } else {
      // Update lat/lng if missing
      const upd = db.prepare('UPDATE locations SET lat=?, lng=? WHERE address_raw=? AND retailer_id=? AND (lat IS NULL OR lng IS NULL)').run(e.lat, e.lng, addrRaw, RETAILER_ID);
      if (upd.changes) updated++;
    }
  }
});
tx();

console.log(`\nAdded: ${added}, Updated coords: ${updated}`);

// Upgrade DMAs
const upgrade = db.prepare(`
  UPDATE dmas SET place_probe_status = 'has_fresh'
  WHERE id IN (
    SELECT DISTINCT dma_id FROM locations
    WHERE retailer_id=? AND type IN ('ssd_fulfillment','fresh_hub','whole_foods_node') AND dma_id IS NOT NULL
  ) AND place_probe_status NOT IN ('has_fresh')
`).run(RETAILER_ID);
console.log('DMAs upgraded to has_fresh:', upgrade.changes);

// Final counts
const byType = db.prepare(`SELECT type, COUNT(*) as n FROM locations WHERE retailer_id=? AND type IN ('ssd_fulfillment','fresh_hub','whole_foods_node') GROUP BY type`).all(RETAILER_ID);
console.log('\nGrocery facilities now:');
byType.forEach(r => console.log(' ', r.type.padEnd(25), r.n));

const ssdWithCoords = db.prepare(`SELECT COUNT(*) as n FROM locations WHERE retailer_id=? AND type='ssd_fulfillment' AND lat IS NOT NULL`).get(RETAILER_ID);
console.log('\nSSD facilities with coords:', ssdWithCoords.n);

db.close();
console.log('Done.');
