/**
 * amazon_msa_probe.js — Check Amazon fresh grocery availability for top 200 MSAs
 * 
 * ASINs tested per ZIP:
 *   Bananas  B07ZLF9WQ5 — fresh, ambient, never ships standard
 *   Strawberries B08911ZP3Y — fresh, refrigerated, cold chain required
 * 
 * Usage: node scripts/amazon_msa_probe.js [--limit 10] [--headless]
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'coverage.db');
const RESULTS_PATH = join(__dirname, '..', 'data', 'msa_amazon_probe_results.json');

const ASINS = {
  bananas:      'B07ZLF9WQ5',
  strawberries: 'B08911ZP3Y',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const get = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
  return {
    limit: parseInt(get('--limit') || '200', 10),
    headless: args.includes('--headless'),
    startAt: parseInt(get('--start') || '0', 10),
  };
}

async function setZip(page, zip) {
  // Click location button
  await page.locator('#nav-global-location-popover-link').click({ timeout: 5000 }).catch(()=>{});
  await sleep(1500);
  const input = page.locator('#GLUXZipUpdateInput');
  const visible = await input.isVisible({ timeout: 3000 }).catch(()=>false);
  if (!visible) return false;
  await input.fill(zip);
  await sleep(300);
  await page.locator('[data-action="GLUXPostalUpdateAction"]').click().catch(async () => {
    await page.keyboard.press('Enter');
  });
  await sleep(2500);
  // Verify ZIP changed
  const locText = await page.locator('#glow-ingress-line2').textContent().catch(()=>'');
  return locText.includes(zip.slice(0,4)); // first 4 digits of ZIP should appear
}

async function checkASIN(page, zip, asin, name) {
  await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2000);

  // Check for unavailable first
  const availText = await page.locator('#availability').textContent().catch(()=>'');
  const buyboxText = await page.locator('#buybox, #rightCol').first().textContent().catch(()=>'');
  const combined = (availText + ' ' + buyboxText).toLowerCase();

  if (combined.includes('currently unavailable') || combined.includes('we don\'t know when')) {
    return { asin, name, available: false, reason: 'unavailable' };
  }

  // Click "Other sellers on Amazon" to reveal all offer types including AmazonFresh / Whole Foods
  const otherBtn = page.locator('a:has-text("other"), #buybox-see-all-buying-choices-announce, [href*="offer-listing"]').first();
  const btnVisible = await otherBtn.isVisible({ timeout: 2000 }).catch(()=>false);
  if (btnVisible) {
    await otherBtn.click().catch(()=>{});
    await sleep(2500);
  }

  // Parse full body for offer sources
  const body = await page.locator('body').textContent().catch(()=>'');
  const lower = body.toLowerCase();

  const offers = [];
  if (lower.includes('ships from') && (lower.includes('amazonfresh') || lower.includes('amazon fresh'))) offers.push('AmazonFresh');
  if (lower.includes('whole foods market') && lower.includes('ships from')) offers.push('WholeFoods');
  if (lower.includes('2-hour delivery') || lower.includes('same-day delivery') || 
      (lower.includes('today') && lower.includes('amazon.com'))) offers.push('SSD_Prime');
  if (!offers.length) {
    // Fallback — any fresh delivery signal
    if (lower.includes('amazonfresh')) offers.push('AmazonFresh');
    if (lower.includes('whole foods')) offers.push('WholeFoods');
  }

  const available = offers.length > 0;
  if (!available && combined.includes('add to cart')) offers.push('Amazon_generic');

  return { asin, name, available: offers.length > 0, offers, reason: offers.length ? 'found' : 'no_fresh_offer' };
}

// Load MSA targets
const csvRaw = readFileSync(join(__dirname, '..', 'data', 'top200_msa_probe_targets.csv'), 'utf8');
const targets = csvRaw.split('\n').slice(1).filter(Boolean).map(line => {
  // Handle quoted fields (msa_name may contain commas)
  const parts = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  // cols: msa_id, msa_name, msa_population, zip, city, state, zip_population
  return { msa_id: parts[0], msa_name: parts[1], msa_pop: parts[2], zip: parts[3], city: parts[4], state: parts[5] };
}).filter(t => t.zip);

const { limit, headless, startAt } = parseArgs();
const toProbe = targets.slice(startAt, startAt + limit);
console.log(`Probing ${toProbe.length} MSAs (${startAt}–${startAt+toProbe.length-1}), headless=${headless}`);

// Load existing results if any
const existingResults = existsSync(RESULTS_PATH) 
  ? JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) 
  : {};
const probedZips = new Set(Object.keys(existingResults));
console.log(`Already probed: ${probedZips.size} ZIPs`);

const browser = await chromium.launch({ 
  headless, 
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
});
const page = await browser.newPage({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
});
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});

// Warm up on Amazon homepage
await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
await sleep(2000);

let done = 0, errors = 0;
const results = { ...existingResults };

for (const target of toProbe) {
  if (probedZips.has(target.zip)) {
    console.log(`[SKIP] ${target.msa_name} (${target.zip}) — already probed`);
    done++;
    continue;
  }

  console.log(`\n[${done+1}/${toProbe.length}] ${target.msa_name} → ZIP ${target.zip} (${target.city}, ${target.state})`);

  try {
    // Set ZIP
    const zipOk = await setZip(page, target.zip);
    console.log(`  ZIP set: ${zipOk}`);

    // Check both ASINs
    const bananaResult = await checkASIN(page, target.zip, ASINS.bananas, 'bananas');
    console.log(`  Bananas: ${bananaResult.available ? '✅ ' + bananaResult.offers?.join(',') : '❌ ' + bananaResult.reason}`);
    
    const strawResult = await checkASIN(page, target.zip, ASINS.strawberries, 'strawberries');
    console.log(`  Strawberries: ${strawResult.available ? '✅ ' + strawResult.offers?.join(',') : '❌ ' + strawResult.reason}`);

    // Determine status
    let status = 'none';
    const allOffers = [...new Set([...(bananaResult.offers||[]), ...(strawResult.offers||[])])];
    if (strawResult.available) status = 'full_fresh_confirmed';
    else if (bananaResult.available) status = 'ambient_fresh_only';

    results[target.zip] = {
      msa_id: target.msa_id,
      msa_name: target.msa_name,
      msa_pop: target.msa_pop,
      zip: target.zip,
      city: target.city,
      state: target.state,
      status,
      offers: allOffers,
      bananas: bananaResult,
      strawberries: strawResult,
      probed_at: new Date().toISOString()
    };

    // Save after each probe
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    done++;

    // Small delay between MSAs
    await sleep(2000 + Math.random() * 1000);

  } catch(err) {
    console.log(`  ERROR: ${err.message.slice(0,80)}`);
    errors++;
    // On error, try to recover by going back to Amazon homepage
    await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
    await sleep(3000);
  }
}

await browser.close();

// Summary
const fullFresh = Object.values(results).filter(r => r.status === 'full_fresh_confirmed').length;
const ambientOnly = Object.values(results).filter(r => r.status === 'ambient_fresh_only').length;
const none = Object.values(results).filter(r => r.status === 'none').length;

console.log(`\n=== DONE ===`);
console.log(`Total probed: ${Object.keys(results).length}`);
console.log(`Full fresh (strawberries available): ${fullFresh}`);
console.log(`Ambient fresh only (bananas, no strawberries): ${ambientOnly}`);
console.log(`No service: ${none}`);
console.log(`Errors: ${errors}`);
console.log(`Results saved to: ${RESULTS_PATH}`);
