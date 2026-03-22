/**
 * search_probe.js — Brave Search-based availability prober
 *
 * Strategy: query major metros + broad state/national coverage announcements.
 * ~50-100 searches per full US run (not thousands of per-city queries).
 *
 * Usage:
 *   node src/search_probe.js [options]
 *
 * Options:
 *   --retailer amazon_fresh|kroger|all   (default: all)
 *   --state TX                           top 10 metros in that state only
 *   --metro                              top 50 US metros only (best for daily cron)
 *   --national                           broad national/expansion queries only
 *   --dry-run                            show queries without hitting API
 *
 * Env: BRAVE_API_KEY (required), or set in .env
 */

import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const SNAPSHOTS_DIR = join(PROJECT_ROOT, 'data', 'snapshots');
const LOGS_DIR = join(PROJECT_ROOT, 'logs');

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const RATE_LIMIT_MS = 1200; // ~50/min, safely under free tier

// ─── Metro list ──────────────────────────────────────────────────────────────
// Top 50 US metros by population, with state and representative zip codes.
// These are the only areas we query by default for "where does it deliver."
const US_METROS = [
  { city: 'New York',        state: 'NY', zips: ['10001','10022','10036','11201','11215'] },
  { city: 'Los Angeles',     state: 'CA', zips: ['90001','90036','90210','91101','90266'] },
  { city: 'Chicago',         state: 'IL', zips: ['60601','60614','60625','60637','60657'] },
  { city: 'Houston',         state: 'TX', zips: ['77001','77002','77027','77056','77098'] },
  { city: 'Phoenix',         state: 'AZ', zips: ['85001','85014','85032','85251','85281'] },
  { city: 'Philadelphia',    state: 'PA', zips: ['19103','19107','19128','19143','19146'] },
  { city: 'San Antonio',     state: 'TX', zips: ['78201','78205','78209','78230','78249'] },
  { city: 'San Diego',       state: 'CA', zips: ['92101','92103','92116','92130','92037'] },
  { city: 'Dallas',          state: 'TX', zips: ['75201','75205','75214','75230','75248'] },
  { city: 'Jacksonville',    state: 'FL', zips: ['32202','32207','32216','32224','32244'] },
  { city: 'Austin',          state: 'TX', zips: ['78701','78704','78723','78745','78759'] },
  { city: 'Fort Worth',      state: 'TX', zips: ['76102','76107','76116','76132','76137'] },
  { city: 'Columbus',        state: 'OH', zips: ['43201','43205','43215','43220','43235'] },
  { city: 'Charlotte',       state: 'NC', zips: ['28202','28205','28209','28226','28277'] },
  { city: 'Indianapolis',    state: 'IN', zips: ['46201','46204','46220','46225','46250'] },
  { city: 'San Francisco',   state: 'CA', zips: ['94102','94107','94110','94117','94158'] },
  { city: 'Seattle',         state: 'WA', zips: ['98101','98103','98115','98122','98133'] },
  { city: 'Denver',          state: 'CO', zips: ['80202','80203','80209','80220','80246'] },
  { city: 'Nashville',       state: 'TN', zips: ['37201','37203','37206','37212','37221'] },
  { city: 'Oklahoma City',   state: 'OK', zips: ['73101','73103','73107','73112','73120'] },
  { city: 'El Paso',         state: 'TX', zips: ['79901','79902','79912','79924','79936'] },
  { city: 'Washington',      state: 'DC', zips: ['20001','20009','20016','20036','20852'] },
  { city: 'Las Vegas',       state: 'NV', zips: ['89101','89103','89109','89117','89128'] },
  { city: 'Louisville',      state: 'KY', zips: ['40202','40205','40207','40218','40229'] },
  { city: 'Memphis',         state: 'TN', zips: ['38103','38104','38111','38117','38128'] },
  { city: 'Portland',        state: 'OR', zips: ['97201','97202','97210','97217','97229'] },
  { city: 'Baltimore',       state: 'MD', zips: ['21201','21202','21209','21215','21224'] },
  { city: 'Milwaukee',       state: 'WI', zips: ['53201','53202','53208','53215','53222'] },
  { city: 'Albuquerque',     state: 'NM', zips: ['87101','87102','87106','87110','87120'] },
  { city: 'Tucson',          state: 'AZ', zips: ['85701','85705','85710','85719','85730'] },
  { city: 'Fresno',          state: 'CA', zips: ['93701','93702','93711','93720','93730'] },
  { city: 'Sacramento',      state: 'CA', zips: ['95814','95816','95820','95825','95838'] },
  { city: 'Kansas City',     state: 'MO', zips: ['64101','64105','64108','64112','64118'] },
  { city: 'Atlanta',         state: 'GA', zips: ['30301','30303','30306','30318','30327'] },
  { city: 'Omaha',           state: 'NE', zips: ['68101','68102','68104','68117','68130'] },
  { city: 'Colorado Springs',state: 'CO', zips: ['80901','80903','80906','80909','80919'] },
  { city: 'Raleigh',         state: 'NC', zips: ['27601','27604','27607','27610','27615'] },
  { city: 'Minneapolis',     state: 'MN', zips: ['55401','55403','55408','55414','55423'] },
  { city: 'Cleveland',       state: 'OH', zips: ['44101','44103','44106','44112','44120'] },
  { city: 'Wichita',         state: 'KS', zips: ['67201','67202','67206','67208','67215'] },
  { city: 'Arlington',       state: 'TX', zips: ['76001','76010','76012','76015','76017'] },
  { city: 'New Orleans',     state: 'LA', zips: ['70112','70115','70117','70119','70122'] },
  { city: 'Tampa',           state: 'FL', zips: ['33601','33602','33606','33609','33611'] },
  { city: 'Miami',           state: 'FL', zips: ['33101','33125','33127','33131','33139'] },
  { city: 'Orlando',         state: 'FL', zips: ['32801','32803','32806','32808','32819'] },
  { city: 'Pittsburgh',      state: 'PA', zips: ['15201','15206','15213','15217','15222'] },
  { city: 'Detroit',         state: 'MI', zips: ['48201','48202','48206','48214','48219'] },
  { city: 'Boston',          state: 'MA', zips: ['02101','02108','02115','02130','02134'] },
  { city: 'Cincinnati',      state: 'OH', zips: ['45201','45202','45206','45211','45220'] },
  { city: 'St. Louis',       state: 'MO', zips: ['63101','63103','63108','63116','63122'] },
];

// ─── Query builders ───────────────────────────────────────────────────────────

function metroQueries(retailerName, metro) {
  const loc = `${metro.city}, ${metro.state}`;
  if (retailerName === 'Amazon Fresh') {
    return [
      `"Amazon Fresh" same day delivery ${loc}`,
      `"Amazon Fresh" grocery delivery available ${loc} zip code`,
    ];
  } else if (retailerName === 'Kroger') {
    return [
      `"Kroger" same day grocery delivery ${loc}`,
      `"Kroger Delivery" available ${loc}`,
    ];
  }
  return [`"${retailerName}" same day delivery ${loc}`];
}

function nationalQueries(retailerName) {
  const year = new Date().getFullYear();
  if (retailerName === 'Amazon Fresh') {
    return [
      `"Amazon Fresh" same day delivery expansion ${year} new cities zip codes`,
      `"Amazon Fresh" same day delivery coverage map states available ${year}`,
      `site:amazon.com "Amazon Fresh" delivery available zip codes`,
      `"Amazon Fresh" same day delivery launched available cities ${year}`,
    ];
  } else if (retailerName === 'Kroger') {
    return [
      `"Kroger" same day grocery delivery expansion ${year} new cities`,
      `"Kroger Delivery" coverage available cities zip codes ${year}`,
      `site:kroger.com delivery available zip codes same day`,
      `"Kroger" same day delivery launched cities ${year}`,
    ];
  }
  return [`"${retailerName}" same day delivery coverage ${year}`];
}

// ─── Extraction helpers ───────────────────────────────────────────────────────

function extractZips(text) {
  const matches = text.match(/\b\d{5}(?:-\d{4})?\b/g) || [];
  return [...new Set(matches.map(z => z.slice(0, 5)))];
}

// Extract store/warehouse addresses from result text
// Looks for patterns like "123 Main St, City, ST 12345" or "at 456 Oak Ave"
function extractAddresses(results) {
  const addresses = [];
  const addrPattern = /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Pkwy|Hwy|Plaza|Center|Ct|Cir|Loop)\b[^,]*,\s*[A-Z][a-zA-Z\s]+,\s*[A-Z]{2}\s+\d{5}/g;
  for (const r of results) {
    const text = `${r.title} ${r.description || ''}`;
    const matches = text.match(addrPattern) || [];
    for (const addr of matches) {
      addresses.push({ raw: addr, source_url: r.url, title: r.title });
    }
  }
  return addresses;
}

function scoreAvailability(text) {
  const lower = text.toLowerCase();
  const positive = ['same-day delivery', 'same day delivery', 'available in', 'delivers to',
    'delivery available', 'now available', 'order now', 'get delivery', 'free delivery',
    'grocery delivery available', 'fresh delivery'];
  const negative = ['not available', 'not offered', 'coming soon', 'unavailable',
    'not yet available', 'not in your area'];
  const hasPos = positive.some(s => lower.includes(s));
  const hasNeg = negative.some(s => lower.includes(s));
  if (hasPos && !hasNeg) return { available: 1, confidence: 70 };
  if (hasNeg) return { available: 0, confidence: 60 };
  return { available: 2, confidence: 35 }; // unknown
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg, logFile) {
  const line = `[search_probe] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  if (logFile) {
    try { appendFileSync(logFile, line + '\n'); } catch {}
  }
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
  if (!res.ok) throw new Error(`Brave API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function upsertCoverage(db, retailer_id, zip, available, confidence, source_url, now) {
  const existing = db.prepare(
    'SELECT available, first_seen FROM zip_coverage WHERE retailer_id = ? AND zip = ?'
  ).get(retailer_id, zip);

  db.prepare(`
    INSERT INTO zip_coverage
      (retailer_id, zip, available, first_seen, last_confirmed, last_checked, source, source_url, confidence)
    VALUES (@retailer_id, @zip, @available, @first_seen, @last_confirmed, @last_checked,
            'brave_search', @source_url, @confidence)
    ON CONFLICT(retailer_id, zip) DO UPDATE SET
      available      = excluded.available,
      last_confirmed = CASE WHEN excluded.available = 1 THEN excluded.last_confirmed
                            ELSE zip_coverage.last_confirmed END,
      first_seen     = CASE WHEN zip_coverage.first_seen IS NULL THEN excluded.first_seen
                            ELSE zip_coverage.first_seen END,
      last_checked   = excluded.last_checked,
      source         = excluded.source,
      source_url     = COALESCE(excluded.source_url, zip_coverage.source_url),
      confidence     = excluded.confidence
  `).run({
    retailer_id,
    zip,
    available,
    first_seen: existing?.first_seen ?? now,
    last_confirmed: available === 1 ? now : null,
    last_checked: now,
    source_url,
    confidence,
  });

  const isNew = !existing && available === 1;
  const isUpgrade = existing && existing.available !== 1 && available === 1;
  return isNew || isUpgrade;
}

function upsertLocation(db, retailer_id, addr, source_url) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO locations
        (retailer_id, address_raw, source_url, discovered_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(retailer_id, addr, source_url);
  } catch {}
}

// ─── Main probe logic ─────────────────────────────────────────────────────────

async function runQueries(db, retailer, queries, apiKey, snapshot, runId, logFile, dryRun) {
  let checked = 0, newZips = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const query of queries) {
    log(`  Query: ${query}`, logFile);
    if (dryRun) { await sleep(50); continue; }

    let data;
    try {
      data = await braveSearch(query, apiKey);
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        log('  Rate limited — pausing 15s...', logFile);
        await sleep(15000);
        continue;
      }
      log(`  Error: ${err.message}`, logFile);
      continue;
    }

    const results = data?.web?.results || [];
    const allText = results.map(r => `${r.title} ${r.description || ''} ${r.url}`).join(' ');
    const zips = extractZips(allText);
    const addresses = extractAddresses(results);
    const { available, confidence } = scoreAvailability(allText);
    const sourceUrl = results[0]?.url || null;

    // Save any addresses found
    for (const { raw, source_url } of addresses) {
      upsertLocation(db, retailer.id, raw, source_url);
      log(`  📍 Address found: ${raw}`, logFile);
    }

    // Only write zip coverage for zips that exist in zip_master
    const validZips = zips.filter(z =>
      db.prepare('SELECT 1 FROM zip_master WHERE zip = ?').get(z)
    );

    for (const zip of validZips) {
      const gained = upsertCoverage(db, retailer.id, zip, available, confidence, sourceUrl, now);
      if (gained) newZips++;
      checked++;
      if (!snapshot[retailer.id]) snapshot[retailer.id] = {};
      snapshot[retailer.id][zip] = { available, confidence, source: 'brave_search', ts: now };
    }

    db.prepare('UPDATE runs SET zips_checked = zips_checked + ?, zips_new = zips_new + ? WHERE id = ?')
      .run(validZips.length, newZips, runId);

    if (validZips.length || addresses.length) {
      log(`  → ${validZips.length} zips, ${addresses.length} addresses, available=${available}`, logFile);
    }

    await sleep(RATE_LIMIT_MS);
  }

  return { checked, newZips };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  return {
    retailer: get('--retailer') || 'all',
    state:    get('--state')?.toUpperCase() || null,
    metro:    args.includes('--metro'),
    national: args.includes('--national'),
    dryRun:   args.includes('--dry-run'),
  };
}

async function main() {
  const { retailer: retailerFlag, state, metro, national, dryRun } = parseArgs();
  const apiKey = process.env.BRAVE_API_KEY;

  if (!dryRun && !apiKey) {
    console.error('Error: BRAVE_API_KEY not set. Add it to .env');
    process.exit(1);
  }
  if (!existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Run 'npm run setup' first.`);
    process.exit(1);
  }

  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(LOGS_DIR, `search_probe_${date}.log`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const retailers = retailerFlag === 'all'
    ? db.prepare('SELECT * FROM retailers').all()
    : db.prepare('SELECT * FROM retailers WHERE id = ?').all(retailerFlag);

  if (!retailers.length) {
    console.error(`Unknown retailer: ${retailerFlag}`);
    process.exit(1);
  }

  // Pick metros to query
  let metros;
  if (state) {
    metros = US_METROS.filter(m => m.state === state).slice(0, 10);
    if (!metros.length) {
      // Fallback: pick top cities from zip_master for that state
      const cities = db.prepare(
        'SELECT DISTINCT city, state FROM zip_master WHERE state = ? AND city IS NOT NULL LIMIT 10'
      ).all(state);
      metros = cities.map(c => ({ city: c.city, state: c.state, zips: [] }));
    }
    log(`State mode: ${metros.length} metros for ${state}`, logFile);
  } else {
    metros = US_METROS; // all 50
    log(`Metro mode: ${metros.length} metros nationwide`, logFile);
  }

  const snapshot = {};

  for (const retailer of retailers) {
    log(`\n=== ${retailer.name} ===`, logFile);
    if (dryRun) log('DRY RUN — no API calls will be made', logFile);

    const runId = dryRun ? -1 : db.prepare(
      `INSERT INTO runs (retailer_id, method, status) VALUES (?, 'brave_search', 'running')`
    ).run(retailer.id).lastInsertRowid;

    const allQueries = [];

    // National/expansion queries (always run unless state-only mode)
    if (!state || national) {
      allQueries.push(...nationalQueries(retailer.name));
    }

    // Metro queries (unless national-only)
    if (!national) {
      for (const m of metros) {
        allQueries.push(...metroQueries(retailer.name, m));
      }
    }

    log(`Total queries to run: ${allQueries.length}`, logFile);

    const { checked, newZips } = await runQueries(
      db, retailer, allQueries, apiKey, snapshot, runId, logFile, dryRun
    );

    if (!dryRun) {
      db.prepare(
        `UPDATE runs SET status='done', finished_at=unixepoch(), zips_checked=?, zips_new=? WHERE id=?`
      ).run(checked, newZips, runId);
    }

    log(`Done: checked=${checked} zips, new/upgraded=${newZips}`, logFile);
  }

  if (!dryRun) {
    const snapPath = join(SNAPSHOTS_DIR, `${date}_search_${retailers.map(r=>r.id).join('_')}.json`);
    writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
    log(`Snapshot: ${snapPath}`, logFile);
  }

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
