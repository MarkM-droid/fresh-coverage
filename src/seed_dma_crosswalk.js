import Database from 'better-sqlite3';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const TSV_PATH = join(PROJECT_ROOT, 'data', 'zip_dma_raw.tsv');
const TSV_URL =
  'https://gist.githubusercontent.com/clarkenheim/023882f8d77741f4d5347f80d95bc259/raw/Zip%20Codes%20to%20DMAs';

function log(msg) {
  console.log(`[seed_dma_crosswalk] ${new Date().toISOString()} ${msg}`);
}

// Known tricky mappings: Nielsen all-caps name → our dmas.name (mixed case)
const OVERRIDES = new Map([
  ['BOSTON (MANCHESTER)', 'Boston-Manchester'],
  ['WASHINGTON, DC (HAGRSTWN)', 'Washington-Hagerstown'],
  ['CLEVELAND - AKRON (CANTON)', 'Cleveland-Akron-Canton'],
  ['FT. WAYNE', 'Ft Wayne'],
  ['MIAMI - FT. LAUDERDALE', 'Miami-Fort Lauderdale'],
  ['PROVIDENCE - NEW BEDFORD', 'Providence-New Bedford'],
  ['BURLINGTON - PLATTSBURGH', 'Burlington-Plattsburgh'],
  ['COLUMBUS, GA', 'Columbus GA'],
  ['ALBANY, GA', 'Albany GA'],
  ['JACKSON, MS', 'Jackson MS'],
  ['SPRINGFIELD, MO', 'Springfield MO'],
  ['COLUMBIA, SC', 'Columbia SC'],
  ['CHARLESTON, SC', 'Charleston SC'],
  ['PORTLAND - AUBURN', 'Portland-Auburn'],
  ['COLUMBUS, OH', 'Columbus OH'],
  ['PORTLAND, OR', 'Portland OR'],
  ['ROCHESTER, MN - MASON CITY - AUSTIN', 'Rocheser MN-Mason City-Austin'],
  ['GREENSBORO - H. POINT - W. SALEM', 'Greensboro-High Point-Winston Salem'],
  ['WILKES BARRE - SCRANTON - HZTN', 'Wilkes Barre-Scranton-Hazleton'],
  ['WILKES BARRE - SCRANTON - HZTN.', 'Wilkes Barre-Scranton-Hazleton'],
  ['PADUCAH - CAPE GIRARD. - HARSBG', 'Paducah-Cape Girardeau-Harrisburg'],
  ['NORFOLK - PORTSMTH - NEWPT NWS', 'Norfolk-Portsmouth-Newport News'],
  ['BIRMINGHAM (ANN AND TUSC)', 'Birmingham-Anniston-Tuscaloosa'],
  ['HARLINGEN - WSLCO - BRNSVL-MC', 'Harlingen-Weslaco-Brownsville-McAllen'],
  ['GREENVILLE - SPART - ASHEVLL - AND', 'Greenville-Spartanburg-Asheville-Anderson'],
  ['CHRLSTN-HUNTGTN', 'Charleston-Huntington'],
  ['HUNTSVILLE-DECATUR-FLOR', 'Huntsville-Decatur-Florence'],
  ['RALEIGH - DURHAM (FAYETTEVILLE)', 'Raleigh-Durham-Fayetteville'],
  ['MINOT-BISMARCK-DICKINSON(WILLISTON)', 'Minot-Bismarck-Dickinson'],
  ['GRAND RAPIDS - KALMZOO - B.CRK', 'Grand Rapids-Kalamazoo-Battle Creek'],
  ['FT. SMITH-FAY-SPRNGDL-RGRS', 'Fort Smith-Fayetteville-Springdale-Rogers'],
  ['FORT SMITH - FAYETTVL - SPRNGDL', 'Fort Smith-Fayetteville-Springdale-Rogers'],
  ['WACO - TEMPLE - BRYAN', 'Waco-Temple-Bryan'],
  ['SAN FRANCISCO - OAKLAND - SAN JOSE', 'San Francisco-Oakland-San Jose'],
  ['SACRAMENTO - STOCKTON - MODESTO', 'Sacramento-Stockton-Modesto'],
  ['CHARLOTTE', 'Charlotte'],
  ['TUCSON (SIERRA VISTA)', 'Tucson-Sierra Vista'],
  ['CEDAR RAPIDS-WTRLO-IWC-DBQUE', 'Cedar Rapids-Waterloo-Iowa City-Dubuque'],
  ['WICHITA - HUTCHINSON PLUS', 'Wichita-Hutchinson Plus'],
  ['GREENVILLE - N. BERN - WASHNGTN', 'Greenville-New Bern-Washington'],
  ['DAVENPORT - R. ISLAND - MOLINE', 'Davenport-Rock Island-Moline'],
  ['COLUMBUS - TUPELO - WEST POINT', 'Columbus-Tupelo-West Point'],
  ['COLUMBUS-STARKVILLE-WEST POINT', 'Columbus-Starkville-West Point'],
  ['LA CROSSE - EAU CLAIRE', 'La Crosse-Eau Claire'],
  ['WAUSAU - RHINELANDER', 'Wausau-Rhinelander'],
  ['COLUMBIA - JEFFERSON CITY', 'Columbia-Jefferson City'],
  ['COLUMBIA - JEFF. CITY', 'Columbia-Jefferson City'],
  ['TRAVERSE CITY - CADILLAC', 'Traverse City-Cadillac'],
  ['ALBANY - SCHENECTADY - TROY', 'Albany-Schenectady-Troy'],
  ['SIOUX FALLS (MITCHELL)', 'Sioux Falls-Mitchell'],
  ['FARGO - VALLEY CITY', 'Fargo-Valley City'],
  ['MEDFORD - KLAMATH FALLS', 'Medford-Klamath Falls'],
  ['CHICO - REDDING', 'Chico-Redding'],
  ['IDAHO FALLS - POCATELLO', 'Idaho Falls-Pocatello'],
  ['EL PASO (LAS CRUCES)', 'El Paso-Las Cruces'],
  ['YAKIMA - PASCO - RCHLND - KNNWCK', 'Yakima-Pasco-Richland-Kennewick'],
  ['COLORADO SPRINGS - PUEBLO', 'Colorado Springs-Pueblo'],
  ['PANAMA CITY', 'Panama City'],
  ['CASPER - RIVERTON', 'Casper-Riverton'],
  ['TWIN FALLS', 'Twin Falls'],
  ['RAPID CITY', 'Rapid City'],
  ['PALM SPRINGS', 'Palm Springs'],
  ['SHERMAN - ADA', 'Sherman-Ada'],
  ['CLARKSBURG - WESTON', 'Clarksburg-Weston'],
  ['ODESSA - MIDLAND', 'Odessa-Midland'],
  ['WICHITA FALLS & LAWTON', 'Wichita Falls-Lawton'],
  ['WHEELING - STEUBENVILLE', 'Wheeling-Steubenville'],
  ['MONROE - EL DORADO', 'Monroe-El Dorado'],
  ['JOPLIN - PITTSBURG', 'Joplin-Pittsburg'],
  ['ABILENE - SWEETWATER', 'Abilene-Sweetwater'],
  ['LAKE CHARLES', 'Lake Charles'],
  ['HARRISONBURG', 'Harrisonburg'],
  ['QUINCY - HANNIBAL - KEOKUK', 'Quincy-Hannibal-Keokuk'],
  ['ELMIRA (CORNING)', 'Elmira-Corning'],
  ['CHARLOTTESVILLE', 'Charlottesville'],
  ['LIMA', 'Lima'],
  ['SAN ANGELO', 'San Angelo'],
  ['MARQUETTE', 'Marquette'],
  ['BOWLING GREEN', 'Bowling Green'],
  ['GRAND JUNCTION - MONTROSE', 'Grand Junction-Montrose'],
  ['LARAMIE', 'Laramie'],
  ['ADA - ARDMORE', 'Ada-Ardmore OK'],
  ['PRESQUE ISLE', 'Presque Isle'],
  ['NORTH PLATTE', 'North Platte'],
  ['GLENDIVE', 'Glendive'],
  ['ALPENA', 'Alpena'],
  ['VICTORIA', 'Victoria TX'],
  ['HELENA', 'Helena'],
  ['JUNEAU', 'Juneau'],
  ['FAIRBANKS', 'Fairbanks'],
  ['SAINT JOSEPH', 'Saint Joseph MO'],
  ['ZANESVILLE', 'Zanesville'],
  ['GREENWOOD - GREENVILLE', 'Greenwood-Greenville'],
  ['MERIDIAN', 'Meridian'],
  ['HATTIESBURG - LAUREL', 'Hattiesburg-Laurel'],
  ['BILOXI - GULFPORT', 'Biloxi-Gulfport'],
  ['TERRE HAUTE', 'Terre Haute'],
  ['SALISBURY', 'Salisbury'],
  ['JACKSON, TN', 'Jackson TN'],
  ['LAREDO', 'Laredo'],
  ['DOTHAN', 'Dothan'],
  ['ARDMORE - ADA', 'Ardmore-Ada'],
  ['FLORENCE - MYRTLE BEACH', 'Florence-Myrtle Beach'],
  ['FT. MYERS - NAPLES', 'Fort Myers-Naples'],
  ['TALLAHASSEE - THOMASVILLE', 'Tallahassee-Thomasville'],
  ['MONTGOMERY (SELMA)', 'Montgomery-Selma'],
  ['ROANOKE - LYNCHBURG', 'Roanoke-Lynchburg'],
  ['MYRTLE BEACH - FLORENCE', 'Myrtle Beach-Florence'],
  ['AUGUSTA', 'Augusta'],
  ['EVANSVILLE', 'Evansville'],
  ['LANSING', 'Lansing'],
  ['ROCKFORD', 'Rockford'],
  ['DULUTH - SUPERIOR', 'Duluth-Superior'],
  ['BEAUMONT - PORT ARTHUR', 'Beaumont-Port Arthur'],
  ['RICHMOND - PETERSBG', 'Richmond-Petersburg'],
  ['MOBILE - PENSACOLA (FT. WALT.)', 'Mobile-Pensacola-Fort Walton Beach'],
  ['LITTLE ROCK - PINE BLUFF', 'Little Rock-Pine Bluff'],
  ['TYLER - LONGVIEW(LFKN&NCGDCHE)', 'Tyler-Longview'],
  ['SPRINGFIELD - HOLYOKE', 'Springfield-Holyoke'],
  ['UTICA', 'Utica'],
  ['SIOUX CITY', 'Sioux City'],
  ['BINGHAMTON', 'Binghamton'],
  ['ERIE', 'Erie'],
  ['JONESBORO', 'Jonesboro'],
  ['BANGOR', 'Bangor'],
  ['GAINESVILLE', 'Gainesville'],
  ['PEORIA - BLOOMINGTON', 'Peoria-Bloomington'],
  ['YOUNGSTOWN', 'Youngstown'],
  ['ANCHORAGE', 'Anchorage'],
  ['YUMA - EL CENTRO', 'Yuma-El Centro'],
  ['LUBBOCK', 'Lubbock'],
  ['TOPEKA', 'Topeka'],
  ['AMARILLO', 'Amarillo'],
  ['CORPUS CHRISTI', 'Corpus Christi'],
  ['HONOLULU', 'Honolulu'],
  ['EUGENE', 'Eugene'],
  ['BAKERSFIELD', 'Bakersfield'],
  ['RENO', 'Reno'],
  ['SPOKANE', 'Spokane'],
  ['BOISE', 'Boise'],
  ['ROCHESTER, NY', 'Rochester NY'],
  ['WACO', 'Waco'],
  ['LEXINGTON', 'Lexington'],
  ['DAYTON', 'Dayton'],
  ['SYRACUSE', 'Syracuse'],
  ['KNOXVILLE', 'Knoxville'],
  ['TULSA', 'Tulsa'],
  ['SHREVEPORT', 'Shreveport'],
  ['MEMPHIS', 'Memphis'],
  ['TOLEDO', 'Toledo'],
  ['BUFFALO', 'Buffalo'],
  ['MADISON', 'Madison'],
  ['OMAHA', 'Omaha'],
  ['DES MOINES - AMES', 'Des Moines-Ames'],
  ['GREEN BAY - APPLETON', 'Green Bay-Appleton'],
  ['NASHVILLE', 'Nashville'],
  ['BALTIMORE', 'Baltimore'],
  ['SAN DIEGO', 'San Diego'],
  ['LAS VEGAS', 'Las Vegas'],
  ['PITTSBURGH', 'Pittsburgh'],
  ['SALT LAKE CITY', 'Salt Lake City'],
  ['NEW ORLEANS', 'New Orleans'],
  ['MILWAUKEE', 'Milwaukee'],
  ['AUSTIN', 'Austin'],
  ['DETROIT', 'Detroit'],
  ['DENVER', 'Denver'],
  ['ATLANTA', 'Atlanta'],
  ['HOUSTON', 'Houston'],
  ['CHICAGO', 'Chicago'],
  ['NEW YORK', 'New York'],
  ['LOS ANGELES', 'Los Angeles'],
  ['PHILADELPHIA', 'Philadelphia'],
  ['DALLAS - FT. WORTH', 'Dallas-Fort Worth'],
  ['MINNEAPOLIS - ST. PAUL', 'Minneapolis-Saint Paul'],
  ['SEATTLE - TACOMA', 'Seattle-Tacoma'],
  ['INDIANAPOLIS', 'Indianapolis'],
  ['HARTFORD & NEW HAVEN', 'Hartford-New Haven'],
  ['KANSAS CITY', 'Kansas City'],
  ['ST. LOUIS', 'Saint Louis'],
  ['SAN ANTONIO', 'San Antonio'],
  ['JACKSONVILLE', 'Jacksonville'],
  ['OKLAHOMA CITY', 'Oklahoma City'],
  ['ALBUQUERQUE - SANTA FE', 'Albuquerque-Santa Fe'],
  ['LOUISVILLE', 'Louisville'],
  ['CINCINNATI', 'Cincinnati'],
  ['WEST PALM BEACH - FT. PIERCE', 'West Palm Beach-Fort Pierce'],
  ['FRESNO - VISALIA', 'Fresno-Visalia'],
  ['ORLANDO - DAYTONA BCH - MELBRN', 'Orlando-Daytona Beach-Melbourne'],
  ['TAMPA - ST. PETE (SARASOTA)', 'Tampa-St Petersburg-Sarasota'],
  ['HARRISBURG - LNCSTR - LEB - YORK', 'Harrisburg-Lancaster-Lebanon-York'],
  ['CHATTANOOGA', 'Chattanooga'],
  ['LINCOLN & HASTINGS - KEARNEY', 'Lincoln-Hastings-Kearney'],
  ['FLINT - SAGINAW - BAY CITY', 'Flint-Saginaw-Bay City'],
  ['SOUTH BEND - ELKHART', 'South Bend-Elkhart'],
  ['TRI - CITIES, TN - VA', 'Tri-Cities TN-VA'],
  ['BATON ROUGE', 'Baton Rouge'],
  ['HUNTINGTON - CHARLESTON', 'Huntington-Charleston'],
  ['CHAMPAIGN & SPRNGFLD - DECATUR', 'Champaign-Springfield-Decatur'],
  // Alternate abbreviation forms seen in TSV
  ['BIRMINGHAM (ANN & TUSC)', 'Birmingham-Anniston-Tuscaloosa'],
  ['CEDAR RAPIDS - WTRLO - IWC&DUB', 'Cedar Rapids-Waterloo-Iowa City-Dubuque'],
  ['FT. SMITH - FAY - SPRNGDL - RGRS', 'Fort Smith-Fayetteville-Springdale-Rogers'],
  ['GRAND RAPIDS - KALMZOO - B. CRK', 'Grand Rapids-Kalamazoo-Battle Creek'],
  ['GREENVLL - SPART - ASHEVLL - AND', 'Greenville-Spartanburg-Asheville-Anderson'],
  ['HARLINGEN - WSLCO - BRNSVL - MCA', 'Harlingen-Weslaco-Brownsville-McAllen'],
  ['LINCOLN & HSTNGS - KRNY', 'Lincoln-Hastings-Kearney'],
  ['MOBILE - PENSACOLA (FT WALT)', 'Mobile-Pensacola-Fort Walton Beach'],
  ['PADUCAH - CAPE GIRAR D - HARSBG', 'Paducah-Cape Girardeau-Harrisburg'],
  ['RALEIGH - DURHAM (FAYETVLLE)', 'Raleigh-Durham-Fayetteville'],
  ['SACRAMNTO - STKTN - MODESTO', 'Sacramento-Stockton-Modesto'],
  ['SAN FRANCISCO - OAK - SAN JOSE', 'San Francisco-Oakland-San Jose'],
  ['ST. JOSEPH', 'Saint Joseph MO'],
]);

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[-–]/g, ' ')
    .replace(/[.,()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNameMap(db) {
  const dmas = db.prepare('SELECT id, name FROM dmas').all();
  // normalized → id
  const normMap = new Map();
  for (const { id, name } of dmas) {
    normMap.set(normalize(name), id);
  }
  return { dmas, normMap };
}

function resolveDmaId(tsvName, dmas, normMap, nameCache) {
  if (nameCache.has(tsvName)) return nameCache.get(tsvName);

  // 1. Hardcoded override
  if (OVERRIDES.has(tsvName)) {
    const target = OVERRIDES.get(tsvName);
    const match = dmas.find(d => d.name === target);
    if (match) {
      nameCache.set(tsvName, match.id);
      return match.id;
    }
    log(`WARN: override target "${target}" not found in dmas table for "${tsvName}"`);
  }

  const normInput = normalize(tsvName);

  // 2. Exact normalized match
  if (normMap.has(normInput)) {
    const id = normMap.get(normInput);
    nameCache.set(tsvName, id);
    return id;
  }

  // 3. Substring match (both directions)
  for (const [normName, id] of normMap) {
    if (normName.includes(normInput) || normInput.includes(normName)) {
      nameCache.set(tsvName, id);
      return id;
    }
  }

  nameCache.set(tsvName, null);
  return null;
}

async function downloadTsv() {
  if (existsSync(TSV_PATH)) {
    const lines = readFileSync(TSV_PATH, 'utf8').split('\n').length;
    if (lines > 40000) {
      log(`TSV already exists with ${lines} lines — skipping download.`);
      return readFileSync(TSV_PATH, 'utf8');
    }
  }
  log(`Downloading TSV from ${TSV_URL} ...`);
  const res = await fetch(TSV_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(TSV_PATH, text, 'utf8');
  log(`Saved to ${TSV_PATH} (${text.split('\n').length} lines)`);
  return text;
}

function parseTsv(text) {
  const lines = text.split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const zip = parts[0].trim().padStart(5, '0');
    const dmaDesc = parts[2].trim();
    if (zip && dmaDesc) rows.push({ zip, dmaDesc });
  }
  return rows;
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Step 1: Build name map
  log('Building DMA name map...');
  const { dmas, normMap } = buildNameMap(db);
  log(`Loaded ${dmas.length} DMAs from database.`);

  const nameCache = new Map();

  // Step 2: Download TSV
  const tsvText = await downloadTsv();
  const rows = parseTsv(tsvText);
  log(`Parsed ${rows.length} zip→DMA rows from TSV.`);

  // Build zip→dma_id map and collect unmatched DMA names
  const zipToDmaId = new Map();
  const unmatchedNames = new Set();

  for (const { zip, dmaDesc } of rows) {
    const dmaId = resolveDmaId(dmaDesc, dmas, normMap, nameCache);
    if (dmaId !== null) {
      zipToDmaId.set(zip, dmaId);
    } else {
      unmatchedNames.add(dmaDesc);
    }
  }

  log(`Resolved ${zipToDmaId.size} zip→dma_id mappings. Unmatched DMA names: ${unmatchedNames.size}`);

  // Step 3: Update zip_master
  log('Updating zip_master.dma_id...');
  const updateZip = db.prepare('UPDATE zip_master SET dma_id = ? WHERE zip = ?');
  let zipUpdated = 0;
  let zipNoMatch = 0;

  const updateZipsBatch = db.transaction(() => {
    for (const [zip, dmaId] of zipToDmaId) {
      const result = updateZip.run(dmaId, zip);
      if (result.changes > 0) {
        zipUpdated++;
      } else {
        zipNoMatch++;
      }
    }
  });
  updateZipsBatch();
  log(`zip_master: ${zipUpdated} updated, ${zipNoMatch} zips not in our zip_master.`);

  // Step 4: Update cities.dma_id
  log('Updating cities.dma_id via most common zip DMA...');
  const citiesResult = db.prepare(`
    UPDATE cities SET dma_id = (
      SELECT dma_id FROM zip_master
      WHERE zip_master.city = cities.city
        AND zip_master.state = cities.state
        AND dma_id IS NOT NULL
      GROUP BY dma_id ORDER BY COUNT(*) DESC LIMIT 1
    )
    WHERE dma_id IS NULL
  `).run();
  log(`cities: ${citiesResult.changes} rows updated.`);

  // Step 5: Update city_coverage.dma_id
  log('Updating city_coverage.dma_id from cities...');
  const ccResult = db.prepare(`
    UPDATE city_coverage SET dma_id = (
      SELECT dma_id FROM cities
      WHERE cities.city = city_coverage.city
        AND cities.state = city_coverage.state
    )
    WHERE dma_id IS NULL
  `).run();
  log(`city_coverage: ${ccResult.changes} rows updated.`);

  // Step 6: Summary
  const zipStats = db.prepare(`
    SELECT
      SUM(CASE WHEN dma_id IS NOT NULL THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN dma_id IS NULL THEN 1 ELSE 0 END) as missing
    FROM zip_master
  `).get();

  const cityStats = db.prepare(`
    SELECT
      SUM(CASE WHEN dma_id IS NOT NULL THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN dma_id IS NULL THEN 1 ELSE 0 END) as missing
    FROM cities
  `).get();

  const ccStats = db.prepare(`
    SELECT
      SUM(CASE WHEN dma_id IS NOT NULL THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN dma_id IS NULL THEN 1 ELSE 0 END) as missing
    FROM city_coverage
  `).get();

  const top10 = db.prepare(`
    SELECT d.name, COUNT(*) as zip_count
    FROM zip_master z
    JOIN dmas d ON d.id = z.dma_id
    GROUP BY z.dma_id
    ORDER BY zip_count DESC
    LIMIT 10
  `).all();

  console.log('\n=== SUMMARY ===');
  console.log(`zip_master:    ${zipStats.assigned} assigned, ${zipStats.missing} NULL`);
  console.log(`cities:        ${cityStats.assigned} assigned, ${cityStats.missing} NULL`);
  console.log(`city_coverage: ${ccStats.assigned} assigned, ${ccStats.missing} NULL`);

  console.log('\nTop 10 DMAs by zip count:');
  for (const row of top10) {
    console.log(`  ${String(row.zip_count).padStart(5)}  ${row.name}`);
  }

  if (unmatchedNames.size > 0) {
    console.log(`\nUnmatched DMA names from TSV (${unmatchedNames.size}):`);
    for (const name of [...unmatchedNames].sort()) {
      console.log(`  - ${name}`);
    }
  } else {
    console.log('\nAll DMA names from TSV matched successfully.');
  }

  db.close();
  log('Done.');
}

main().catch(err => {
  console.error('[seed_dma_crosswalk] Fatal:', err);
  process.exit(1);
});
