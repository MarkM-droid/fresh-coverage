/**
 * dallas_zip_probe.js — Probe every ZIP in Dallas-Fort Worth MSA
 * Captures offer type per ZIP to map service area by facility type
 * 
 * Usage: node scripts/dallas_zip_probe.js [--resume]
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
// Polygon containment handled server-side; ZIPs pre-computed in dallas_zips_full.json

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS_PATH = join(ROOT, 'data', 'dallas_zip_results.json');
const ZIPS_PATH = join(ROOT, 'data', 'dallas_zips_full.json');

try { const { config } = await import('dotenv'); config(); } catch {}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(base, range) { return base + Math.floor(Math.random() * range); }

// Build Dallas ZIP list from DB using MSA polygon
import { createRequire } from 'module';
const db = new Database(join(ROOT, 'data', 'coverage.db'));

// Load or build ZIP list
let dallasZips;
if (existsSync(ZIPS_PATH)) {
  dallasZips = JSON.parse(readFileSync(ZIPS_PATH, 'utf8'));
  console.log(`Loaded ${dallasZips.length} Dallas ZIPs from cache`);
} else {
  // Get ZIPs from zip_master for TX in Dallas DMA area
  // Dallas-Fort Worth MSA covers these counties primarily
  const dallasZipRows = db.prepare(`
    SELECT z.zip, z.city, z.state, z.lat, z.lng, z.population
    FROM zip_master z
    WHERE z.state = 'TX'
    AND z.lat IS NOT NULL
    AND z.population > 0
    AND z.lat BETWEEN 32.0 AND 33.8
    AND z.lng BETWEEN -98.0 AND -96.0
    ORDER BY z.population DESC
  `).all();
  dallasZips = dallasZipRows.map(r => ({
    zip: r.zip, city: r.city, state: r.state,
    lat: r.lat, lng: r.lng, pop: r.population
  }));
  writeFileSync(ZIPS_PATH, JSON.stringify(dallasZips));
  console.log(`Found ${dallasZips.length} Dallas-area ZIPs`);
}

// Load existing results for resume
const results = existsSync(RESULTS_PATH)
  ? JSON.parse(readFileSync(RESULTS_PATH, 'utf8'))
  : {};
const probedZips = new Set(Object.keys(results));
const remaining = dallasZips.filter(z => !probedZips.has(z.zip));
console.log(`Already probed: ${probedZips.size} | Remaining: ${remaining.length}`);

if (remaining.length === 0) {
  console.log('All ZIPs already probed. Results at:', RESULTS_PATH);
  process.exit(0);
}

// Playwright setup
const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
});
await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

// Warm up
await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(2000);

// Handle interstitial
const contBtn = page.locator('input[value*="Continue"], button:has-text("Continue shopping")');
if (await contBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
  await contBtn.click(); await sleep(2000);
}

async function setZip(zip) {
  await page.locator('#nav-global-location-popover-link').click({ timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const input = page.locator('#GLUXZipUpdateInput');
  if (!await input.isVisible({ timeout: 3000 }).catch(() => false)) return false;
  await input.fill(''); await input.type(zip, { delay: 60 });
  await sleep(400);
  await page.locator('[data-action="GLUXPostalUpdateAction"]').click().catch(async () => { await page.keyboard.press('Enter'); });
  await sleep(4000);
  const html = await page.content().catch(() => '');
  return html.includes(zip);
}

async function checkProduct(keyword) {
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(jitter(2000, 800));

  // Fresh product keywords
  const freshKws = keyword === 'bananas' ? ['banana','bunch'] : ['strawberr'];
  const rejectKws = ['flavor','chip','candy','powder','protein','bar','cake','bread','snack','mix','extract','juice','smoothie'];

  // Get candidate ASINs
  const candidates = await page.evaluate(() => {
    const seen = new Set(), out = [];
    document.querySelectorAll('a[href]').forEach(l => {
      const m = l.href?.match(/\/dp\/([A-Z0-9]{10})/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        const container = l.closest('[data-asin], .s-result-item, li');
        const titleEl = container?.querySelector('h2, .a-size-medium, .a-text-normal');
        out.push({ asin: m[1], title: titleEl?.textContent?.trim().slice(0,100) || '' });
      }
    });
    return out.slice(0, 10);
  });

  if (!candidates.length) return { available: false, reason: 'no_results', offers: [] };

  // Sort: fresh-matching titles first
  candidates.sort((a,b) => {
    const aF = freshKws.some(k=>a.title.toLowerCase().includes(k)) && !rejectKws.some(k=>a.title.toLowerCase().includes(k)) ? 1 : 0;
    const bF = freshKws.some(k=>b.title.toLowerCase().includes(k)) && !rejectKws.some(k=>b.title.toLowerCase().includes(k)) ? 1 : 0;
    return bF - aF;
  });

  // Try ALL candidates until one is available — don't stop at first unavailable
  let foundAsin = null, bodyText = '';
  for (const candidate of candidates.slice(0, 8)) {
    await page.goto(`https://www.amazon.com/dp/${candidate.asin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(jitter(1200, 500));
    const bt = (await page.locator('body').textContent().catch(()=>'')).toLowerCase();
    if (!bt.includes('currently unavailable') && !bt.includes("we don't know when")) {
      foundAsin = candidate.asin;
      bodyText = bt;
      break;
    }
  }

  if (!foundAsin) {
    return { available: false, reason: 'unavailable', offers: [] };
  }

  // Get buybox
  const buyboxText = await page.locator('#buybox, #rightCol, #desktop_buybox').first().textContent().catch(() => '');
  if (!buyboxText && !bodyText.includes('add to cart')) {
    return { available: false, reason: 'no_buybox', offers: [] };
  }

  // Click other sellers
  await page.locator('a:has-text("other"), #buybox-see-all-buying-choices-announce').first().click().catch(() => {});
  await sleep(jitter(2000, 600));

  const fullText = await page.locator('body').textContent().catch(() => '');
  const lower = fullText.toLowerCase();

  // Extract all offer types
  const offers = new Set();
  const offerBlocks = await page.locator('#aod-offer, .aod-offer-block, [id*="aod-offer"]').allTextContents().catch(() => []);
  const allText = offerBlocks.join(' ') + ' ' + buyboxText + ' ' + lower;

  if (allText.toLowerCase().includes('amazonfresh') || allText.toLowerCase().includes('amazon fresh')) offers.add('AmazonFresh');
  if (allText.toLowerCase().includes('whole foods')) offers.add('WholeFoods');
  if ((allText.toLowerCase().includes('today') || allText.toLowerCase().includes('hour')) && allText.toLowerCase().includes('amazon.com')) offers.add('SSD_Prime');
  if (allText.toLowerCase().includes('overnight') && allText.toLowerCase().includes('amazon.com')) offers.add('Overnight_Amazon');

  // Parse ships_from
  const shipsFromMatches = [...allText.matchAll(/ships from[:\s]+([^\n,]{2,40})/gi)];
  shipsFromMatches.forEach(m => {
    const sf = m[1].trim().toLowerCase();
    if (sf.includes('amazon fresh') || sf.includes('amazonfresh')) offers.add('AmazonFresh');
    else if (sf.includes('whole foods')) offers.add('WholeFoods');
    else if (sf.includes('amazon')) offers.add('Amazon_Standard');
  });

  const addToCart = await page.locator('#add-to-cart-button').isVisible({ timeout: 2000 }).catch(() => false);
  if (!addToCart && offers.size === 0) return { available: false, reason: 'no_cart', offers: [] };

  return { available: true, reason: 'found', offers: [...offers], asin };
}

// Main loop
let done = 0, errors = 0;
const startTime = Date.now();

for (const z of remaining) {
  const elapsed = Math.round((Date.now() - startTime) / 60000);
  const eta = remaining.length > 0 ? Math.round((elapsed / Math.max(done, 1)) * (remaining.length - done)) : 0;
  process.stdout.write(`\r[${done+1}/${remaining.length}] ZIP ${z.zip} ${z.city.padEnd(15)} | elapsed: ${elapsed}m | eta: ${eta}m    `);

  try {
    const zipSet = await setZip(z.zip);
    const bananas = await checkProduct('bananas');
    const strawberries = await checkProduct('strawberries');

    const allOffers = new Set([...bananas.offers, ...strawberries.offers]);
    let status = 'none';
    if (strawberries.available) status = 'full_fresh';
    else if (bananas.available) status = 'ambient_fresh';

    results[z.zip] = {
      zip: z.zip, city: z.city, state: z.state,
      lat: z.lat, lng: z.lng, pop: z.pop,
      status,
      offers: [...allOffers],
      bananas: { available: bananas.available, offers: bananas.offers, reason: bananas.reason },
      strawberries: { available: strawberries.available, offers: strawberries.offers, reason: strawberries.reason },
      zip_confirmed: zipSet,
      probed_at: new Date().toISOString()
    };

    done++;
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

    await sleep(jitter(2000, 1000));
  } catch(err) {
    errors++;
    console.log(`\n  ERROR on ${z.zip}: ${err.message.slice(0,60)}`);
    results[z.zip] = { zip: z.zip, city: z.city, status: 'error', error: err.message.slice(0,100), probed_at: new Date().toISOString() };
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(3000);
  }
}

await browser.close();

// Summary
const summary = {};
Object.values(results).forEach(r => { summary[r.status] = (summary[r.status]||0)+1; });
const offerSummary = {};
Object.values(results).filter(r=>r.offers).forEach(r => {
  r.offers.forEach(o => { offerSummary[o] = (offerSummary[o]||0)+1; });
});

console.log(`\n\n=== DALLAS MSA PROBE COMPLETE ===`);
console.log(`Total ZIPs probed: ${Object.keys(results).length}`);
console.log(`Status: ${JSON.stringify(summary)}`);
console.log(`Offer types: ${JSON.stringify(offerSummary)}`);
console.log(`Errors: ${errors}`);
console.log(`Results: ${RESULTS_PATH}`);
