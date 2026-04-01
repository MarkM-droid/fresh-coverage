/**
 * build_msa_zip_targets_v2.js
 * 
 * Strategy: for each MSA, pick 3 ZIPs from the primary city (first city in MSA name)
 * ordered by population descending — stays in the urban core.
 * Falls back to MSA-wide search if primary city has < 3 ZIPs.
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'data', 'coverage.db'));

const msas = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'us_msas.geojson'), 'utf8'));
const features = msas.features;

// Sort by population descending
const top200 = features
  .filter(f => f.properties.population > 0)
  .sort((a, b) => b.properties.population - a.properties.population)
  .slice(0, 200);

function primaryCity(msaName) {
  // 'New York-Newark-Jersey City, NY-NJ' -> 'New York'
  return msaName.split(',')[0].split('-')[0].trim();
}

function primaryState(msaName) {
  // Extract first state code after comma
  const m = msaName.match(/,\s*([A-Z]{2})/);
  return m ? m[1] : null;
}

const getZipsByCity = db.prepare(`
  SELECT zip, city, state, population 
  FROM zip_master 
  WHERE LOWER(city) = LOWER(?) AND state = ? AND population > 0
  ORDER BY population DESC 
  LIMIT 5
`);

const getZipsByState = db.prepare(`
  SELECT zip, city, state, population 
  FROM zip_master 
  WHERE state = ? AND population > 0
  ORDER BY population DESC 
  LIMIT 5
`);

const results = {};
let noZipCount = 0;

for (const f of top200) {
  const p = f.properties;
  const city = primaryCity(p.msa_name);
  const state = primaryState(p.msa_name);
  
  // Try primary city first
  let cityZips = state ? getZipsByCity.all(city, state) : [];
  
  // If fewer than 3, try alternate city spellings
  if (cityZips.length < 3 && city.includes(' ')) {
    // Try without spaces, or common abbreviations
    const alt = city.replace(/\./g, '');
    const altZips = state ? getZipsByCity.all(alt, state) : [];
    if (altZips.length > cityZips.length) cityZips = altZips;
  }
  
  // If still fewer than 3, fall back to state-wide top ZIPs
  if (cityZips.length < 2 && state) {
    const stateZips = getZipsByState.all(state);
    const stateOnly = stateZips.filter(z => !cityZips.find(c => c.zip === z.zip));
    cityZips = [...cityZips, ...stateOnly].slice(0, 3);
  }

  const zips = [...new Set(cityZips.map(z => z.zip))].slice(0, 3);
  
  if (zips.length === 0) {
    noZipCount++;
    console.log(`No ZIPs found for ${p.msa_name}`);
  }

  results[p.msa_id] = {
    msa_id: p.msa_id,
    msa_name: p.msa_name,
    msa_population: p.population,
    primary_city: city,
    primary_state: state,
    zips,
    zip_details: cityZips.slice(0,3).map(z => ({ zip: z.zip, city: z.city, state: z.state, pop: z.population }))
  };
}

writeFileSync(
  join(__dirname, '..', 'data', 'msa_zip_targets_v2.json'),
  JSON.stringify(results, null, 2)
);

console.log(`Built ${Object.keys(results).length} MSA targets`);
console.log(`No ZIP found: ${noZipCount}`);
console.log('\nSample (top 10 by population):');
Object.values(results).slice(0, 10).forEach(r => {
  console.log(`  ${r.msa_name.slice(0,45).padEnd(45)} -> ${r.primary_city} -> ${r.zips.join(', ')}`);
});

db.close();
