/**
 * dallas_zip_probe_v2.js — Probe every ZIP in Dallas MSA, offer type per ZIP
 * Uses fresh page per ZIP to avoid context crashes
 */
import { chromium } from 'playwright';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULTS_PATH = join(ROOT, 'data', 'dallas_zip_results.json');
const ZIPS_PATH = join(ROOT, 'data', 'dallas_zips_full.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const dallasZips = JSON.parse(readFileSync(ZIPS_PATH, 'utf8'));
const results = existsSync(RESULTS_PATH) ? JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) : {};
const remaining = dallasZips.filter(z => !results[z.zip]);
console.log(`ZIPs total: ${dallasZips.length} | Probed: ${Object.keys(results).length} | Remaining: ${remaining.length}`);

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-dev-shm-usage']
});

async function probeZip(zip, city, state, lat, lng, pop) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', {get:()=>false}); });
  const page = await ctx.newPage();

  try {
    // Go to Amazon and set ZIP
    await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);

    // Handle interstitial
    const cont = page.locator('input[value*="Continue"], button:has-text("Continue shopping")');
    if (await cont.isVisible({ timeout: 1000 }).catch(()=>false)) { await cont.click(); await sleep(1500); }

    // Set ZIP
    await page.locator('#nav-global-location-popover-link').click({ timeout: 5000 }).catch(()=>{});
    await sleep(1200);
    const input = page.locator('#GLUXZipUpdateInput');
    if (await input.isVisible({ timeout: 3000 }).catch(()=>false)) {
      await input.fill(zip);
      await page.locator('[data-action="GLUXPostalUpdateAction"]').click().catch(async()=>{ await page.keyboard.press('Enter'); });
      await sleep(4000);
    }

    const checkProduct = async (keyword) => {
      // Known-good ASINs to try first before falling back to search
      const knownAsins = {
        strawberries: ['B000P6J0SM', 'B002B8Z98W', 'B08911ZP3Y'],
        bananas: ['B07ZLF9WQ5', 'B07ZLFPXHC']
      };

      // Try known ASINs first
      for (const asin of (knownAsins[keyword] || [])) {
        await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(1500);
        const body = (await page.locator('body').textContent().catch(()=>'')).toLowerCase();
        if (!body.includes('currently unavailable') && !body.includes("we don't know when")) {
          // Product is available — parse offers
          const buyboxText = await page.locator('#buybox,#rightCol').first().textContent().catch(()=>'');
          const fullBody = buyboxText.toLowerCase();
          await page.locator('a:has-text("other"), #buybox-see-all-buying-choices-announce').first().click().catch(()=>{});
          await sleep(1500);
          const panelText = (await page.locator('#aod-container').first().textContent().catch(()=>'')).toLowerCase();
          const combined = fullBody + ' ' + panelText;
          const offers = new Set();
          if (combined.includes('amazonfresh')||combined.includes('amazon fresh')) offers.add('AmazonFresh');
          if (combined.includes('whole foods')) offers.add('WholeFoods');
          if ((combined.includes('today')||combined.includes('hour'))&&(combined.includes('amazon.com')||combined.includes('prime'))) offers.add('SSD_Prime');
          const addToCart = await page.locator('#add-to-cart-button').isVisible({timeout:1500}).catch(()=>false);
          if (addToCart || offers.size > 0) {
            return { available: true, reason: 'found_known_asin', offers:[...offers], asin };
          }
        }
      }

      // Fallback to natural language search
      await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1500);

      // Get first fresh ASIN
      const candidates = await page.evaluate(() => {
        const seen = new Set(), out = [];
        document.querySelectorAll('a[href]').forEach(l => {
          const m = l.href?.match(/\/dp\/([A-Z0-9]{10})/);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            const c = l.closest('[data-asin],.s-result-item,li');
            const t = c?.querySelector('h2,.a-text-normal')?.textContent?.trim().slice(0,80)||'';
            out.push({asin:m[1],title:t});
          }
        });
        return out.slice(0,8);
      });

      if (!candidates.length) return { available: false, reason: 'no_results', offers: [] };

      const freshKws = keyword==='bananas' ? ['banana','bunch'] : ['strawberr'];
      const rejectKws = ['flavor','chip','candy','powder','protein','bar','cake','bread','snack','mix'];
      
      // Sort candidates — fresh ones first
      const sorted = candidates.sort((a,b) => {
        const aFresh = freshKws.some(k=>a.title.toLowerCase().includes(k)) ? 1 : 0;
        const bFresh = freshKws.some(k=>b.title.toLowerCase().includes(k)) ? 1 : 0;
        return bFresh - aFresh;
      });

      // Try ALL candidates until one is available — don't give up on first unavailable
      let foundAsin = null;
      let foundBody = '';
      for (const candidate of sorted.slice(0, 8)) {
        await page.goto(`https://www.amazon.com/dp/${candidate.asin}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(1000);
        const body = (await page.locator('body').textContent().catch(()=>'')).toLowerCase();
        if (!body.includes('currently unavailable') && !body.includes("we don't know when")) {
          foundAsin = candidate.asin;
          foundBody = body;
          break;
        }
      }

      if (!foundAsin) {
        return { available: false, reason: 'unavailable', offers: [] };
      }

      const body = foundBody;

      // Click other sellers
      await page.locator('a:has-text("other"), #buybox-see-all-buying-choices-announce').first().click().catch(()=>{});
      await sleep(1500);

      const fullBody = (await page.locator('body').textContent().catch(()=>'')).toLowerCase();
      const offers = new Set();
      if (fullBody.includes('amazonfresh')||fullBody.includes('amazon fresh')) offers.add('AmazonFresh');
      if (fullBody.includes('whole foods')) offers.add('WholeFoods');
      
      // Parse ships_from blocks more carefully
      const aodText = await page.locator('#aod-container, #aod-offer-list').first().textContent().catch(()=>'');
      const aodLower = aodText.toLowerCase();
      if (aodLower.includes('amazonfresh')||aodLower.includes('amazon fresh')) offers.add('AmazonFresh');
      if (aodLower.includes('whole foods')) offers.add('WholeFoods');
      
      const buyboxText = await page.locator('#buybox,#rightCol').first().textContent().catch(()=>'');
      const bLower = buyboxText.toLowerCase();
      if ((bLower.includes('today')||bLower.includes('hour'))&&(bLower.includes('amazon.com')||bLower.includes('prime'))) offers.add('SSD_Prime');
      if (bLower.includes('overnight')&&bLower.includes('amazon.com')) offers.add('Overnight_Amazon');
      if (bLower.includes('amazonfresh')||bLower.includes('amazon fresh')) offers.add('AmazonFresh');
      if (bLower.includes('whole foods')) offers.add('WholeFoods');

      const addToCart = await page.locator('#add-to-cart-button').isVisible({timeout:1500}).catch(()=>false);
      if (!addToCart && offers.size===0) return { available: false, reason: 'no_cart', offers:[] };
      return { available: true, reason: 'found', offers:[...offers], asin };
    };

    const bananas = await checkProduct('bananas');
    const strawberries = await checkProduct('strawberries');
    const allOffers = new Set([...bananas.offers,...strawberries.offers]);
    let status = 'none';
    if (strawberries.available) status='full_fresh';
    else if (bananas.available) status='ambient_fresh';

    return { zip, city, state, lat, lng, pop, status, offers:[...allOffers],
      bananas:{available:bananas.available,offers:bananas.offers,reason:bananas.reason},
      strawberries:{available:strawberries.available,offers:strawberries.offers,reason:strawberries.reason},
      probed_at: new Date().toISOString() };
  } finally {
    await ctx.close();
  }
}

let done=0, errors=0;
const start = Date.now();

for (const z of remaining) {
  const mins = Math.round((Date.now()-start)/60000);
  const eta = done>0 ? Math.round(mins/done*(remaining.length-done)) : '?';
  process.stdout.write(`\r[${done+1}/${remaining.length}] ${z.zip} ${(z.city||'').padEnd(18)} elapsed:${mins}m eta:${eta}m   `);

  try {
    const result = await probeZip(z.zip, z.city, z.state, z.lat, z.lng, z.pop);
    results[z.zip] = result;
    done++;
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    await sleep(1500 + Math.floor(Math.random()*1000));
  } catch(err) {
    errors++;
    console.log(`\n  ERROR ${z.zip}: ${err.message.slice(0,80)}`);
    results[z.zip] = { zip:z.zip, city:z.city, status:'error', error:err.message.slice(0,100), probed_at:new Date().toISOString() };
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    await sleep(3000);
  }
}

await browser.close();
const summary={};
Object.values(results).forEach(r=>{ summary[r.status]=(summary[r.status]||0)+1; });
const offerSummary={};
Object.values(results).filter(r=>r.offers).forEach(r=>r.offers.forEach(o=>{ offerSummary[o]=(offerSummary[o]||0)+1; }));
console.log(`\n\n=== DONE === ZIPs: ${Object.keys(results).length} | Status: ${JSON.stringify(summary)} | Offers: ${JSON.stringify(offerSummary)} | Errors: ${errors}`);
