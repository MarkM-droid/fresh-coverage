/**
 * fetch_wholefoods2.js — Dense grid sweep for missing Whole Foods stores
 * Uses tighter 50km radius with more anchor points
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

// Major population centers covering all states, especially those with gaps
const anchors = [
  // Florida (major gap)
  { lat:25.7617, lng:-80.1918, name:'Miami' },
  { lat:27.9506, lng:-82.4572, name:'Tampa' },
  { lat:30.3322, lng:-81.6557, name:'Jacksonville' },
  { lat:28.5383, lng:-81.3792, name:'Orlando' },
  { lat:26.7153, lng:-80.0534, name:'West Palm Beach' },
  { lat:26.1420, lng:-80.1434, name:'Fort Lauderdale' },
  { lat:29.6516, lng:-82.3248, name:'Gainesville' },
  { lat:30.4383, lng:-84.2807, name:'Tallahassee' },
  // New Jersey
  { lat:40.7357, lng:-74.1724, name:'Newark NJ' },
  { lat:40.2206, lng:-74.0112, name:'Asbury Park NJ' },
  { lat:40.4774, lng:-74.2591, name:'Edison NJ' },
  // Colorado
  { lat:39.7392, lng:-104.9903, name:'Denver' },
  { lat:38.8339, lng:-104.8214, name:'Colorado Springs' },
  { lat:40.3772, lng:-105.5217, name:'Fort Collins' },
  // Virginia
  { lat:37.5407, lng:-77.4360, name:'Richmond VA' },
  { lat:36.8529, lng:-75.9780, name:'Virginia Beach' },
  { lat:38.9072, lng:-77.0369, name:'Arlington VA' },
  // Oregon
  { lat:45.5231, lng:-122.6765, name:'Portland OR' },
  { lat:44.9429, lng:-123.0351, name:'Salem OR' },
  { lat:44.0521, lng:-123.0868, name:'Eugene OR' },
  // Connecticut
  { lat:41.7658, lng:-72.6851, name:'Hartford CT' },
  { lat:41.3082, lng:-72.9282, name:'New Haven CT' },
  { lat:41.0534, lng:-73.5387, name:'Stamford CT' },
  // Missouri  
  { lat:38.6270, lng:-90.1994, name:'St Louis' },
  { lat:39.0997, lng:-94.5786, name:'Kansas City' },
  // Indiana
  { lat:39.7684, lng:-86.1581, name:'Indianapolis' },
  // Minnesota
  { lat:44.9778, lng:-93.2650, name:'Minneapolis' },
  // Alabama
  { lat:33.5186, lng:-86.8104, name:'Birmingham AL' },
  { lat:32.3792, lng:-86.3077, name:'Montgomery AL' },
  // Kentucky
  { lat:38.2527, lng:-85.7585, name:'Louisville KY' },
  { lat:38.0406, lng:-84.5037, name:'Lexington KY' },
  // Iowa
  { lat:41.5868, lng:-93.6250, name:'Des Moines' },
  // Utah
  { lat:40.7608, lng:-111.8910, name:'Salt Lake City' },
  // Kansas
  { lat:37.6872, lng:-97.3301, name:'Wichita KS' },
  // Nevada
  { lat:36.1699, lng:-115.1398, name:'Las Vegas' },
  { lat:39.5296, lng:-119.8138, name:'Reno NV' },
  // Hawaii
  { lat:21.3069, lng:-157.8583, name:'Honolulu' },
  // DC/Maryland extra
  { lat:38.9072, lng:-77.0369, name:'DC' },
  { lat:39.2904, lng:-76.6122, name:'Baltimore extra' },
  // Additional Northeast density
  { lat:42.3601, lng:-71.0589, name:'Boston extra' },
  { lat:40.6501, lng:-73.9496, name:'Brooklyn' },
  { lat:40.7282, lng:-73.7949, name:'Queens' },
  { lat:40.9176, lng:-74.1719, name:'North Jersey' },
  // West Coast density
  { lat:37.7749, lng:-122.4194, name:'San Francisco' },
  { lat:37.3382, lng:-121.8863, name:'San Jose' },
  { lat:37.8716, lng:-122.2727, name:'Berkeley' },
  { lat:33.7701, lng:-118.1937, name:'Long Beach' },
  { lat:34.1478, lng:-118.1445, name:'Pasadena' },
  { lat:33.6694, lng:-117.8231, name:'Irvine' },
  { lat:32.7157, lng:-117.1611, name:'San Diego extra' },
  { lat:47.6062, lng:-122.3321, name:'Seattle extra' },
  { lat:47.6553, lng:-122.3035, name:'Bellevue WA' },
  // Texas density
  { lat:30.2672, lng:-97.7431, name:'Austin extra' },
  { lat:32.7767, lng:-96.7970, name:'Dallas extra' },
  { lat:29.7604, lng:-95.3698, name:'Houston extra' },
  { lat:29.4241, lng:-98.4936, name:'San Antonio' },
  // More Midwest
  { lat:41.8827, lng:-87.6233, name:'Chicago extra' },
  { lat:39.9612, lng:-82.9988, name:'Columbus OH' },
  { lat:41.4993, lng:-81.6944, name:'Cleveland' },
  { lat:39.1031, lng:-84.5120, name:'Cincinnati' },
  { lat:42.3314, lng:-83.0458, name:'Detroit' },
  { lat:43.0389, lng:-76.1422, name:'Syracuse NY' },
  { lat:42.8864, lng:-78.8784, name:'Buffalo NY' },
  { lat:43.1566, lng:-77.6088, name:'Rochester NY' },
];

console.log('Sweeping', anchors.length, 'anchor points for Whole Foods (radius 50km)...');

const insert = db.prepare(`
  INSERT OR IGNORE INTO locations 
    (retailer_id,address_raw,city,state,zip,lat,lng,type,source_url,confidence_tier,discovered_at,dma_id)
  VALUES ('amazon_same_day',?,?,?,?,?,?,'whole_foods_node','place_search_wf2','inferred',strftime('%s','now'),NULL)
`);

const getDMA = db.prepare(`
  SELECT dma_id FROM zip_master WHERE LOWER(city)=LOWER(?) AND state=? AND dma_id IS NOT NULL LIMIT 1
`);

let added = 0, found = 0;
const seen = new Set(
  db.prepare("SELECT lat||','||lng FROM locations WHERE retailer_id='amazon_same_day' AND type='whole_foods_node' AND lat IS NOT NULL")
    .all().map(r => r['lat||\'\'||lng'] || '').filter(Boolean)
);
// Build seen set properly
const existing = db.prepare("SELECT lat, lng FROM locations WHERE retailer_id='amazon_same_day' AND type='whole_foods_node' AND lat IS NOT NULL").all();
existing.forEach(r => seen.add(r.lat.toFixed(4)+','+r.lng.toFixed(4)));
console.log('Existing WF with coords:', seen.size);

for (let i = 0; i < anchors.length; i++) {
  const a = anchors[i];
  const params = new URLSearchParams({
    q: 'Whole Foods Market',
    latitude: a.lat, longitude: a.lng,
    radius: 50000, count: 20, country: 'US'
  });
  
  try {
    const resp = await fetch('https://api.search.brave.com/res/v1/local/place_search?' + params, {
      headers: { 'X-Subscription-Token': key }
    });
    if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000)); i--; continue; }
    if (!resp.ok) continue;
    const data = await resp.json();
    
    const wf = (data.results||[]).filter(r =>
      r.title?.toLowerCase().includes('whole foods market') && r.coordinates?.[0]
    );
    
    for (const r of wf) {
      const coordKey = r.coordinates[0].toFixed(4)+','+r.coordinates[1].toFixed(4);
      if (seen.has(coordKey)) continue;
      seen.add(coordKey);
      found++;
      
      const addr = r.postal_address || {};
      const city = addr.addressLocality || '';
      const state = addr.addressRegion || '';
      const zip = addr.postalCode || '';
      const addrRaw = addr.displayAddress || r.title;
      
      const dmaRow = city && state ? getDMA.get(city, state) : null;
      const res = insert.run(addrRaw, city, state, zip, r.coordinates[0], r.coordinates[1], dmaRow?.dma_id || null);
      if (res.changes) added++;
    }
  } catch(e) { /* skip */ }
  
  if (i % 10 === 0) process.stdout.write(`\r[${i+1}/${anchors.length}] ${a.name} — ${found} new WF found, ${added} added`);
  await new Promise(r => setTimeout(r, 700));
}

console.log(`\n\nDone. Found ${found} new unique WF locations, Added ${added} to DB`);
const total = db.prepare("SELECT COUNT(*) as n FROM locations WHERE retailer_id='amazon_same_day' AND type='whole_foods_node'").get();
console.log('Total Whole Foods in DB:', total.n);
db.close();
