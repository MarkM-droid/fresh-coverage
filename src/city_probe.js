/**
 * city_probe.js — City-level coverage prober using Brave Search
 *
 * Queries Brave for each US city to detect same-day grocery delivery availability.
 * Results stored in city_coverage table. One query per city — much more efficient
 * and accurate than zip-level probing.
 *
 * Usage:
 *   node src/city_probe.js [options]
 *
 * Options:
 *   --retailer amazon_same_day|amazon_fresh|kroger|all  (default: amazon_same_day)
 *   --state TX                 only cities in that state
 *   --limit 500                max cities to probe (default: 500)
 *   --min-pop 10000            only cities above this population (default: 5000)
 *   --seed                     seed known cities from announcements first
 *   --dry-run                  show queries without hitting API
 *
 * Env: BRAVE_API_KEY
 */

import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const LOGS_DIR = join(PROJECT_ROOT, 'logs');
const SNAPSHOTS_DIR = join(PROJECT_ROOT, 'data', 'snapshots');

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const RATE_LIMIT_MS = 1100;

// ─── Known cities from Amazon official announcements ─────────────────────────
// Source: aboutamazon.com press releases Aug + Dec 2025
const AMAZON_SAME_DAY_KNOWN = [
  // Summer 2025 launch cities
  { city: 'Seattle',        state: 'WA' },
  { city: 'Los Angeles',    state: 'CA' },
  { city: 'Dallas',         state: 'TX' },
  { city: 'Chicago',        state: 'IL' },
  { city: 'Miami',          state: 'FL' },
  { city: 'New York',       state: 'NY' },
  { city: 'Phoenix',        state: 'AZ' },
  { city: 'Orlando',        state: 'FL' },
  { city: 'Kansas City',    state: 'MO' },
  // December 2025 expansion examples
  { city: 'Boise',          state: 'ID' },
  { city: 'Salt Lake City', state: 'UT' },
  { city: 'Fort Collins',   state: 'CO' },
  { city: 'Omaha',          state: 'NE' },
  { city: 'Sugar Land',     state: 'TX' },
  { city: 'Des Moines',     state: 'IA' },
  { city: 'Kennesaw',       state: 'GA' },
  { city: 'Gaithersburg',   state: 'MD' },
];

// ─── Query builder ────────────────────────────────────────────────────────────
function buildQuery(retailerName, city, state) {
  if (retailerName === 'Amazon Same-Day Grocery') {
    // Simple natural-language query performs much better than over-quoted strings
    return `Amazon same day grocery delivery ${city} ${state}`;
  } else if (retailerName === 'Amazon Fresh') {
    return `Amazon Fresh same day delivery ${city} ${state}`;
  } else if (retailerName === 'Kroger') {
    return `Kroger same day grocery delivery ${city} ${state}`;
  }
  return `${retailerName} same day grocery delivery ${city} ${state}`;
}

// ─── Signal scoring ───────────────────────────────────────────────────────────
function scoreResult(results, city, state) {
  const text = results.map(r => `${r.title} ${r.description || ''}`).join(' ').toLowerCase();
  const cityLower = city.toLowerCase();

  const positive = [
    'same-day delivery', 'same day delivery', 'now available', 'available in',
    'delivers to', 'delivery available', 'launched in', 'expanding to',
    'now delivering', 'get it today', 'order today',
    'customers can now', 'now offers', 'has expanded', 'is now available',
    'fresh groceries now', 'grocery delivery to', 'perishable', 'fresh produce',
    'amazon fresh', 'prime members can',
  ];
  const negative = [
    'not available', 'not yet', 'coming soon', 'unavailable', 'does not deliver',
    'not offered', 'not in your area',
  ];

  // Boost confidence if city name appears in results
  const cityMentioned = text.includes(cityLower);
  const hasPos = positive.some(s => text.includes(s));
  const hasNeg = negative.some(s => text.includes(s));

  if (hasNeg && !hasPos) return { available: 0, confidence: 55 };
  if (hasPos && cityMentioned) return { available: 1, confidence: 75 };
  if (hasPos) return { available: 1, confidence: 55 };
  return { available: 2, confidence: 30 }; // unknown
}

// ─── Brave API ────────────────────────────────────────────────────────────────
const COST_PER_QUERY = 0.005; // $5 per 1,000 queries
const MONTHLY_BUDGET = 100;   // $100/month cap — alert at 80%

async function braveSearch(query, apiKey) {
  const url = new URL(BRAVE_API_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', '10');
  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });
  if (res.status === 429) throw new Error('RATE_LIMITED');
  if (!res.ok) throw new Error(`Brave API ${res.status}`);
  return res.json();
}

function logApiUsage(db, source, queries) {
  const date = new Date().toISOString().slice(0, 10);
  const cost = queries * COST_PER_QUERY;
  db.prepare(`
    INSERT INTO api_usage (date, source, queries, cost_usd)
    VALUES (?, ?, ?, ?)
  `).run(date, source, queries, cost);

  // Check monthly spend
  const month = date.slice(0, 7);
  const monthTotal = db.prepare(`
    SELECT SUM(queries) as q, SUM(cost_usd) as cost FROM api_usage WHERE date LIKE ?
  `).get(month + '%');

  const pct = (monthTotal.cost / MONTHLY_BUDGET * 100).toFixed(1);
  const alert = monthTotal.cost >= MONTHLY_BUDGET * 0.8;
  return {
    todayQueries: queries,
    monthQueries: monthTotal.q,
    monthCost: monthTotal.cost.toFixed(2),
    pct,
    alert,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg, logFile) {
  const line = `[city_probe] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  if (logFile) try { appendFileSync(logFile, line + '\n'); } catch {}
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
function upsertCity(db, retailer_id, city, state, available, confidence, source_url, source, snippet = null, query = null) {
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare(
    'SELECT available FROM city_coverage WHERE retailer_id=? AND city=? AND state=?'
  ).get(retailer_id, city, state);

  const confidence_tier = ['dma_probe','brave_search','official_announcement'].includes(source) ? 'verified' : 'inferred';

  db.prepare(`
    INSERT INTO city_coverage
      (retailer_id, city, state, available, first_seen, last_confirmed, source, source_url,
       confidence, confidence_tier, evidence_snippet, evidence_query)
    VALUES (@retailer_id, @city, @state, @available, @first_seen, @last_confirmed, @source, @source_url,
            @confidence, @confidence_tier, @evidence_snippet, @evidence_query)
    ON CONFLICT(retailer_id, city, state) DO UPDATE SET
      available         = excluded.available,
      last_confirmed    = excluded.last_confirmed,
      source            = excluded.source,
      source_url        = COALESCE(excluded.source_url, city_coverage.source_url),
      confidence        = MAX(city_coverage.confidence, excluded.confidence),
      confidence_tier   = CASE WHEN excluded.confidence_tier='verified' THEN 'verified' ELSE city_coverage.confidence_tier END,
      evidence_snippet  = COALESCE(excluded.evidence_snippet, city_coverage.evidence_snippet),
      evidence_query    = COALESCE(excluded.evidence_query, city_coverage.evidence_query)
  `).run({
    retailer_id, city, state, available,
    first_seen: existing ? undefined : now,
    last_confirmed: now,
    source,
    source_url,
    confidence: confidence || 75,
    confidence_tier,
    evidence_snippet: snippet ? snippet.slice(0, 500) : null,
    evidence_query: query || null,
  });

  return !existing && available === 1; // true if newly discovered
}

// ─── Args ─────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = f => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };
  return {
    retailer: get('--retailer') || 'amazon_same_day',
    state:    get('--state')?.toUpperCase() || null,
    limit:    parseInt(get('--limit') || '500', 10),
    minPop:   parseInt(get('--min-pop') || '5000', 10),
    seed:     args.includes('--seed'),
    dryRun:   args.includes('--dry-run'),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { retailer: retailerFlag, state, limit, minPop, seed, dryRun } = parseArgs();
  const apiKey = process.env.BRAVE_API_KEY;

  if (!dryRun && !apiKey) { console.error('BRAVE_API_KEY not set'); process.exit(1); }
  if (!existsSync(DB_PATH)) { console.error('DB not found — run npm run setup'); process.exit(1); }

  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(LOGS_DIR, `city_probe_${date}.log`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const retailers = retailerFlag === 'all'
    ? db.prepare('SELECT * FROM retailers').all()
    : db.prepare('SELECT * FROM retailers WHERE id = ?').all(retailerFlag);

  if (!retailers.length) { console.error(`Unknown retailer: ${retailerFlag}`); process.exit(1); }

  for (const retailer of retailers) {
    log(`\n=== ${retailer.name} ===`, logFile);

    // Seed known cities from official announcements (no API call needed)
    if (seed && retailer.id === 'amazon_same_day') {
      log(`Seeding ${AMAZON_SAME_DAY_KNOWN.length} cities from official Amazon announcements...`, logFile);
      for (const { city, state: st } of AMAZON_SAME_DAY_KNOWN) {
        const isNew = upsertCity(db, retailer.id, city, st, 1, 95,
          'https://www.aboutamazon.com/news/retail/amazon-same-day-fresh-grocery-delivery-united-states',
          'official_announcement',
          'Confirmed in Amazon official announcement: same-day grocery delivery available in over 2,300 US cities for Prime members.',
          'Amazon official announcement Dec 2025');
        if (isNew) log(`  + ${city}, ${st} (official)`, logFile);
      }
      log(`Seed complete.`, logFile);
    }

    // Build city list — prioritized by facility proximity
    // Tier 1: cities in DMAs with confirmed Fresh/SSD facilities (has_fresh)
    // Tier 2: cities in DMAs with any Amazon facility (has_facility)
    // Tier 3: cities in DMAs with no facility found (no_facility / unprobed)
    // Within each tier: prefer cities not recently checked (14-day window)
    // Skip cities already confirmed available
    const stateFilter = state ? 'AND c.state = ?' : '';
    const stateParam  = state ? [state] : [];

    const cityQuery = `
      SELECT c.city, c.state,
        CASE d.place_probe_status
          WHEN 'has_fresh'    THEN 1
          WHEN 'has_facility' THEN 2
          ELSE 3
        END AS facility_tier,
        -- Distance to nearest facility of any type (km), NULL if none
        (SELECT MIN(
            6371 * 2 * ASIN(SQRT(
              POWER(SIN((RADIANS(l.lat) - RADIANS(c.lat)) / 2), 2) +
              COS(RADIANS(c.lat)) * COS(RADIANS(l.lat)) *
              POWER(SIN((RADIANS(l.lng) - RADIANS(c.lng)) / 2), 2)
            ))
          )
          FROM locations l
          WHERE l.retailer_id = ? AND l.lat IS NOT NULL AND l.lng IS NOT NULL
            AND c.lat IS NOT NULL AND c.lng IS NOT NULL
        ) AS dist_km
      FROM cities c
      LEFT JOIN dmas d ON d.id = c.dma_id
      LEFT JOIN city_coverage cc ON cc.city = c.city AND cc.state = c.state
        AND cc.retailer_id = ?
      WHERE cc.available IS NULL                          -- never checked
         OR (cc.available = 0                             -- was negative, recheck after 14 days
             AND cc.last_confirmed < unixepoch() - 86400*14)
        ${stateFilter}
      ORDER BY
        facility_tier ASC,                  -- facility DMAs first
        dist_km ASC NULLS LAST,             -- closest to a facility within tier
        c.state, c.city
      LIMIT ?
    `;

    const cities = db.prepare(cityQuery).all(retailer.id, retailer.id, ...stateParam, limit);
    const facilityTierCounts = [0,0,0];
    cities.forEach(c => facilityTierCounts[(c.facility_tier||3)-1]++);
    log(`${cities.length} cities to probe | has_fresh DMAs: ${facilityTierCounts[0]}, has_facility: ${facilityTierCounts[1]}, other: ${facilityTierCounts[2]}`, logFile);
    if (dryRun) log('DRY RUN — no API calls', logFile);

    let checked = 0, found = 0, newFound = 0;

    for (const { city, state: st } of cities) {
      // Skip if already confirmed available (available=1)
      // Skip if confirmed negative (available=0) within last 14 days
      const existing = db.prepare(`
        SELECT available, last_confirmed FROM city_coverage
        WHERE retailer_id=? AND city=? AND state=?
      `).get(retailer.id, city, st);
      if (existing) {
        if (existing.available === 1) continue; // already confirmed, skip
        if (existing.available === 0 && existing.last_confirmed > (Date.now()/1000 - 86400*14)) continue; // recent negative
      }

      const query = buildQuery(retailer.name, city, st);
      log(`  [${checked+1}] ${city}, ${st}`, logFile);

      if (!dryRun) {
        let data;
        try {
          data = await braveSearch(query, apiKey);
        } catch (err) {
          if (err.message === 'RATE_LIMITED') {
            log('Rate limited — pausing 15s...', logFile);
            await sleep(15000);
            continue;
          }
          log(`  Error: ${err.message}`, logFile);
          checked++;
          continue;
        }

        const results = data?.web?.results || [];
        const { available, confidence } = scoreResult(results, city, st);
        const sourceUrl = results[0]?.url || null;
        const topSnippet = results[0]?.description || results[0]?.snippet || null;

        if (available === 1) {
          // Confirmed available — write to DB
          const isNew = upsertCity(db, retailer.id, city, st, 1, confidence, sourceUrl, 'brave_search', topSnippet, query);
          found++;
          if (isNew) {
            newFound++;
            log(`  ✅ ${city}, ${st} — AVAILABLE (confidence: ${confidence}%)`, logFile);
          }
        } else if (available === 0) {
          // Confirmed unavailable — write to DB
          upsertCity(db, retailer.id, city, st, 0, confidence, sourceUrl, 'brave_search', topSnippet, query);
          log(`  ❌ ${city}, ${st} — NOT AVAILABLE`, logFile);
        } else {
          // Inconclusive — do NOT update last_confirmed so we can retry sooner
          // Only log at debug level
          log(`  ❓ ${city}, ${st} — inconclusive (no signal)`, logFile);
        }

        await sleep(RATE_LIMIT_MS);
      }

      checked++;
    }

    // Summary
    const total = db.prepare(
      `SELECT COUNT(*) as n FROM city_coverage WHERE retailer_id=? AND available=1`
    ).get(retailer.id).n;

    const byState = db.prepare(`
      SELECT state, COUNT(*) as n
      FROM city_coverage
      WHERE retailer_id=? AND available=1
      GROUP BY state ORDER BY n DESC
    `).all(retailer.id);

    log(`\n--- ${retailer.name} Summary ---`, logFile);
    log(`Cities confirmed available: ${total}`, logFile);
    log(`States with coverage: ${byState.length}`, logFile);
    log(`This run: checked=${checked}, found available=${found}, newly discovered=${newFound}`, logFile);
    log(`Top states: ${byState.slice(0,5).map(r => `${r.state}(${r.n})`).join(', ')}`, logFile);

    // Log API usage and check budget
    if (!dryRun && checked > 0) {
      const usage = logApiUsage(db, 'city_probe', checked);
      log(`API usage: ${usage.todayQueries} queries this run | ${usage.monthQueries} this month | $${usage.monthCost}/$${MONTHLY_BUDGET} (${usage.pct}%)`, logFile);
      if (usage.alert) {
        const alertMsg = `⚠️ BRAVE API BUDGET ALERT: $${usage.monthCost} of $${MONTHLY_BUDGET} used this month (${usage.pct}%). Consider increasing budget or reducing probe frequency.`;
        log(alertMsg, logFile);
        console.warn(alertMsg);
        // Write alert file for cron to pick up
        writeFileSync(join(PROJECT_ROOT, 'data', 'api_budget_alert.txt'), alertMsg);
      }
    }

    // Save snapshot
    const snapshot = db.prepare(`
      SELECT city, state, available, confidence, source, first_seen
      FROM city_coverage WHERE retailer_id=?
    `).all(retailer.id);
    const snapPath = join(SNAPSHOTS_DIR, `${date}_cities_${retailer.id}.json`);
    writeFileSync(snapPath, JSON.stringify({ retailer: retailer.id, cities: snapshot }, null, 2));
    log(`Snapshot: ${snapPath}`, logFile);
  }

  db.close();
  log('\nDone.', logFile);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
