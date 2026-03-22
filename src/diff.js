/**
 * diff.js — Compare two snapshots or the last two DB runs
 *
 * Usage:
 *   node src/diff.js                          # compare last two runs in DB
 *   node src/diff.js --file a.json b.json     # compare two snapshot files
 *   node src/diff.js --retailer amazon_fresh  # filter by retailer
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const LOGS_DIR = join(PROJECT_ROOT, 'logs');

function log(msg) {
  console.log(`[diff] ${new Date().toISOString()} ${msg}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const files = fileIdx !== -1 ? [args[fileIdx + 1], args[fileIdx + 2]] : null;
  const retailer = args.includes('--retailer') ? args[args.indexOf('--retailer') + 1] : null;
  return { files, retailer };
}

/**
 * Load coverage map from a snapshot file.
 * Format: { retailer_id: { zip: { available, ... } } }
 */
function loadSnapshot(fpath) {
  const raw = JSON.parse(readFileSync(fpath, 'utf-8'));
  return raw;
}

/**
 * Get coverage map for a retailer from the DB at a given run ID.
 * Returns: { zip: available }
 */
function loadRunFromDb(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  // Get all zips that were last checked around this run's time window
  // Approximation: zips checked between started_at and finished_at
  const zips = db.prepare(`
    SELECT zc.zip, zc.available, zc.last_checked
    FROM zip_coverage zc
    WHERE zc.retailer_id = ?
      AND zc.last_checked BETWEEN ? AND ?
  `).all(run.retailer_id, run.started_at, run.finished_at ?? run.started_at + 3600);

  const map = {};
  for (const z of zips) map[z.zip] = z.available;
  return { retailer_id: run.retailer_id, map, run };
}

/**
 * Get the last two completed runs for a retailer from DB.
 */
function getLastTwoRuns(db, retailerId) {
  const query = retailerId
    ? `SELECT * FROM runs WHERE status = 'done' AND retailer_id = ? ORDER BY finished_at DESC LIMIT 2`
    : `SELECT * FROM runs WHERE status = 'done' ORDER BY finished_at DESC LIMIT 2`;
  const params = retailerId ? [retailerId] : [];
  return db.prepare(query).all(...params);
}

/**
 * Diff two coverage maps.
 * a and b are objects: { zip: available (0|1|2) }
 */
function diffMaps(a, b) {
  const allZips = new Set([...Object.keys(a), ...Object.keys(b)]);
  const added = [];    // zip moved to available=1 in b
  const lost = [];     // zip was available=1 in a, now 0 or missing in b
  const unchanged = [];

  for (const zip of allZips) {
    const aVal = a[zip] ?? -1;
    const bVal = b[zip] ?? -1;
    if (aVal !== 1 && bVal === 1) added.push(zip);
    else if (aVal === 1 && bVal !== 1) lost.push(zip);
    else unchanged.push(zip);
  }

  return { added, lost, unchanged };
}

/**
 * Group zips by state using the DB.
 */
function groupByState(db, zips) {
  const stateMap = {};
  for (const zip of zips) {
    const row = db.prepare('SELECT state, city FROM zip_master WHERE zip = ?').get(zip);
    const state = row?.state ?? 'UNKNOWN';
    if (!stateMap[state]) stateMap[state] = [];
    stateMap[state].push({ zip, city: row?.city ?? '' });
  }
  return stateMap;
}

function printStateBreakdown(label, stateMap) {
  const states = Object.keys(stateMap).sort();
  console.log(`\n${label}:`);
  for (const state of states) {
    const zips = stateMap[state];
    console.log(`  ${state}: ${zips.length} zip(s)`);
    if (zips.length <= 10) {
      for (const { zip, city } of zips) {
        console.log(`    ${zip} ${city}`);
      }
    } else {
      for (const { zip, city } of zips.slice(0, 5)) {
        console.log(`    ${zip} ${city}`);
      }
      console.log(`    ... and ${zips.length - 5} more`);
    }
  }
}

async function main() {
  const { files, retailer } = parseArgs();

  const db = existsSync(DB_PATH) ? new Database(DB_PATH) : null;

  let aMap, bMap, retailerIds = [];

  if (files) {
    // Compare two snapshot files
    if (!files[0] || !files[1]) {
      console.error('[diff] --file requires two file paths');
      process.exit(1);
    }
    log(`Comparing files:\n  A: ${files[0]}\n  B: ${files[1]}`);
    const aSnap = loadSnapshot(files[0]);
    const bSnap = loadSnapshot(files[1]);

    // Determine retailer IDs present in both
    const aRetailers = Object.keys(aSnap);
    const bRetailers = Object.keys(bSnap);
    retailerIds = [...new Set([...aRetailers, ...bRetailers])];
    if (retailer) retailerIds = retailerIds.filter(r => r === retailer);

    aMap = aSnap;
    bMap = bSnap;
  } else {
    // Use DB runs
    if (!db) {
      console.error('[diff] Database not found. Run npm run setup first.');
      process.exit(1);
    }

    const runs = getLastTwoRuns(db, retailer);
    if (runs.length < 2) {
      log(`Not enough completed runs to diff (found ${runs.length}). Run probes first.`);
      process.exit(0);
    }

    const [runB, runA] = runs; // most recent is B, older is A
    log(`Comparing run ${runA.id} (${new Date(runA.started_at * 1000).toISOString()}) → run ${runB.id} (${new Date(runB.started_at * 1000).toISOString()})`);

    const a = loadRunFromDb(db, runA.id);
    const b = loadRunFromDb(db, runB.id);

    retailerIds = [a.retailer_id];
    aMap = { [a.retailer_id]: a.map };
    bMap = { [b.retailer_id]: b.map };
  }

  const output = {
    generated_at: new Date().toISOString(),
    retailers: {},
  };

  for (const rid of retailerIds) {
    const a = aMap[rid] || {};
    const b = bMap[rid] || {};

    // Normalize: snapshot entries may have { available, ... } or just a number
    const normalize = map => {
      const out = {};
      for (const [zip, val] of Object.entries(map)) {
        out[zip] = typeof val === 'object' ? (val.available ?? 2) : val;
      }
      return out;
    };

    const { added, lost, unchanged } = diffMaps(normalize(a), normalize(b));

    console.log(`\n=== ${rid} ===`);
    console.log(`  Total in A: ${Object.keys(a).length}`);
    console.log(`  Total in B: ${Object.keys(b).length}`);
    console.log(`  Added (new coverage): ${added.length}`);
    console.log(`  Lost (coverage removed): ${lost.length}`);
    console.log(`  Unchanged: ${unchanged.length}`);

    if (db) {
      if (added.length) printStateBreakdown('Expansion (new zips)', groupByState(db, added));
      if (lost.length) printStateBreakdown('Contraction (lost zips)', groupByState(db, lost));
    }

    output.retailers[rid] = { added, lost, unchanged_count: unchanged.length };
  }

  // Save to logs
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(LOGS_DIR, `diff_${date}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`Diff saved to ${outPath}`);

  if (db) db.close();
}

main().catch(err => {
  console.error('[diff] Fatal error:', err);
  process.exit(1);
});
