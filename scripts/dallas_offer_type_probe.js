/**
 * dallas_offer_type_probe.js
 * 
 * Sample probe across Dallas ZIPs at different distances from SSD facilities.
 * Captures PRIMARY offer (buybox Ships from) and ALL available offers separately.
 * Goal: understand SSD vs Whole Foods vs AmazonFresh fulfillment by distance.
 * 
 * Usage: node scripts/dallas_offer_type_probe.js
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS_PATH = join(ROOT, 'data', 'dallas_offer_type_results.json');

const db = new Database(join(ROOT, 'data', 'coverage.db'));

// SSD facilities near Dallas
const ssdFacs = db.prepare(`
  SELECT address_raw, lat, lng FROM locations
  WHERE retailer_id='amazon_same_day' AND type='ssd_fulfillment'
  AND state='TX' AND lat IS NOT NULL
`).all();
db.close();

function distMi(lat1,lng1,lat2,lng2) {
  const R=Math.PI/180,dlat=(lat2-lat1)*R,dlng=(lng2-lng1)*R;
  const a=Math.sin(dlat/2)**2+Math.cos(lat1*R)*Math.cos(lat2*R)*Math.sin(dlng/2)**2;
  return 6371*2*Math.asin(Math.sqrt(a))*0.621371;
}

function nearestSSD(lat, lng) {
  let best = null, bestDist = Infinity;
  for (const f of ssdFacs) {
    const d = distMi(lat, lng, f.lat, f.lng);
    if (d < bestDist) { bestDist = d; best = f; }
  }
  return { facility: best?.address_raw?.split(' - ')[0] || '?', dist: Math.round(bestDist) };
}

// Load Dallas probe results and pick sample ZIPs at different distances
const dallas = JSON.parse(readFileSync(join(ROOT, 'data', 'dallas_zip_results.json'), 'utf8'));
const confirmed = Object.values(dallas).filter(r => r.status !== 'none' && r.lat && r.lng);

// Bucket by distance to nearest SSD and pick 3-4 from each bucket
const buckets = { '0-15mi': [], '15-25mi': [], '25-35mi': [], '35-50mi': [] };
for (const z of confirmed) {
  const { dist } = nearestSSD(z.lat, z.lng);
  if (dist <= 15) buckets['0-15mi'].push({ ...z, ssd_dist: dist });
  else if (dist <= 25) buckets['15-25mi'].push({ ...z, ssd_dist: dist });
  else if (dist <= 35) buckets['25-35mi'].push({ ...z, ssd_dist: dist });
  else buckets['35-50mi'].push({ ...z, ssd_dist: dist });
}

// Pick 4 from each bucket sorted by population for representativeness
const sample = [];
for (const [bucket, zips] of Object.entries(buckets)) {
  const picked = zips.sort((a,b) => (b.pop||0)-(a.pop||0)).slice(0, 4);
  picked.forEach(z => sample.push({ ...z, bucket }));
}

console.log(`Sample size: ${sample.length} ZIPs across distance buckets`);
sample.forEach(z => console.log(`  ${z.zip} ${z.city?.padEnd(18)} | ${z.bucket} | ssd_dist:${z.ssd_dist}mi`));

// Parse offers — the RIGHT way
async function parseOffersFromPage(page) {
  const result = {
    primary_ships_from: null,   // buybox default offer
    primary_delivery: null,     // buybox delivery time
    all_offers: []              // all offers from panel
  };

  // 1. Parse PRIMARY offer from buybox
  const buyboxText = await page.locator('#buybox, #rightCol, #desktop_buybox').first().textContent().catch(()=>'');
  
  // Look for "Ships from: X" pattern specifically
  const sfMatch = buyboxText.match(/Ships from[:\s]+([^\n\r]{2,40})/i);
  if (sfMatch) result.primary_ships_from = sfMatch[1].trim().replace(/\s+/g,' ');
  
  // Delivery time from buybox
  const delivMatch = buyboxText.match(/(Today|Tomorrow|Overnight|in \d+ hour[s]?)[^\n]{0,50}/i);
  if (delivMatch) result.primary_delivery = delivMatch[0].trim().slice(0,60);

  // 2. Open "Other sellers" panel
  await page.locator('a:has-text("other"), #buybox-see-all-buying-choices-announce').first().click({ timeout: 3000 }).catch(()=>{});
  await new Promise(r => setTimeout(r, 2000));

  // 3. Parse ALL offers from AOD panel — look for Ships from blocks specifically
  const aodContent = await page.locator('#aod-container, #aod-offer-list').first().textContent().catch(() => '');
  
  if (aodContent) {
    // Split by offer blocks and extract Ships from + delivery for each
    const sfMatches = [...aodContent.matchAll(/Ships from[:\s]+([^\n\r]{2,50})/gi)];
    const delivMatches = [...aodContent.matchAll(/(Today|Tomorrow|Overnight|FREE delivery|in \d+ hour[s]?)[^\n]{0,80}/gi)];
    
    sfMatches.forEach((m, i) => {
      result.all_offers.push({
        ships_from: m[1].trim().replace(/\s+/g,' ').slice(0,40),
        delivery: delivMatches[i]?.[0]?.trim().slice(0,60) || null
      });
    });
  }

  // If panel didn't load, fall back to full page scan but ONLY for Ships from patterns
  if (result.all_offers.length === 0) {
    const fullText = await page.locator('body').textContent().catch(()=>'');
    const allSF = [...fullText.matchAll(/Ships from[:\s]+([^\n\r]{2,50})/gi)];
    allSF.forEach(m => {
      const sf = m[1].trim().replace(/\s+/g,' ').slice(0,40);
      if (!result.all_offers.find(o => o.ships_from === sf)) {
        result.all_offers.push({ ships_from: sf, delivery: null });
      }
    });
  }

  return result;
}

function classifyShipsFrom(shipsFrom) {
  if (!shipsFrom) return null;
  const sf = shipsFrom.toLowerCase();
  if (sf.includes('amazonfresh') || sf.includes('amazon fresh')) return 'AmazonFresh_DarkStore';
  if (sf.includes('whole foods')) return 'WholeFoods';
  if (sf.includes('amazon.com') || sf === 'amazon') return 'Amazon_SSD_or_FC';
  return shipsFrom.slice(0,30);
}

// Run the probe
const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const results = {};

for (const z of sample) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', {get:()=>false}); });
  const page = await ctx.newPage();

  try {
    // Set ZIP
    await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r=>setTimeout(r,1500));
    await page.locator('#nav-global-location-popover-link').click({ timeout: 5000 }).catch(()=>{});
    await new Promise(r=>setTimeout(r,1200));
    await page.locator('#GLUXZipUpdateInput').fill(z.zip).catch(()=>{});
    await page.locator('[data-action="GLUXPostalUpdateAction"]').click().catch(async()=>{ await page.keyboard.press('Enter'); });
    await new Promise(r=>setTimeout(r,4000));

    // Get banana ASIN
    await page.goto('https://www.amazon.com/s?k=bananas', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r=>setTimeout(r,1500));
    const asin = await page.evaluate(() => {
      for (const l of document.querySelectorAll('a[href]')) {
        const m = l.href?.match(/\/dp\/([A-Z0-9]{10})/);
        if (m) {
          const c = l.closest('[data-asin],.s-result-item');
          const t = c?.querySelector('h2')?.textContent?.toLowerCase()||'';
          if ((t.includes('banana')||t.includes('bunch')) && !t.includes('chip')&&!t.includes('flavor')) return m[1];
        }
      }
      return null;
    });

    if (!asin) { console.log(`  ${z.zip}: no banana ASIN`); results[z.zip] = { ...z, error: 'no_asin' }; await ctx.close(); continue; }

    await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r=>setTimeout(r,2000));

    const body = (await page.locator('body').textContent().catch(()=>'')).toLowerCase();
    if (body.includes('currently unavailable')) {
      console.log(`  ${z.zip} ${z.bucket}: UNAVAILABLE`);
      results[z.zip] = { ...z, available: false, reason: 'unavailable' };
      await ctx.close(); continue;
    }

    const offerData = await parseOffersFromPage(page);
    const primaryType = classifyShipsFrom(offerData.primary_ships_from);
    const allTypes = [...new Set(offerData.all_offers.map(o => classifyShipsFrom(o.ships_from)).filter(Boolean))];

    console.log(`  ${z.zip} ${z.city?.padEnd(15)} | ${z.bucket} | primary:"${primaryType}" | all:[${allTypes.join(',')}]`);
    console.log(`    Ships from (primary): "${offerData.primary_ships_from}" | delivery: "${offerData.primary_delivery}"`);
    offerData.all_offers.forEach(o => console.log(`    Panel offer: ships_from:"${o.ships_from}" delivery:"${o.delivery}"`));

    results[z.zip] = {
      zip: z.zip, city: z.city, state: z.state, lat: z.lat, lng: z.lng, pop: z.pop,
      bucket: z.bucket, ssd_dist: z.ssd_dist,
      available: true,
      primary_ships_from: offerData.primary_ships_from,
      primary_delivery: offerData.primary_delivery,
      primary_type: primaryType,
      all_offers: offerData.all_offers,
      all_types: allTypes,
      probed_at: new Date().toISOString()
    };

    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  } catch(err) {
    console.log(`  ${z.zip} ERROR: ${err.message.slice(0,60)}`);
    results[z.zip] = { ...z, error: err.message.slice(0,80) };
  }
  
  await ctx.close();
  await new Promise(r=>setTimeout(r,2000));
}

await browser.close();
writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

// Summary by bucket
console.log('\n=== SUMMARY BY DISTANCE BUCKET ===');
const byBucket = {};
for (const r of Object.values(results)) {
  if (!r.bucket || !r.available) continue;
  if (!byBucket[r.bucket]) byBucket[r.bucket] = [];
  byBucket[r.bucket].push(r);
}
for (const [bucket, zips] of Object.entries(byBucket)) {
  console.log(`\n${bucket} (${zips.length} ZIPs):`);
  zips.forEach(z => console.log(`  ${z.zip} ${z.city?.padEnd(15)} primary:${z.primary_type} | all:[${z.all_types?.join(',')}]`));
}

console.log('\nResults saved to:', RESULTS_PATH);
