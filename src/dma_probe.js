/**
 * dma_probe.js — DMA-tier-aware probe script for same-day grocery coverage
 *
 * Works through DMAs in priority order (mega first, micro skipped), generates
 * Brave search queries per tier strategy, writes results to the signals table,
 * updates city_coverage, then recomputes dma_coverage rollups.
 *
 * Usage:
 *   node src/dma_probe.js --retailer amazon_same_day [--max 50] [--rebuild-queue]
 *
 * Options:
 *   --retailer   retailer id (required)
 *   --max        max queries to run this session (default: 50)
 *   --rebuild-queue  regenerate probe_queue entries (skip existing done ones only)
 *
 * Cron: node src/dma_probe.js --retailer amazon_same_day --max 30
 *
 * Env: BRAVE_API_KEY
 */

import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH     = join(PROJECT_ROOT, 'data', 'coverage.db');
const LOGS_DIR    = join(PROJECT_ROOT, 'logs');

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

// ─── Query templates per method ───────────────────────────────────────────────
const QUERY_TEMPLATES = {
  news:           (dmaName) => `Amazon same day grocery delivery ${dmaName}`,
  plain_language: (dmaName) => `Can I get same day fresh groceries from Amazon in ${dmaName}`,
  reddit:         (dmaName) => `site:reddit.com Amazon same day grocery delivery ${dmaName}`,
  facebook:       (dmaName) => `Amazon same day grocery delivery available ${dmaName} 2025`,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg, logFile) {
  const line = `[dma_probe] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  if (logFile) try { appendFileSync(logFile, line + '\n'); } catch {}
}

// ─── Brave API ────────────────────────────────────────────────────────────────
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

// ─── Step 1: Build probe queue ────────────────────────────────────────────────
function buildProbeQueue(db, retailerId, rebuildQueue = false) {
  const strategies = db.prepare('SELECT * FROM probe_strategies').all();
  const stratMap = {};
  for (const s of strategies) {
    stratMap[s.tier] = { ...s, methods: JSON.parse(s.methods) };
  }

  const dmas = db.prepare('SELECT * FROM dmas ORDER BY id ASC').all();

  const checkExisting = db.prepare(`
    SELECT COUNT(*) as n FROM probe_queue
    WHERE retailer_id=? AND dma_id=? AND method=?
    AND status IN (${rebuildQueue ? "'done'" : "'pending','done'"})
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO probe_queue
      (retailer_id, dma_id, method, query, priority, status)
    VALUES (@retailer_id, @dma_id, @method, @query, @priority, 'pending')
  `);

  let added = 0;
  for (const dma of dmas) {
    const strategy = stratMap[dma.tier];
    if (!strategy || strategy.queries_per_dma === 0) continue; // skip micro

    for (const method of strategy.methods) {
      const tmpl = QUERY_TEMPLATES[method];
      if (!tmpl) continue; // skip zip_grid and unknown methods

      const existing = checkExisting.get(retailerId, dma.id, method);
      if (existing.n > 0) continue;

      const query    = tmpl(dma.name);
      const priority = Math.round((210 - dma.id) * strategy.priority_mult);

      insert.run({ retailer_id: retailerId, dma_id: dma.id, method, query, priority });
      added++;
    }
  }

  return added;
}

// ─── Step 2: Work the queue ───────────────────────────────────────────────────
async function runQueue(db, retailerId, opts, logFile) {
  const { maxQueries, delayMs, apiKey } = opts;

  const pending = db.prepare(`
    SELECT pq.*, d.name as dma_name
    FROM probe_queue pq
    JOIN dmas d ON d.id = pq.dma_id
    WHERE pq.status='pending' AND pq.retailer_id=?
    ORDER BY pq.priority DESC
    LIMIT ?
  `).all(retailerId, maxQueries);

  log(`Queue: ${pending.length} pending queries to run`, logFile);

  // Load cities for this DMA for city signal tagging (city->dma mapping)
  const allCities = db.prepare('SELECT city, state, dma_id FROM cities WHERE dma_id IS NOT NULL').all();
  const cityByDma = {};
  for (const c of allCities) {
    if (!cityByDma[c.dma_id]) cityByDma[c.dma_id] = [];
    cityByDma[c.dma_id].push(c);
  }

  const markRunning = db.prepare(`
    UPDATE probe_queue SET status='running', started_at=unixepoch() WHERE id=?
  `);
  const markDone = db.prepare(`
    UPDATE probe_queue SET status='done', finished_at=unixepoch(), result_summary=? WHERE id=?
  `);
  const insertSignal = db.prepare(`
    INSERT INTO signals
      (retailer_id, dma_id, city, state, signal_type, source, source_url, snippet, confidence)
    VALUES (@retailer_id, @dma_id, @city, @state, @signal_type, 'brave_search', @source_url, @snippet, @confidence)
  `);
  const upsertCity = db.prepare(`
    INSERT OR REPLACE INTO city_coverage
      (retailer_id, city, state, available, dma_id, source, source_url, confidence,
       confidence_tier, evidence_snippet, evidence_query, first_seen, last_confirmed)
    VALUES (
      @retailer_id, @city, @state, 1, @dma_id, 'dma_probe', @source_url, 75,
      'verified', @evidence_snippet, @evidence_query,
      COALESCE(
        (SELECT first_seen FROM city_coverage WHERE retailer_id=@retailer_id AND city=@city AND state=@state),
        unixepoch()
      ),
      unixepoch()
    )
  `);

  let totalSignals = 0;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    log(`  [${i+1}/${pending.length}] ${row.dma_name} / ${row.method}: ${row.query}`, logFile);

    markRunning.run(row.id);

    let data;
    try {
      data = await braveSearch(row.query, apiKey);
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        log('Rate limited — pausing 15s...', logFile);
        await sleep(15000);
        markDone.run('rate_limited', row.id);
        continue;
      }
      log(`  Error: ${err.message}`, logFile);
      markDone.run(`error: ${err.message}`, row.id);
      continue;
    }

    const results = data?.web?.results || [];
    const dmaCities = cityByDma[row.dma_id] || [];
    let signalCount = 0;

    for (const result of results) {
      const snippet    = (result.description || result.title || '').toLowerCase();
      const sourceUrl  = result.url || null;
      const rawSnippet = result.description || result.title || '';

      const hasSameDay    = snippet.includes('same-day') || snippet.includes('same day');
      const hasAvailable  = snippet.includes('available') || snippet.includes('now available');
      const hasUnavailable = snippet.includes('not available') || snippet.includes('not offered');

      let signalType, confidence;
      if (hasSameDay && hasAvailable && !hasUnavailable) {
        signalType = 'confirmed_available';
        confidence = 75;
      } else if (hasUnavailable) {
        signalType = 'confirmed_unavailable';
        confidence = 70;
      } else {
        signalType = 'mention';
        confidence = 40;
      }

      // Try to tag a city from this DMA
      let taggedCity = null, taggedState = null;
      for (const c of dmaCities) {
        if (snippet.includes(c.city.toLowerCase())) {
          taggedCity  = c.city;
          taggedState = c.state;
          break;
        }
      }

      insertSignal.run({
        retailer_id: retailerId,
        dma_id:      row.dma_id,
        city:        taggedCity,
        state:       taggedState,
        signal_type: signalType,
        source_url:  sourceUrl,
        snippet:     rawSnippet.slice(0, 500),
        confidence,
      });
      signalCount++;
      totalSignals++;

      // Upsert city_coverage if confirmed available for a specific city
      if (signalType === 'confirmed_available' && taggedCity) {
        upsertCity.run({
          retailer_id:      retailerId,
          city:             taggedCity,
          state:            taggedState,
          dma_id:           row.dma_id,
          source_url:       sourceUrl,
          evidence_snippet: rawSnippet.slice(0, 500),
          evidence_query:   row.query,
        });
        log(`    + city confirmed: ${taggedCity}, ${taggedState}`, logFile);
      }
    }

    markDone.run(`${signalCount} signals found`, row.id);
    log(`    -> ${signalCount} signals (${results.length} results)`, logFile);

    if (i < pending.length - 1) await sleep(delayMs);
  }

  return { queried: pending.length, totalSignals };
}

// ─── Step 3: Recompute dma_coverage rollups ───────────────────────────────────
function updateDmaCoverage(db, retailerId, logFile) {
  const result = db.prepare(`
    INSERT OR REPLACE INTO dma_coverage
      (retailer_id, dma_id, cities_total, cities_confirmed, cities_unavailable, cities_unknown, coverage_pct, confidence, last_updated)
    SELECT
      ? as retailer_id,
      c.dma_id,
      COUNT(*) as cities_total,
      SUM(CASE WHEN cc.available=1 THEN 1 ELSE 0 END) as cities_confirmed,
      SUM(CASE WHEN cc.available=0 THEN 1 ELSE 0 END) as cities_unavailable,
      SUM(CASE WHEN cc.available IS NULL THEN 1 ELSE 0 END) as cities_unknown,
      ROUND(100.0 * SUM(CASE WHEN cc.available=1 THEN 1 ELSE 0 END) / COUNT(*), 1) as coverage_pct,
      AVG(COALESCE(cc.confidence, 0)) as confidence,
      unixepoch() as last_updated
    FROM cities c
    LEFT JOIN city_coverage cc ON cc.city=c.city AND cc.state=c.state AND cc.retailer_id=?
    WHERE c.dma_id IS NOT NULL AND c.dma_id = c.dma_id
    GROUP BY c.dma_id
  `).run(retailerId, retailerId);

  log(`dma_coverage: ${result.changes} rows upserted`, logFile);
  return result.changes;
}

// ─── Args ─────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };
  return {
    retailer:     get('--retailer'),
    maxQueries:   parseInt(get('--max') || '50', 10),
    rebuildQueue: args.includes('--rebuild-queue'),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { retailer: retailerId, maxQueries, rebuildQueue } = parseArgs();
  const apiKey = process.env.BRAVE_API_KEY;

  if (!retailerId) { console.error('--retailer is required'); process.exit(1); }
  if (!apiKey)     { console.error('BRAVE_API_KEY not set'); process.exit(1); }
  if (!existsSync(DB_PATH)) { console.error('DB not found — run npm run setup'); process.exit(1); }

  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  const date    = new Date().toISOString().slice(0, 10);
  const logFile = join(LOGS_DIR, `dma_probe_${date}.log`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const retailer = db.prepare('SELECT * FROM retailers WHERE id=?').get(retailerId);
  if (!retailer) { console.error(`Unknown retailer: ${retailerId}`); process.exit(1); }

  log(`=== DMA Probe: ${retailer.name} ===`, logFile);
  log(`max=${maxQueries} rebuild-queue=${rebuildQueue}`, logFile);

  // Step 1: Build queue
  const added = buildProbeQueue(db, retailerId, rebuildQueue);
  log(`Queue: added ${added} new entries`, logFile);

  const queueSize = db.prepare(
    `SELECT COUNT(*) as n FROM probe_queue WHERE retailer_id=? AND status='pending'`
  ).get(retailerId).n;
  log(`Queue: ${queueSize} total pending`, logFile);

  // Step 2: Work queue
  const { queried, totalSignals } = await runQueue(
    db, retailerId,
    { maxQueries, delayMs: 2000, apiKey },
    logFile
  );

  // Step 3: Recompute rollups
  const dmaRows = updateDmaCoverage(db, retailerId, logFile);

  // Summary
  const confirmedCities = db.prepare(
    `SELECT COUNT(*) as n FROM city_coverage WHERE retailer_id=? AND available=1`
  ).get(retailerId).n;

  const topDmas = db.prepare(`
    SELECT d.name, dc.cities_confirmed, dc.coverage_pct
    FROM dma_coverage dc JOIN dmas d ON d.id=dc.dma_id
    WHERE dc.retailer_id=? AND dc.cities_confirmed > 0
    ORDER BY dc.cities_confirmed DESC
    LIMIT 5
  `).all(retailerId);

  log(`\n--- Summary ---`, logFile);
  log(`Queries run: ${queried}`, logFile);
  log(`Total signals: ${totalSignals}`, logFile);
  log(`Cities confirmed available: ${confirmedCities}`, logFile);
  log(`dma_coverage rows: ${dmaRows}`, logFile);
  if (topDmas.length) {
    log(`Top DMAs by confirmed cities:`, logFile);
    for (const d of topDmas) {
      log(`  ${d.name}: ${d.cities_confirmed} cities (${d.coverage_pct}%)`, logFile);
    }
  }

  db.close();
  log('Done.', logFile);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
