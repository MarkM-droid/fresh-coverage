/**
 * direct_probe.js — Throttled direct HTTP prober for Amazon Fresh availability
 *
 * Usage:
 *   node src/direct_probe.js [--zip 10001] [--state TX]
 *
 * Strategy:
 *   - Checks Amazon Fresh availability by probing the address-validation endpoint
 *   - Very conservative: max 100 zips/run, randomized 3-8 second delays
 *   - Stops immediately on 429 or CAPTCHA detection
 */

import Database from 'better-sqlite3';
import { fetch as undiciFetch, Headers } from 'undici';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try {
  const { config } = await import('dotenv');
  config();
} catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const SNAPSHOTS_DIR = join(PROJECT_ROOT, 'data', 'snapshots');
const LOGS_DIR = join(PROJECT_ROOT, 'logs');

const MAX_ZIPS_PER_RUN = parseInt(process.env.MAX_ZIPS || '100', 10);
const DELAY_MIN_MS = 3000;
const DELAY_MAX_MS = 8000;

// Realistic browser-like headers to reduce bot detection
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

function log(msg) {
  const line = `[direct_probe] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(join(LOGS_DIR, 'direct_probe.log'), line + '\n');
  } catch {}
}

function parseArgs() {
  const args = process.argv.slice(2);
  const zip = args.includes('--zip') ? args[args.indexOf('--zip') + 1] : null;
  const state = args.includes('--state') ? args[args.indexOf('--state') + 1].toUpperCase() : null;
  return { zip, state };
}

function randomDelay() {
  const ms = DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Probe Amazon Fresh availability for a zip code.
 * Uses the Amazon zip-availability endpoint.
 * Returns: { available: boolean|null, captcha: boolean, error: string|null }
 */
async function probeAmazonFreshZip(zip) {
  // Amazon Fresh availability check URL pattern
  // This checks if same-day grocery delivery is available for a given zip
  const url = `https://www.amazon.com/gp/buy/shipoptionselect/handlers/display.html?opt=address&addressID=&fulfillmentType=Grocery&zipCode=${zip}`;

  let res;
  try {
    res = await undiciFetch(url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    });
  } catch (err) {
    return { available: null, captcha: false, error: err.message };
  }

  if (res.status === 429) {
    return { available: null, captcha: false, error: 'RATE_LIMITED', status: 429 };
  }

  if (res.status === 503 || res.status === 403) {
    return { available: null, captcha: false, error: `HTTP_${res.status}`, status: res.status };
  }

  let body = '';
  try {
    body = await res.text();
  } catch {
    return { available: null, captcha: false, error: 'BODY_READ_ERROR' };
  }

  // CAPTCHA detection
  if (
    body.includes('robot check') ||
    body.includes('captcha') ||
    body.includes('Type the characters') ||
    body.includes('/errors/validateCaptcha')
  ) {
    log(`CAPTCHA detected for zip ${zip} — stopping.`);
    return { available: null, captcha: true, error: 'CAPTCHA' };
  }

  // Availability signals in the response
  const lower = body.toLowerCase();
  const positiveSignals = [
    'amazon fresh',
    'same-day delivery',
    'same day delivery',
    'grocery delivery',
    'add to cart',
    'fulfilled by amazon',
  ];
  const negativeSignals = [
    'not available in your area',
    'amazon fresh is not',
    'delivery is not available',
    'not currently available',
  ];

  const hasPositive = positiveSignals.some(s => lower.includes(s));
  const hasNegative = negativeSignals.some(s => lower.includes(s));

  if (hasNegative) return { available: false, captcha: false, error: null };
  if (hasPositive) return { available: true, captcha: false, error: null };

  return { available: null, captcha: false, error: null }; // unknown
}

async function main() {
  const { zip: zipArg, state: stateArg } = parseArgs();

  if (!existsSync(DB_PATH)) {
    console.error(`[direct_probe] Database not found at ${DB_PATH}. Run 'npm run setup' first.`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Determine zip list
  let zips;
  if (zipArg) {
    zips = [zipArg];
  } else if (stateArg) {
    zips = db.prepare(
      'SELECT zip FROM zip_master WHERE state = ? ORDER BY zip LIMIT ?'
    ).all(stateArg, MAX_ZIPS_PER_RUN).map(r => r.zip);
  } else {
    // Default: pick zips not recently checked for amazon_fresh
    zips = db.prepare(`
      SELECT zm.zip FROM zip_master zm
      LEFT JOIN zip_coverage zc ON zc.zip = zm.zip AND zc.retailer_id = 'amazon_fresh'
      WHERE zc.last_checked IS NULL OR zc.last_checked < unixepoch() - 86400 * 7
      ORDER BY zm.population DESC NULLS LAST
      LIMIT ?
    `).all(MAX_ZIPS_PER_RUN).map(r => r.zip);
  }

  log(`Probing ${zips.length} zip codes for Amazon Fresh (max ${MAX_ZIPS_PER_RUN}/run)...`);

  const runId = db.prepare(`
    INSERT INTO runs (retailer_id, method, status) VALUES ('amazon_fresh', 'direct_http', 'running')
  `).run().lastInsertRowid;

  const upsertCoverage = db.prepare(`
    INSERT INTO zip_coverage (retailer_id, zip, available, first_seen, last_confirmed, last_checked, source, confidence)
    VALUES (@retailer_id, @zip, @available, @first_seen, @last_confirmed, @last_checked, @source, @confidence)
    ON CONFLICT(retailer_id, zip) DO UPDATE SET
      available = excluded.available,
      last_confirmed = CASE WHEN excluded.available = 1 THEN excluded.last_confirmed ELSE zip_coverage.last_confirmed END,
      last_checked = excluded.last_checked,
      source = excluded.source,
      confidence = excluded.confidence
  `);

  const snapshot = { amazon_fresh: {} };
  let checked = 0;
  let newCount = 0;
  let stopped = false;

  for (const zip of zips) {
    if (checked >= MAX_ZIPS_PER_RUN) {
      log(`Reached max zips per run (${MAX_ZIPS_PER_RUN}). Stopping.`);
      break;
    }

    log(`Checking zip ${zip} (${checked + 1}/${zips.length})...`);
    const result = await probeAmazonFreshZip(zip);

    if (result.captcha || result.error === 'RATE_LIMITED') {
      log(`Stopping due to: ${result.error || 'CAPTCHA'}`);
      db.prepare(`UPDATE runs SET status = 'error', finished_at = ?, notes = ? WHERE id = ?`)
        .run(Math.floor(Date.now() / 1000), result.error || 'CAPTCHA', runId);
      stopped = true;
      break;
    }

    const now = Math.floor(Date.now() / 1000);
    const existing = db.prepare(
      'SELECT available FROM zip_coverage WHERE retailer_id = ? AND zip = ?'
    ).get('amazon_fresh', zip);

    const availableVal = result.available === true ? 1 : result.available === false ? 0 : 2;
    const isNew = !existing && availableVal === 1;
    if (isNew) newCount++;

    upsertCoverage.run({
      retailer_id: 'amazon_fresh',
      zip,
      available: availableVal,
      first_seen: existing ? null : now,
      last_confirmed: availableVal === 1 ? now : null,
      last_checked: now,
      source: 'direct_http',
      confidence: result.available !== null ? 80 : 30,
    });

    snapshot.amazon_fresh[zip] = { available: availableVal, source: 'direct_http', ts: now };
    checked++;

    log(`  zip=${zip} available=${result.available ?? 'unknown'} error=${result.error ?? 'none'}`);

    if (checked < zips.length) {
      await randomDelay();
    }
  }

  if (!stopped) {
    db.prepare(`
      UPDATE runs SET status = 'done', finished_at = ?, zips_checked = ?, zips_new = ? WHERE id = ?
    `).run(Math.floor(Date.now() / 1000), checked, newCount, runId);
  }

  // Save snapshot
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const fname = join(SNAPSHOTS_DIR, `${date}_direct_amazon_fresh.json`);
  writeFileSync(fname, JSON.stringify(snapshot, null, 2));
  log(`Snapshot saved: ${fname}`);

  log(`Run complete: checked=${checked}, new=${newCount}, stopped_early=${stopped}`);
  db.close();
}

main().catch(err => {
  console.error('[direct_probe] Fatal error:', err);
  process.exit(1);
});
