/**
 * fetch_wholefoods.js — Sweep all DMA centroids for Whole Foods via Brave Place Search
 */
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'data', 'coverage.db'));
db.pragma('journal_mode = WAL');
const key = process.env.BRAVE_API_KEY;

const dmas = db.prepare("SELECT id, name, centroid_lat, centroid_lng FROM dmas WHERE centroid_lat IS NOT NULL AND tier != 'micro' ORDER BY id").all();
console.log('Sweeping', dmas.length, 'DMAs for Whole Foods...');

const insert = db.prepare(`
  INSERT OR IGNORE INTO locations 
    (retailer_id,address_raw,city,state,zip,lat,lng,type,source_url,confidence_tier,discovered_at,dma_id)
  VALUES ('amazon_same_day',?,?,?,?,?,?,'whole_foods_node','place_search_wf','inferred',strftime('%s','now'),?)
`);

let added = 0, found = 0;
const seen = new Set();

for (let i = 0; i < dmas.length; i++) {
  const d = dmas[i];
  const params = new URLSearchParams({
    q: 'Whole Foods Market',
    latitude: d.centroid_lat,
    longitude: d.centroid_lng,
    radius: 120000,
    count: 20,
    country: 'US'
  });
  
  try {
    const resp = await fetch('https://api.search.brave.com/res/v1/local/place_search?' + params, {
      headers: { 'X-Subscription-Token': key }
    });
    if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (!resp.ok) continue;
    
    const data = await resp.json();
    const wfStores = (data.results || []).filter(r =>
      r.title?.toLowerCase().includes('whole foods market') && r.coordinates?.[0]
    );
    
    for (const r of wfStores) {
      const coordKey = r.coordinates[0].toFixed(4) + ',' + r.coordinates[1].toFixed(4);
      if (seen.has(coordKey)) continue;
      seen.add(coordKey);
      found++;
      
      const addr = r.postal_address || {};
      const city = addr.addressLocality || '';
      const state = addr.addressRegion || '';
      const zip = addr.postalCode || '';
      const addrRaw = addr.displayAddress || r.title;
      
      const res = insert.run(addrRaw, city, state, zip, r.coordinates[0], r.coordinates[1], d.id);
      if (res.changes) added++;
    }
  } catch(e) { /* skip */ }
  
  if (i % 25 === 0) console.log(`  [${i+1}/${dmas.length}] ${d.name} — found ${found} WF so far`);
  await new Promise(r => setTimeout(r, 800));
}

console.log(`\nDone. Found: ${found} unique WF locations, Added: ${added} new to DB`);
const total = db.prepare("SELECT COUNT(*) as n FROM locations WHERE retailer_id='amazon_same_day' AND type='whole_foods_node'").get();
console.log('Total Whole Foods in DB:', total.n);
db.close();
