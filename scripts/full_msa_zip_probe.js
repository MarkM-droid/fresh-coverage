/**
 * full_msa_zip_probe.js — Probe all ZIPs across top 200 MSAs (breadth-first)
 * - Breadth-first: 1 ZIP per MSA per pass, so partial runs = broad coverage
 * - Resumes automatically from saved results
 * - Saves every ZIP immediately to avoid data loss
 * Run: node scripts/full_msa_zip_probe.js
 */
import { chromium } from 'playwright';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS_PATH = join(ROOT, 'data', 'full_msa_zip_results.json');
const PROBE_ORDER_PATH = join(ROOT, 'data', 'full_msa_probe_order.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const probeOrder = JSON.parse(readFileSync(PROBE_ORDER_PATH, 'utf8'));
const results = existsSync(RESULTS_PATH) ? JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) : {};
const remaining = probeOrder.filter(z => !results[z.zip]);

const startTime = Date.now();
let doneCount = 0;

console.log(`ZIPs total: ${probeOrder.length} | Already done: ${Object.keys(results).length} | Remaining: ${remaining.length}`);
console.log(`Estimated time at 2min/ZIP: ${Math.round(remaining.length * 2 / 60)}h`);

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-dev-shm-usage']
});

async function probeZip(zipInfo) {
  const { zip, city, state, pop, msa_id, msa_name } = zipInfo;
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', {get:()=>false}); });
  const page = await ctx.newPage();

  try {
    // Set ZIP
    await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);

    const cont = page.locator('input[value*="Continue"], button:has-text("Continue shopping")');
    if (await cont.isVisible({ timeout: 1000 }).catch(()=>false)) { await cont.click(); await sleep(1500); }

    await page.locator('#nav-global-location-popover-link').click({ timeout: 5000 }).catch(()=>{});
    await sleep(1200);
    const input = page.locator('#GLUXZipUpdateInput');
    if (await input.isVisible({ timeout: 3000 }).catch(()=>false)) {
      await input.fill(zip);
      await page.locator('[data-action="GLUXPostalUpdateAction"]').click().catch(async()=>{ await page.keyboard.press('Enter'); });
      await sleep(4000);
    }

    const checkProduct = async (keyword) => {
      const knownAsins = {
        strawberries: ['B000P6J0SM', 'B002B8Z98W', 'B08911ZP3Y'],
        bananas: ['B07ZLF9WQ5', 'B07ZLFPXHC']
      };

      for (const asin of (knownAsins[keyword] || [])) {
        await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(1500);
        const body = (await page.locator('body').textContent().catch(()=>'')).toLowerCase();
        if (!body.includes('currently unavailable') && !body.includes("we don't know when")) {
          const buyboxText = await page.locator('#buybox,#rightCol').first().textContent().catch(()=>'');
          const fullBody = buyboxText.toLowerCase();
          await page.locator('a:has-text("other"), #buybox-see-all-buying-choices-announce').first().click().catch(()=>{});
          await sleep(1500);
          const panelText = (await page.locator('#aod-container').first().textContent().catch(()=>'')).toLowerCase();
          const combined = fullBody + ' ' + panelText;
          const offers = new Set();
          if (combined.includes('amazonfresh') || combined.includes('amazon fresh')) offers.add('AmazonFresh');
          if (combined.includes('whole foods')) offers.add('WholeFoods');
          if ((combined.includes('today') || combined.includes('hour')) && (combined.includes('amazon.com') || combined.includes('prime'))) offers.add('SSD_Prime');
          const addToCart = await page.locator('#add-to-cart-button').isVisible({timeout:1500}).catch(()=>false);
          if (addToCart || offers.size > 0) {
            return { available: true, asin, offers: [...offers] };
          }
          return { available: true, asin, offers: [] };
        }
      }

      // Fall back to search
      await page.goto(`https://www.amazon.com/s?k=${keyword}&i=amazonfresh`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000);
      const searchBody = (await page.locator('body').textContent().catch(()=>'')).toLowerCase();
      if (searchBody.includes('no results') || searchBody.includes('did not match')) {
        return { available: false, asin: null, offers: [] };
      }

      const firstResult = page.locator('[data-component-type="s-search-result"]').first();
      if (!await firstResult.isVisible({timeout:3000}).catch(()=>false)) {
        return { available: false, asin: null, offers: [] };
      }

      const asinEl = await firstResult.getAttribute('data-asin').catch(()=>null);
      if (!asinEl) return { available: false, asin: null, offers: [] };

      await page.goto(`https://www.amazon.com/dp/${asinEl}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1500);
      const dpBody = (await page.locator('body').textContent().catch(()=>'')).toLowerCase();
      if (dpBody.includes('currently unavailable') || dpBody.includes("we don't know when")) {
        return { available: false, asin: asinEl, offers: [] };
      }
      return { available: true, asin: asinEl, offers: [] };
    };

    const strawberries = await checkProduct('strawberries');
    const bananas = await checkProduct('bananas');

    const allOffers = new Set([...(strawberries.offers||[]), ...(bananas.offers||[])]);
    let status = 'none';
    if (strawberries.available && bananas.available) status = 'full_fresh';
    else if (bananas.available) status = 'ambient_fresh';

    return { zip, city, state, pop, msa_id, msa_name, status, offers: [...allOffers], strawberries, bananas };

  } catch (err) {
    return { zip, city, state, pop, msa_id, msa_name, status: 'error', error: err.message, offers: [] };
  } finally {
    await ctx.close().catch(()=>{});
  }
}

// Stats tracking
const msaStats = {};

for (const zipInfo of remaining) {
  const elapsed = Math.round((Date.now() - startTime) / 1000 / 60);
  const eta = doneCount > 0 ? Math.round((remaining.length - doneCount) * (elapsed / doneCount)) : '?';
  process.stdout.write(`elapsed:${elapsed}m eta:${eta}m [${doneCount}/${remaining.length}] ${zipInfo.zip} ${zipInfo.city} (${zipInfo.msa_name.slice(0,30)})\n`);

  const result = await probeZip(zipInfo);
  results[zipInfo.zip] = result;

  // Track MSA stats
  const mid = zipInfo.msa_id;
  if (!msaStats[mid]) msaStats[mid] = { msa_name: zipInfo.msa_name, full_fresh: 0, ambient_fresh: 0, none: 0, error: 0, total: 0 };
  msaStats[mid][result.status] = (msaStats[mid][result.status] || 0) + 1;
  msaStats[mid].total++;

  // Save immediately
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  doneCount++;

  // Log confirmed results
  if (result.status === 'full_fresh' || result.status === 'ambient_fresh') {
    console.log(`  ✓ ${result.status} | offers: ${result.offers.join(', ')||'(unknown)'}`);
  }

  await sleep(500);
}

await browser.close();

// Summary
console.log('\n=== COMPLETE ===');
const statusCounts = {};
for (const r of Object.values(results)) {
  statusCounts[r.status] = (statusCounts[r.status]||0) + 1;
}
console.log('Status totals:', statusCounts);
console.log(`MSAs with any coverage: ${Object.values(msaStats).filter(m=>m.full_fresh>0||m.ambient_fresh>0).length}`);
