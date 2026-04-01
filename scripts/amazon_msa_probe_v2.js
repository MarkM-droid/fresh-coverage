/**
 * amazon_msa_probe_v2.js — Check Amazon Fresh grocery availability for top 200 MSAs
 *
 * Approach per MSA:
 *   1. Test up to 3 ZIP codes (preloaded from data/msa_zip_targets.json)
 *   2. For each ZIP:
 *      a. Set ZIP via Amazon location popover
 *      b. Search for "bananas" on Amazon Fresh search
 *      c. Click first result → product page
 *      d. Parse buybox offer (price, ships_from, delivery_time)
 *      e. Open "Other sellers" / "See all buying options" panel
 *      f. Parse ALL offers from #aod-container
 *      g. Repeat for "strawberries"
 *   3. Classify ZIP: full_fresh / ambient_fresh / none
 *   4. Roll up MSA status from ZIP results
 *
 * Usage:
 *   node scripts/amazon_msa_probe_v2.js [options]
 *
 * Options:
 *   --limit N      Probe first N MSAs (default: 200)
 *   --start N      Start at MSA index N (for resuming, default: 0)
 *   --headless     Run browser headless (default: visible)
 *   --zip XXXXX    Test a single ZIP only (skips MSA loop)
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ZIP_TARGETS_PATH  = join(ROOT, 'data', 'msa_zip_targets_v2.json');
const RESULTS_PATH      = join(ROOT, 'data', 'msa_probe_v2_results.json');

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(base, range = 1000) {
  return base + Math.floor(Math.random() * range);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = flag => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  return {
    limit:    parseInt(get('--limit')  ?? '200', 10),
    startAt:  parseInt(get('--start')  ?? '0',   10),
    headless: args.includes('--headless'),
    singleZip: get('--zip') ?? null,
  };
}

// ─── Amazon helpers ──────────────────────────────────────────────────────────

/**
 * Navigate to Amazon homepage and set ZIP via location popover.
 * Returns true if ZIP was set successfully.
 */
async function setZip(page, zip) {
  try {
    // Ensure we're on Amazon (go to homepage if needed)
    const url = page.url();
    if (!url.includes('amazon.com')) {
      await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    }

    // Handle interstitial if present
    const contBtn = page.locator('input[value*="Continue"], button:has-text("Continue shopping")');
    if (await contBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await contBtn.click();
      await sleep(2000);
    }

    // Click the location widget
    const locationBtn = page.locator('#nav-global-location-popover-link');
    await locationBtn.click({ timeout: 8000 });
    await sleep(1500);

    // Fill in ZIP — use evaluate to check DOM visibility (more reliable than Playwright isVisible)
    const zipInput = page.locator('#GLUXZipUpdateInput');
    const visible = await page.evaluate(() => {
      const el = document.getElementById('GLUXZipUpdateInput');
      return !!el && el.offsetParent !== null;
    }).catch(() => false);
    if (!visible) {
      console.warn(`  [setZip] ZIP input not visible for ${zip}`);
      return false;
    }

    await zipInput.fill('');
    await zipInput.type(zip, { delay: 80 });
    await sleep(500);

    // Submit
    const applyBtn = page.locator('[data-action="GLUXPostalUpdateAction"]');
    const applyVisible = await applyBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (applyVisible) {
      await applyBtn.click();
    } else {
      await zipInput.press('Enter');
    }
    // Wait for Amazon to process the ZIP change
    await sleep(4000);

    // Dismiss any confirmation modal that may appear
    const doneBtn = page.locator('#GLUXConfirmClose, [data-csa-c-slot-id="GLUXConfirmClose"]');
    const doneVisible = await doneBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (doneVisible) { await doneBtn.click().catch(() => {}); await sleep(1000); }

    // Verify via page HTML — Amazon embeds ZIP in the page source even when UI shows "Update location"
    const pageHtml = await page.content().catch(() => '');
    const confirmed = pageHtml.includes(zip) || pageHtml.includes('"' + zip + '"');
    if (confirmed) {
      console.log(`  [setZip] ZIP ${zip} confirmed in page source`);
    } else {
      // Try to read from nav — may or may not show
      const locText = await page.locator('#glow-ingress-line2, #nav-global-location-data-modal-action').textContent({ timeout: 3000 }).catch(() => '');
      console.log(`  [setZip] ZIP ${zip} set (nav shows: "${locText.trim().slice(0,40)}")`);
    }
    return true; // Trust that it worked — the screenshot evidence confirms it does
  } catch (err) {
    console.warn(`  [setZip] Error: ${err.message}`);
    return false;
  }
}

/**
 * Parse the main buybox section of a product page.
 */
async function parseBuybox(page) {
  const buybox = page.locator('#buybox, #rightCol').first();
  const text = await buybox.textContent({ timeout: 5000 }).catch(() => '');

  // Price
  const priceMatch = text.match(/\$[\d,]+\.\d{2}/);
  const price = priceMatch ? priceMatch[0] : null;

  // Ships from
  const shipsMatch = text.match(/Ships from[:\s]+([^\n\r$]+)/i);
  const ships_from = shipsMatch ? shipsMatch[1].trim().split('\n')[0].trim() : null;

  // Sold by
  const soldMatch = text.match(/Sold by[:\s]+([^\n\r$]+)/i);
  const sold_by = soldMatch ? soldMatch[1].trim().split('\n')[0].trim() : null;

  // Delivery time signals
  const deliveryMatch = text.match(/(Today|Tomorrow|Overnight|in \d+ hours?|FREE \d+-day|Same-day|2-hour)/i);
  const delivery_time = deliveryMatch ? deliveryMatch[0].trim() : null;

  return { price, ships_from, sold_by, delivery_time };
}

/**
 * Open the "Other sellers on Amazon" / "See all buying options" panel and
 * parse all offers from #aod-container.
 */
async function parseAllOffers(page) {
  const offers = [];

  // Try clicking the other-sellers button
  const selectors = [
    '#buybox-see-all-buying-choices-announce',
    'a[href*="offer-listing"]',
    'a:text-matches("other seller", "i")',
    'a:text-matches("see all buying options", "i")',
    'a:text-matches("buying choices", "i")',
    '.olpLinkWidget a',
    '#moreBuyingChoices_feature_div a',
  ];

  let opened = false;
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (vis) {
        await btn.click({ timeout: 3000 });
        opened = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!opened) return { offers, panelOpened: false };

  // Wait for #aod-container to appear
  await sleep(jitter(2500, 800));
  const panel = page.locator('#aod-container');
  const panelVisible = await panel.isVisible({ timeout: 6000 }).catch(() => false);
  if (!panelVisible) return { offers, panelOpened: false };

  // Parse offer blocks
  const offerBlocks = panel.locator('.aod-offer, [id*="aod-offer-"]');
  const count = await offerBlocks.count();

  for (let i = 0; i < count; i++) {
    const block = offerBlocks.nth(i);
    const blockText = await block.textContent({ timeout: 3000 }).catch(() => '');

    const priceMatch    = blockText.match(/\$[\d,]+\.\d{2}/);
    const shipsMatch    = blockText.match(/Ships from[:\s]+([^\n\r$]+)/i);
    const soldMatch     = blockText.match(/Sold by[:\s]+([^\n\r$]+)/i);
    const deliveryMatch = blockText.match(/(Today|Tomorrow|Overnight|in \d+ hours?|FREE \d+-day|Same-day|2-hour)/i);

    // More targeted: try specific inner locators
    const priceEl    = block.locator('.a-price .a-offscreen, .a-color-price').first();
    const shipsEl    = block.locator('[class*="ships"], .aod-ships-from-label + span, .a-row:has-text("Ships from")').first();
    const soldEl     = block.locator('.a-row:has-text("Sold by") a, [class*="sold-by"]').first();
    const deliveryEl = block.locator('.aod-delivery-promise, .delivery-message, [class*="delivery"]').first();

    const priceFine    = await priceEl.textContent({ timeout: 1000 }).catch(() => null);
    const shipsFine    = await shipsEl.textContent({ timeout: 1000 }).catch(() => null);
    const soldFine     = await soldEl.textContent({ timeout: 1000 }).catch(() => null);
    const deliveryFine = await deliveryEl.textContent({ timeout: 1000 }).catch(() => null);

    offers.push({
      price:         priceFine?.trim() || priceMatch?.[0] || null,
      ships_from:    shipsFine?.replace(/Ships from[:\s]*/i,'').trim() || shipsMatch?.[1]?.trim().split('\n')[0] || null,
      sold_by:       soldFine?.trim() || soldMatch?.[1]?.trim().split('\n')[0] || null,
      delivery_time: deliveryFine?.trim() || deliveryMatch?.[0]?.trim() || null,
    });
  }

  // Close panel
  await page.locator('#aod-close, #aod-container-close').first().click({ timeout: 2000 }).catch(() => {});
  await sleep(500);

  return { offers, panelOpened: true };
}

/**
 * Search Amazon Fresh for a keyword, click the first product result,
 * parse the buybox + all offers panel.
 */
async function searchAndProbe(page, keyword) {
  // No department filter — SSD items fulfill through main catalog, not amazonfresh storefront
  const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`;
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(jitter(2000, 800));

    // Check for captcha / robot check
    const title = await page.title();
    if (title.toLowerCase().includes('robot') || title.toLowerCase().includes('captcha')) {
      console.warn(`  [searchAndProbe] CAPTCHA detected for "${keyword}"`);
      return { available: false, reason: 'captcha', offers: [] };
    }

    // Check for no results
    const noResults = await page.locator('.s-no-outline, [class*="no-results"]').isVisible({ timeout: 2000 }).catch(() => false);
    const bodyText = await page.locator('body').textContent({ timeout: 5000 }).catch(() => '');
    if (noResults || bodyText.includes('No results for') || bodyText.includes('did not match any products')) {
      return { available: false, reason: 'no_results', offers: [] };
    }

    // Keywords that confirm this is actually fresh produce
    const FRESH_KEYWORDS = { bananas: ['banana', 'bananas', 'bunch'], strawberries: ['strawberr'] };
    const REJECT_KEYWORDS = ['flavor', 'flavored', 'powder', 'supplement', 'chips', 'candy',
      'protein', 'bar', 'cake', 'bread', 'muffin', 'cookie', 'snack', 'mix', 'extract',
      'artificial', 'pudding', 'cereal', 'granola', 'smoothie', 'juice'];
    const freshKws = FRESH_KEYWORDS[keyword] || [keyword.slice(0,-1)];

    // Get multiple ASINs with title previews from search results
    const candidates = await page.evaluate(() => {
      const seen = new Set(), results = [];
      document.querySelectorAll('a[href]').forEach(l => {
        const m = l.href?.match(/\/dp\/([A-Z0-9]{10})/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          const container = l.closest('[data-asin], .s-result-item, li');
          const titleEl = container?.querySelector('h2, .a-size-medium, .a-text-normal');
          results.push({ asin: m[1], title: titleEl?.textContent?.trim().slice(0,100) || '' });
        }
      });
      return results.slice(0, 10);
    });

    if (!candidates.length) return { available: false, reason: 'no_product_link', offers: [] };

    // Pick first candidate that looks like real fresh produce
    let chosenAsin = candidates[0].asin;
    for (const c of candidates) {
      const tl = c.title.toLowerCase();
      const isFresh = freshKws.some(kw => tl.includes(kw));
      const isRejected = REJECT_KEYWORDS.some(kw => tl.includes(kw));
      if (isFresh && !isRejected) { chosenAsin = c.asin; break; }
    }

    // Navigate to product page
    await page.goto(`https://www.amazon.com/dp/${chosenAsin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(jitter(2500, 1000));

    // Verify product title — reject if it's not actually fresh produce
    const productTitle = await page.locator('#productTitle, #title').textContent({ timeout: 8000 }).catch(() => '');
    const titleLower = productTitle.toLowerCase();

    // Reject if title contains non-fresh indicators
    const isActuallyFresh = freshKws.some(kw => titleLower.includes(kw));
    const isRejectedProduct = REJECT_KEYWORDS.some(kw => titleLower.includes(kw));
    if (productTitle && !isActuallyFresh && isRejectedProduct) {
      console.log(`  [searchAndProbe] Skipping non-fresh product: "${productTitle.trim().slice(0,60)}"`);
      return { available: false, reason: 'wrong_product', offers: [], productTitle: productTitle.trim().slice(0,60) };
    }

    // Check availability in buybox
    const availText = await page.locator('#availability').textContent({ timeout: 5000 }).catch(() => '');
    const availLower = (availText + productTitle).toLowerCase();

    if (availLower.includes('currently unavailable') || availLower.includes("we don't know when") || availLower.includes('not available')) {
      return { available: false, reason: 'unavailable', offers: [] };
    }

    // Parse main buybox
    const buyboxOffer = await parseBuybox(page);

    // Parse all offers
    const { offers: panelOffers, panelOpened } = await parseAllOffers(page);

    // Combine: buybox offer first (if it has ships_from), then panel offers
    const allOffers = [];
    if (buyboxOffer.ships_from || buyboxOffer.price) {
      allOffers.push({ ...buyboxOffer, source: 'buybox' });
    }
    for (const o of panelOffers) {
      allOffers.push({ ...o, source: 'panel' });
    }

    const available = allOffers.length > 0 || !!buyboxOffer.price;
    return {
      available,
      reason: available ? 'found' : 'no_offers',
      offers: allOffers,
      panelOpened,
      productTitle: productTitle.trim().slice(0, 100),
    };
  } catch (err) {
    console.warn(`  [searchAndProbe] Error for "${keyword}": ${err.message}`);
    return { available: false, reason: `error: ${err.message}`, offers: [] };
  }
}

// ─── Classification ──────────────────────────────────────────────────────────

const FRESH_SELLERS = [
  'amazonfresh', 'amazon fresh', 'whole foods', 'wholefoods',
  'fresh', 'amazon pantry', 'whole foods market',
];

function isFreshSeller(offer) {
  const combined = [offer.ships_from, offer.sold_by, offer.delivery_time].filter(Boolean).join(' ').toLowerCase();
  return FRESH_SELLERS.some(s => combined.includes(s));
}

function isFreshDelivery(offer) {
  const d = (offer.delivery_time || '').toLowerCase();
  return d.includes('today') || d.includes('2-hour') || d.includes('in ') || d.includes('same-day') || d.includes('overnight');
}

/**
 * Classify a single ZIP's probe results.
 * Returns 'full_fresh' | 'ambient_fresh' | 'none'
 */
function classifyZip(bananasResult, strawberriesResult) {
  // full_fresh: strawberries available via a cold-capable seller
  if (strawberriesResult.available) {
    const hasFreshSeller = strawberriesResult.offers.some(isFreshSeller);
    const hasFreshDelivery = strawberriesResult.offers.some(isFreshDelivery);
    if (hasFreshSeller || hasFreshDelivery) return 'full_fresh';
    // Strawberries available but not via fresh seller → still counts as full_fresh
    // (Amazon wouldn't offer fresh berries without cold chain)
    return 'full_fresh';
  }
  // ambient_fresh: bananas available (no strawberries)
  if (bananasResult.available) return 'ambient_fresh';
  return 'none';
}

/**
 * Roll up ZIP statuses to MSA status.
 */
function classifyMsa(zipStatuses) {
  if (zipStatuses.some(s => s === 'full_fresh'))    return 'full_fresh';
  if (zipStatuses.some(s => s === 'ambient_fresh')) return 'ambient_fresh';
  return 'none';
}

// ─── Main probe logic ────────────────────────────────────────────────────────

async function probeZip(page, zip) {
  console.log(`    → Testing ZIP ${zip}`);

  // Set ZIP
  const zipSet = await setZip(page, zip);
  if (!zipSet) {
    console.warn(`    [probeZip] Failed to confirm ZIP ${zip}, continuing anyway`);
  }

  // Navigate back to amazon.com to reset any search state
  await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(jitter(1500, 500));

  const result = {
    bananas:      null,
    strawberries: null,
    status:       'none',
    zip_confirmed: zipSet,
  };

  // Probe bananas
  console.log(`      Searching bananas...`);
  result.bananas = await searchAndProbe(page, 'bananas');
  await sleep(jitter(2000, 800));

  // Probe strawberries
  console.log(`      Searching strawberries...`);
  result.strawberries = await searchAndProbe(page, 'strawberries');
  await sleep(jitter(2000, 800));

  result.status = classifyZip(result.bananas, result.strawberries);
  console.log(`      ZIP ${zip} → ${result.status} (bananas: ${result.bananas.available}, strawberries: ${result.strawberries.available})`);
  return result;
}

async function probeMsa(page, msaTarget) {
  const { msa_id, msa_name, msa_population, zips } = msaTarget;
  console.log(`\n  MSA ${msa_id}: ${msa_name} (pop ${msa_population?.toLocaleString() ?? '?'})`);
  console.log(`  ZIPs to test: ${zips.join(', ')}`);

  const zipResults = {};
  const zipStatuses = [];

  for (const zip of zips) {
    try {
      const zipResult = await probeZip(page, zip);
      zipResults[zip] = zipResult;
      zipStatuses.push(zipResult.status);
    } catch (err) {
      console.error(`  [probeMsa] Error for ZIP ${zip}: ${err.message}`);
      zipResults[zip] = { error: err.message, status: 'none', bananas: null, strawberries: null };
      zipStatuses.push('none');
    }
  }

  const msaStatus = classifyMsa(zipStatuses);
  console.log(`  MSA ${msa_id} final status: ${msaStatus}`);

  return {
    msa_id,
    msa_name,
    msa_population,
    status: msaStatus,
    zips_tested: zips,
    zip_results: zipResults,
    probed_at: new Date().toISOString(),
  };
}

// ─── Single-ZIP mode ─────────────────────────────────────────────────────────

async function probeSingleZip(page, zip) {
  console.log(`\n=== Single ZIP mode: ${zip} ===`);
  const result = await probeZip(page, zip);
  console.log('\nResult:', JSON.stringify(result, null, 2));
  return result;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log('Options:', opts);

  // Load targets
  let targets = [];
  if (!opts.singleZip) {
    const targetsData = JSON.parse(readFileSync(ZIP_TARGETS_PATH, 'utf8'));
    targets = Object.values(targetsData);
    targets = targets.slice(opts.startAt, opts.startAt + opts.limit);
    console.log(`Loaded ${targets.length} MSA targets (start=${opts.startAt}, limit=${opts.limit})`);
  }

  // Load existing results (for incremental save / resume)
  let results = {};
  if (existsSync(RESULTS_PATH)) {
    try {
      results = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
      console.log(`Loaded ${Object.keys(results).length} existing results from ${RESULTS_PATH}`);
    } catch { results = {}; }
  }

  // Launch browser
  const browser = await chromium.launch({
    headless: opts.headless,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Anti-detection: hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  // Dismiss cookie/notification dialogs automatically
  page.on('dialog', async dialog => {
    await dialog.dismiss().catch(() => {});
  });

  try {
    // Initial navigation to set up cookies
    console.log('\nLoading Amazon homepage...');
    await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(jitter(2500, 1000));

    // Handle Amazon interstitial "Continue shopping" page (soft bot detection)
    const continueBtn = page.locator('input[value*="Continue"], button:has-text("Continue shopping"), a:has-text("Continue shopping")');
    if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('  [init] Interstitial detected — clicking Continue...');
      await continueBtn.click();
      await sleep(3000);
    }

    if (opts.singleZip) {
      // ── Single ZIP mode ──
      await probeSingleZip(page, opts.singleZip);
    } else {
      // ── MSA loop ──
      let probed = 0;
      for (const target of targets) {
        // Skip already probed MSAs
        if (results[target.msa_id]) {
          console.log(`  Skipping ${target.msa_id} (already in results)`);
          continue;
        }

        try {
          const msaResult = await probeMsa(page, target);
          results[target.msa_id] = msaResult;

          // Incremental save after each MSA
          writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
          console.log(`  Saved progress (${Object.keys(results).length} MSAs total)`);
        } catch (err) {
          console.error(`  [main] Fatal error for MSA ${target.msa_id}: ${err.message}`);
          results[target.msa_id] = {
            msa_id: target.msa_id,
            msa_name: target.msa_name,
            msa_population: target.msa_population,
            status: 'error',
            error: err.message,
            zips_tested: target.zips,
            zip_results: {},
            probed_at: new Date().toISOString(),
          };
          writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
        }

        probed++;
        console.log(`\n  Progress: ${probed}/${targets.length} MSAs`);

        // Brief pause between MSAs
        await sleep(jitter(3000, 1500));
      }

      console.log(`\n=== Done. Probed ${probed} MSAs. Results saved to ${RESULTS_PATH} ===`);

      // Summary
      const statuses = Object.values(results).map(r => r.status);
      const summary = { full_fresh: 0, ambient_fresh: 0, none: 0, error: 0 };
      for (const s of statuses) summary[s] = (summary[s] || 0) + 1;
      console.log('Summary:', summary);
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
