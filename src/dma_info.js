import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'coverage.db');

const db = new Database(DB_PATH, { readonly: true });

const arg = process.argv[2];

if (!arg) {
  // Print all 210 DMAs as a table
  const rows = db.prepare('SELECT id, name, tv_homes, tier FROM dmas ORDER BY id').all();
  const header = `${'Rank'.padStart(4)}  ${'Name'.padEnd(50)}  ${'TV Homes'.padStart(9)}  Tier`;
  const sep = '-'.repeat(header.length);
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    const tvStr = r.tv_homes != null ? r.tv_homes.toLocaleString() : 'N/A';
    console.log(
      `${String(r.id).padStart(4)}  ${r.name.padEnd(50)}  ${tvStr.padStart(9)}  ${r.tier}`
    );
  }
  console.log(sep);
  console.log(`${rows.length} DMAs total`);
} else if (/^\d+$/.test(arg)) {
  // Lookup by rank
  const rank = parseInt(arg, 10);
  const row = db.prepare('SELECT * FROM dmas WHERE id = ?').get(rank);
  if (!row) {
    console.error(`No DMA found with rank ${rank}`);
    process.exit(1);
  }
  printDetail(row);
} else {
  // Search by name substring
  const rows = db.prepare("SELECT * FROM dmas WHERE name LIKE ? ORDER BY id").all(`%${arg}%`);
  if (rows.length === 0) {
    console.error(`No DMAs matching "${arg}"`);
    process.exit(1);
  }
  if (rows.length === 1) {
    printDetail(rows[0]);
  } else {
    console.log(`${rows.length} DMAs matching "${arg}":\n`);
    for (const r of rows) printDetail(r);
  }
}

db.close();

function printDetail(r) {
  const tvStr = r.tv_homes != null ? r.tv_homes.toLocaleString() : 'N/A';
  console.log(`Rank:       ${r.id}`);
  console.log(`Name:       ${r.name}`);
  console.log(`TV Homes:   ${tvStr}`);
  console.log(`Tier:       ${r.tier}`);
  if (r.centroid_lat != null) console.log(`Centroid:   ${r.centroid_lat}, ${r.centroid_lng}`);
  if (r.notes)                console.log(`Notes:      ${r.notes}`);
  console.log(`Created:    ${new Date(r.created_at * 1000).toISOString()}`);
  console.log('');
}
