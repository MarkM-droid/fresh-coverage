/**
 * amazon_fresh_probe.js — Check Amazon fresh grocery availability by ZIP
 * 
 * Usage: node scripts/amazon_fresh_probe.js [--zip 10001] [--test]
 * 
 * Strategy:
 * 1. Set ZIP via Amazon's location change API
 * 2. Check banana ASIN (fresh, ambient) 
 * 3. Check strawberry ASIN (fresh, refrigerated)
 * 4. Parse offer types from page content
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'coverage.db');

const ASINS = {
  bananas:      'B07984JN3L',   // Amazon Fresh bananas — ambient fresh
  strawberries: 'B002BBZ98W',   // Organic strawberries — refrigerated
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const get = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
  return {
    singleZip: get('--zip'),
    test: args.includes('--test'),
    headless: args.includes('--headless'),
    limit: parseInt(get('--limit') || '200', 10),
  };
}

async function setZipAndCheck(page, zip, asin) {
  // Method: use Amazon's location API then reload product page
  const apiResp = await page.evaluate(async (z) => {
    try {
      const resp = await fetch('/gp/delivery/ajax/address-change.html', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: `locationType=LOCATION_INPUT&zipCode=${z}&storeContext=fresh&deviceType=web&pageType=Detail&actionSource=desktop-modal`
      });
      return resp.status;
    } catch(e) { return -1; }
  }, zip);

  if (apiResp !== 200) return { error: 'location API failed: ' + apiResp };

  // Navigate to product
  await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2000);

  const body = await page.locator('body').textContent().catch(() => '');
  const lower = body.toLowerCase();

  // Detect offer types
  const result = {
    available: false,
    unavailable: false,
    offers: [],
    raw_snippet: ''
  };

  if (lower.includes('currently unavailable') || lower.includes('we don\'t know when')) {
    result.unavailable = true;
    return result;
  }

  // Look for delivery blocks
  const delivSelectors = [
    '#mir-layout-DELIVERY_BLOCK',
    '#deliveryBlockMessage', 
    '#ddmDeliveryMessage',
    '#dynamic-aod-ingress-block',
    '[id*="delivery-message"]',
    '.a-section[data-feature-name="deliveryBlockMessage"]'
  ];
  
  let delivText = '';
  for (const sel of delivSelectors) {
    const text = await page.locator(sel).first().textContent().catch(() => '');
    if (text.trim()) { delivText = text; break; }
  }
  
  // Fallback: grab buybox area
  if (!delivText) {
    delivText = await page.locator('#buybox, #rightCol, #desktop_buybox').first().textContent().catch(() => '');
  }

  const delivLower = delivText.toLowerCase();
  result.raw_snippet = delivText.trim().slice(0, 300);

  if (delivLower.includes('amazonfresh') || delivLower.includes('amazon fresh')) result.offers.push('AmazonFresh');
  if (delivLower.includes('whole foods')) result.offers.push('WholeFoods');
  if ((delivLower.includes('today') || delivLower.includes('in ') && delivLower.includes('hour')) && 
      (delivLower.includes('prime') || delivLower.includes('ships from: amazon'))) result.offers.push('SSD');
  
  // Also check body-level
  if (!result.offers.length) {
    if (lower.includes('amazonfresh')) result.offers.push('AmazonFresh');
    if (lower.includes('ships from: whole foods')) result.offers.push('WholeFoods');
  }

  result.available = result.offers.length > 0;
  return result;
}

async function probeZip(page, zip) {
  const results = {};
  for (const [name, asin] of Object.entries(ASINS)) {
    const r = await setZipAndCheck(page, zip, asin);
    results[name] = r;
    await sleep(1500);
  }

  // Determine overall status
  const bananaAvail = results.bananas.available;
  const strawAvail = results.strawberries.available;
  const allOffers = [...new Set([...results.bananas.offers||[], ...results.strawberries.offers||[]])];

  let status = 'none';
  if (strawAvail) status = 'full_fresh';         // Cold chain confirmed
  else if (bananaAvail) status = 'ambient_fresh'; // Ambient fresh only
  
  return { zip, status, offers: allOffers, detail: results };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const { singleZip, test, headless, limit } = parseArgs();

const browser = await chromium.launch({
  headless,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
});
const page = await browser.newPage({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
});
await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

// Warm up — go to Amazon first to establish cookies
await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
await sleep(2000);

if (singleZip) {
  // Single ZIP test
  console.log('Testing ZIP:', singleZip);
  const result = await probeZip(page, singleZip);
  console.log(JSON.stringify(result, null, 2));
} else if (test) {
  // Test mode — top 5 MSAs
  const data = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'top200_msa_probe_targets.csv'), 'utf8').split('\n').slice(1).filter(Boolean).slice(0,5).map(l => {
    const cols = l.split(',');
    return JSON.stringify({ msa_name: cols[1], zip: cols[3], city: cols[4], state: cols[5] });
  }).join('\n'));
  console.log('Test mode — 5 MSAs');
} else {
  console.log('Use --zip XXXXX to test a single ZIP, or --test for top 5 MSAs');
}

await browser.close();
console.log('Done.');
