import Database from 'better-sqlite3';
import { createReadStream, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const DATA_DIR = join(PROJECT_ROOT, 'data');

const ZIP_DATA_URL =
  'https://raw.githubusercontent.com/scpike/us-state-county-zip/master/geo-data.csv';

function log(msg) {
  console.log(`[setup_db] ${new Date().toISOString()} ${msg}`);
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retailers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      website TEXT,
      notes TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS zip_master (
      zip TEXT PRIMARY KEY,
      city TEXT,
      state TEXT,
      county TEXT,
      lat REAL,
      lng REAL,
      population INTEGER,
      timezone TEXT
    );

    CREATE TABLE IF NOT EXISTS zip_coverage (
      retailer_id TEXT NOT NULL,
      zip TEXT NOT NULL,
      available INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER,
      last_confirmed INTEGER,
      last_checked INTEGER,
      source TEXT,
      source_url TEXT,
      confidence INTEGER DEFAULT 50,
      notes TEXT,
      PRIMARY KEY (retailer_id, zip),
      FOREIGN KEY (retailer_id) REFERENCES retailers(id),
      FOREIGN KEY (zip) REFERENCES zip_master(zip)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retailer_id TEXT NOT NULL,
      started_at INTEGER DEFAULT (unixepoch()),
      finished_at INTEGER,
      method TEXT,
      zips_checked INTEGER DEFAULT 0,
      zips_new INTEGER DEFAULT 0,
      zips_lost INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      notes TEXT
    );

    INSERT OR IGNORE INTO retailers (id, name, website) VALUES
      ('amazon_fresh', 'Amazon Fresh', 'https://www.amazon.com/fmc/learn-more/fresh'),
      ('kroger', 'Kroger', 'https://www.kroger.com');
  `);
  log('Schema created and retailers seeded.');
}

function parseCSVLine(line) {
  // Simple CSV parser (handles quoted fields)
  const result = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  result.push(field.trim());
  return result;
}

async function fetchAndSeedZips(db) {
  log(`Downloading zip data from ${ZIP_DATA_URL} ...`);
  const res = await fetch(ZIP_DATA_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch zip data: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const lines = text.split('\n');
  const header = parseCSVLine(lines[0]);
  log(`CSV header: ${header.join(', ')}`);

  // Expected columns: statecode, state, zipcode, county, city, timezone, dst
  // Indices may vary — detect dynamically
  const idx = {};
  const colMap = {
    zip: ['zipcode', 'zip'],
    city: ['city'],
    state: ['statecode', 'state_abbr', 'state'],
    county: ['county'],
    lat: ['lat', 'latitude'],
    lng: ['lng', 'lon', 'longitude'],
    population: ['population'],
    timezone: ['timezone'],
  };
  for (const [field, candidates] of Object.entries(colMap)) {
    for (const c of candidates) {
      const i = header.findIndex(h => h.toLowerCase() === c.toLowerCase());
      if (i !== -1) { idx[field] = i; break; }
    }
  }
  log(`Column mapping: ${JSON.stringify(idx)}`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO zip_master (zip, city, state, county, lat, lng, population, timezone)
    VALUES (@zip, @city, @state, @county, @lat, @lng, @population, @timezone)
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  let batch = [];
  let total = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const zip = idx.zip !== undefined ? cols[idx.zip] : null;
    if (!zip || !/^\d{5}$/.test(zip)) continue;

    batch.push({
      zip,
      city: idx.city !== undefined ? cols[idx.city] || null : null,
      state: idx.state !== undefined ? cols[idx.state] || null : null,
      county: idx.county !== undefined ? cols[idx.county] || null : null,
      lat: idx.lat !== undefined ? parseFloat(cols[idx.lat]) || null : null,
      lng: idx.lng !== undefined ? parseFloat(cols[idx.lng]) || null : null,
      population: idx.population !== undefined ? parseInt(cols[idx.population]) || null : null,
      timezone: idx.timezone !== undefined ? cols[idx.timezone] || null : null,
    });

    if (batch.length >= 1000) {
      insertMany(batch);
      total += batch.length;
      log(`  Inserted ${total} zips so far...`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    insertMany(batch);
    total += batch.length;
  }

  log(`Done. Seeded ${total} zip codes into zip_master.`);
  return total;
}

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  log(`Opening database at ${DB_PATH}`);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createSchema(db);

  const existingCount = db.prepare('SELECT COUNT(*) as n FROM zip_master').get().n;
  if (existingCount > 0) {
    log(`zip_master already has ${existingCount} rows — skipping seed. Use --reseed to force.`);
    if (!process.argv.includes('--reseed')) {
      db.close();
      return;
    }
    log('--reseed flag detected, re-seeding...');
    db.prepare('DELETE FROM zip_master').run();
  }

  await fetchAndSeedZips(db);
  db.close();
  log('Database setup complete.');
}

main().catch(err => {
  console.error('[setup_db] Fatal error:', err);
  process.exit(1);
});
