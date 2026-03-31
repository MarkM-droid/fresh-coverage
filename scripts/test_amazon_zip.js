/**
 * test_amazon_zip.js — Test Amazon fresh availability for a single ZIP
 * Tests bananas + strawberries to determine fresh service type
 */
import { chromium } from 'playwright';

const TEST_ZIP = '10001'; // Manhattan NYC — should have everything
const ASINS = {
  bananas:      'B00N8VQKJU',
  strawberries: 'B002BBZ98W',
};

async function setZip(page, zip) {
  // Click the delivery location button
  try {
    await page.click('#nav-global-location-popover-link', { timeout: 5000 });
    await page.waitForSelector('#GLUXZipUpdateInput', { timeout: 5000 });
    await page.fill('#GLUXZipUpdateInput', zip);
    await page.click('[data-action="GLUXPostalUpdateAction"]');
    await page.waitForTimeout(2000);
    console.log(`  ZIP set to ${zip}`);
    return true;
  } catch(e) {
    console.log(`  ZIP set failed: ${e.message.slice(0,60)}`);
    return false;
  }
}

async function checkASIN(page, asin, name) {
  const url = `https://www.amazon.com/dp/${asin}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  const result = {
    asin, name,
    available: false,
    offer_types: [],
    delivery_text: null,
    unavailable: false
  };

  // Check for "Currently unavailable"
  const unavailText = await page.locator('#availability span').first().textContent({ timeout: 3000 }).catch(() => '');
  if (unavailText.toLowerCase().includes('unavailable') || unavailText.toLowerCase().includes('not available')) {
    result.unavailable = true;
    console.log(`  ${name}: ❌ Currently unavailable`);
    return result;
  }

  // Look for delivery offers
  const offerText = await page.locator('#mir-layout-DELIVERY_BLOCK, #deliveryBlockMessage, #ddmDeliveryMessage').allTextContents().catch(() => []);
  const fullText = offerText.join(' ').toLowerCase();

  // Check offer sources
  if (fullText.includes('amazonfresh') || fullText.includes('amazon fresh')) {
    result.offer_types.push('AmazonFresh');
    result.available = true;
  }
  if (fullText.includes('whole foods')) {
    result.offer_types.push('WholeFoods');
    result.available = true;
  }
  if (fullText.includes('today') || fullText.includes('in ') && fullText.includes('hour')) {
    result.offer_types.push('SSD_Prime');
    result.available = true;
  }

  // Grab delivery text for logging
  result.delivery_text = offerText.join(' ').slice(0, 200);
  
  if (result.available) {
    console.log(`  ${name}: ✅ Available — ${result.offer_types.join(', ')}`);
  } else {
    console.log(`  ${name}: ❓ Page loaded but no clear offer found`);
    console.log(`    Text: ${result.delivery_text?.slice(0,150)}`);
  }

  return result;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
});
const page = await context.newPage();

console.log(`Testing ZIP: ${TEST_ZIP}`);

// Go to Amazon first
await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

// Set ZIP
const zipSet = await setZip(page, TEST_ZIP);
console.log('ZIP set:', zipSet);

// Check each ASIN
for (const [name, asin] of Object.entries(ASINS)) {
  const result = await checkASIN(page, asin, name);
  console.log('Result:', JSON.stringify(result));
}

await browser.close();
console.log('Done.');
