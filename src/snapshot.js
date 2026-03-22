/**
 * snapshot.js — Capture a daily rollup of coverage state per DMA per retailer.
 *
 * Usage:
 *   node src/snapshot.js [--retailer amazon_same_day] [--date 2026-03-22]
 *
 * --retailer: if omitted, snapshots ALL retailers
 * --date:     defaults to today in America/Los_Angeles (YYYY-MM-DD)
 *
 * CRON: add to daily cron to track coverage growth over time:
 *   node src/snapshot.js
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');

function log(msg) {
  console.log(`[snapshot] ${new Date().toISOString()} ${msg}`);
}

function todayLA() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { retailer: null, date: todayLA() };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--retailer' && args[i + 1]) result.retailer = args[++i];
    if (args[i] === '--date' && args[i + 1]) result.date = args[++i];
  }
  return result;
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error('Database not found. Run npm run setup first.');
    process.exit(1);
  }

  const { retailer: retailerFilter, date: snapshotDate } = parseArgs();
  log(`Starting snapshot for date=${snapshotDate}${retailerFilter ? ` retailer=${retailerFilter}` : ' (all retailers)'}`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const retailers = retailerFilter
    ? db.prepare('SELECT * FROM retailers WHERE id = ?').all(retailerFilter)
    : db.prepare('SELECT * FROM retailers ORDER BY name').all();

  if (retailers.length === 0) {
    console.error(`No retailers found${retailerFilter ? ` matching "${retailerFilter}"` : ''}`);
    process.exit(1);
  }

  const insertDma = db.prepare(`
    INSERT OR REPLACE INTO snapshots
      (snapshot_date, retailer_id, dma_id, dma_name, tier, cities_total, cities_confirmed, cities_unavailable, signals_total, coverage_pct)
    SELECT
      ? as snapshot_date,
      ? as retailer_id,
      d.id as dma_id,
      d.name as dma_name,
      d.tier,
      COUNT(DISTINCT c.id) as cities_total,
      COUNT(DISTINCT CASE WHEN cc.available=1 THEN c.id END) as cities_confirmed,
      COUNT(DISTINCT CASE WHEN cc.available=0 THEN c.id END) as cities_unavailable,
      (SELECT COUNT(*) FROM signals s WHERE s.retailer_id=? AND s.dma_id=d.id) as signals_total,
      ROUND(100.0 * COUNT(DISTINCT CASE WHEN cc.available=1 THEN c.id END) / MAX(COUNT(DISTINCT c.id), 1), 1) as coverage_pct
    FROM dmas d
    LEFT JOIN cities c ON c.dma_id = d.id
    LEFT JOIN city_coverage cc ON cc.city=c.city AND cc.state=c.state AND cc.retailer_id=?
    GROUP BY d.id
  `);

  const insertTotals = db.prepare(`
    INSERT OR REPLACE INTO snapshot_totals
      (snapshot_date, retailer_id, total_cities_confirmed, total_cities_probed, total_signals, dmas_with_coverage)
    VALUES (
      ?,
      ?,
      (SELECT COUNT(*) FROM city_coverage WHERE retailer_id=? AND available=1),
      (SELECT COUNT(*) FROM city_coverage WHERE retailer_id=?),
      (SELECT COUNT(*) FROM signals WHERE retailer_id=?),
      (SELECT COUNT(DISTINCT dma_id) FROM city_coverage WHERE retailer_id=? AND available=1 AND dma_id IS NOT NULL)
    )
  `);

  const snapshotAll = db.transaction((retailer) => {
    insertDma.run(snapshotDate, retailer.id, retailer.id, retailer.id);
    insertTotals.run(snapshotDate, retailer.id, retailer.id, retailer.id, retailer.id, retailer.id);
  });

  for (const retailer of retailers) {
    snapshotAll(retailer);

    const dmaCount = db.prepare(
      'SELECT COUNT(*) as n FROM snapshots WHERE snapshot_date=? AND retailer_id=?'
    ).get(snapshotDate, retailer.id).n;

    const totals = db.prepare(
      'SELECT * FROM snapshot_totals WHERE snapshot_date=? AND retailer_id=?'
    ).get(snapshotDate, retailer.id);

    log(`${retailer.id} | date=${snapshotDate} | dma_rows=${dmaCount} | confirmed=${totals.total_cities_confirmed} | probed=${totals.total_cities_probed} | signals=${totals.total_signals} | dmas_with_coverage=${totals.dmas_with_coverage}`);
  }

  db.close();
  log('Snapshot complete.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
