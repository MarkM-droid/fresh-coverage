import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'coverage.db');

function log(msg) {
  console.log(`[migrate_dma] ${new Date().toISOString()} ${msg}`);
}

function tier(tvHomes) {
  if (tvHomes >= 2_500_000) return 'mega';
  if (tvHomes >= 1_000_000) return 'large';
  if (tvHomes >=   400_000) return 'mid';
  if (tvHomes >=   100_000) return 'small';
  return 'micro';
}

// 2024-2025 Nielsen DMA rankings (rank, name, tv_homes)
const DMA_DATA = [
  [1,   'New York',                                         7494510],
  [2,   'Los Angeles',                                      5835790],
  [3,   'Chicago',                                          3654750],
  [4,   'Dallas-Fort Worth',                                3264490],
  [5,   'Philadelphia',                                     3145920],
  [6,   'Houston',                                          2797420],
  [7,   'Atlanta',                                          2758170],
  [8,   'Washington-Hagerstown',                            2630640],
  [9,   'Boston-Manchester',                                2584460],
  [10,  'San Francisco-Oakland-San Jose',                   2542480],
  [11,  'Tampa-St Petersburg-Sarasota',                     2221240],
  [12,  'Phoenix-Prescott',                                 2198200],
  [13,  'Seattle-Tacoma',                                   2098240],
  [14,  'Detroit',                                          1940750],
  [15,  'Orlando-Daytona Beach-Melbourne',                  1902420],
  [16,  'Minneapolis-Saint Paul',                           1886680],
  [17,  'Denver',                                           1806270],
  [18,  'Miami-Fort Lauderdale',                            1756920],
  [19,  'Cleveland-Akron-Canton',                           1554340],
  [20,  'Sacramento-Stockton-Modesto',                      1497920],
  [21,  'Charlotte',                                        1382020],
  [22,  'Raleigh-Durham-Fayetteville',                      1345840],
  [23,  'Portland OR',                                      1277920],
  [24,  'Saint Louis',                                      1273870],
  [25,  'Indianapolis',                                     1232210],
  [26,  'Nashville',                                        1199400],
  [27,  'Pittsburgh',                                       1167890],
  [28,  'Salt Lake City',                                   1163520],
  [29,  'Baltimore',                                        1155000],
  [30,  'San Diego',                                        1116150],
  [31,  'San Antonio',                                      1096400],
  [32,  'Hartford-New Haven',                               1060910],
  [33,  'Kansas City',                                      1033680],
  [34,  'Austin',                                           1029800],
  [35,  'Columbus OH',                                      1018390],
  [36,  'Greenville-Spartanburg-Asheville-Anderson',         987740],
  [37,  'Cincinnati',                                        958630],
  [38,  'Milwaukee',                                         944900],
  [39,  'West Palm Beach-Fort Pierce',                       936790],
  [40,  'Las Vegas',                                         896460],
  [41,  'Jacksonville',                                      840340],
  [42,  'Harrisburg-Lancaster-Lebanon-York',                 802360],
  [43,  'Grand Rapids-Kalamazoo-Battle Creek',               801030],
  [44,  'Norfolk-Portsmouth-Newport News',                   779970],
  [45,  'Birmingham-Anniston-Tuscaloosa',                    771860],
  [46,  'Greensboro-High Point-Winston Salem',               766980],
  [47,  'Oklahoma City',                                     762700],
  [48,  'Albuquerque-Santa Fe',                              708050],
  [49,  'Louisville',                                        702310],
  [50,  'New Orleans',                                       672790],
  [51,  'Memphis',                                           666300],
  [52,  'Providence-New Bedford',                            662810],
  [53,  'Fort Myers-Naples',                                 641850],
  [54,  'Buffalo',                                           637090],
  [55,  'Fresno-Visalia',                                    636260],
  [56,  'Richmond-Petersburg',                               625380],
  [57,  'Mobile-Pensacola-Fort Walton Beach',                605340],
  [58,  'Little Rock-Pine Bluff',                            590980],
  [59,  'Wilkes Barre-Scranton-Hazleton',                    589190],
  [60,  'Knoxville',                                         584100],
  [61,  'Tulsa',                                             575780],
  [62,  'Albany-Schenectady-Troy',                           575590],
  [63,  'Lexington',                                         517660],
  [64,  'Dayton',                                            498200],
  [65,  'Tucson-Sierra Vista',                               497660],
  [66,  'Spokane',                                           496260],
  [67,  'Des Moines-Ames',                                   480550],
  [68,  'Green Bay-Appleton',                                478970],
  [69,  'Honolulu',                                          470520],
  [70,  'Roanoke-Lynchburg',                                 460000],
  [71,  'Wichita-Hutchinson Plus',                           458990],
  [72,  'Flint-Saginaw-Bay City',                            458710],
  [73,  'Omaha',                                             458080],
  [74,  'Springfield MO',                                    454280],
  [75,  'Huntsville-Decatur-Florence',                       452230],
  [76,  'Columbia SC',                                       450440],
  [77,  'Madison',                                           443220],
  [78,  'Portland-Auburn',                                   439030],
  [79,  'Rochester NY',                                      435860],
  [80,  'Harlingen-Weslaco-Brownsville-McAllen',             428240],
  [81,  'Toledo',                                            424050],
  [82,  'Charleston-Huntington',                             422160],
  [83,  'Waco-Temple-Bryan',                                 419600],
  [84,  'Savannah',                                          400190],
  [85,  'Charleston SC',                                     399960],
  [86,  'Chattanooga',                                       391370],
  [87,  'Colorado Springs-Pueblo',                           388730],
  [88,  'Syracuse',                                          387030],
  [89,  'El Paso-Las Cruces',                                385080],
  [90,  'Paducah-Cape Girardeau-Harrisburg',                 378520],
  [91,  'Shreveport',                                        375030],
  [92,  'Champaign-Springfield-Decatur',                     371520],
  [93,  'Burlington-Plattsburgh',                            369840],
  [94,  'Cedar Rapids-Waterloo-Iowa City-Dubuque',           364130],
  [95,  'Baton Rouge',                                       355760],
  [96,  'Fort Smith-Fayetteville-Springdale-Rogers',         352410],
  [97,  'Myrtle Beach-Florence',                             347660],
  [98,  'Boise',                                             345250],
  [99,  'Jackson MS',                                        339170],
  [100, 'South Bend-Elkhart',                                331800],
  [101, 'Tri-Cities TN-VA',                                  331520],
  [102, 'Greenville-New Bern-Washington',                    319350],
  [103, 'Reno',                                              315350],
  [104, 'Davenport-Rock Island-Moline',                      313400],
  [105, 'Huntington-Charleston',                             310000],
  [106, 'Tallahassee-Thomasville',                           307500],
  [107, 'Monterey-Salinas',                                  305200],
  [108, 'Evansville',                                        298900],
  [109, 'Ft Wayne',                                          291400],
  [110, 'Columbus-Tupelo-West Point',                        289100],
  [111, 'Lansing',                                           286000],
  [112, 'Peoria-Bloomington',                                279700],
  [113, 'Augusta',                                           277300],
  [114, 'Youngstown',                                        275200],
  [115, 'Yakima-Pasco-Richland-Kennewick',                   270900],
  [116, 'Corpus Christi',                                    268700],
  [117, 'Amarillo',                                          264100],
  [118, 'Sioux Falls-Mitchell',                              261600],
  [119, 'Fargo-Valley City',                                 257100],
  [120, 'Eugene',                                            253100],
  [121, 'Macon',                                             250600],
  [122, 'Montgomery-Selma',                                  249200],
  [123, 'La Crosse-Eau Claire',                              244500],
  [124, 'Bakersfield',                                       243900],
  [125, 'Columbus GA',                                       241700],
  [126, 'Appleton-Oshkosh-Green Bay',                        240000],
  [127, 'Lincoln-Hastings-Kearney',                          237600],
  [128, 'Medford-Klamath Falls',                             234200],
  [129, 'Rockford',                                          229400],
  [130, 'Duluth-Superior',                                   227200],
  [131, 'Beaumont-Port Arthur',                              225500],
  [132, 'Minot-Bismarck-Dickinson',                          223900],
  [133, 'Wausau-Rhinelander',                                219900],
  [134, 'Chico-Redding',                                     218500],
  [135, 'Columbia-Jefferson City',                           217400],
  [136, 'Topeka',                                            215300],
  [137, 'Lubbock',                                           214400],
  [138, 'Wilmington',                                        213600],
  [139, 'Wichita Falls-Lawton',                              209600],
  [140, 'Traverse City-Cadillac',                            208900],
  [141, 'Sioux City',                                        207400],
  [142, 'Erie',                                              205700],
  [143, 'Jonesboro',                                         204200],
  [144, 'Odessa-Midland',                                    202100],
  [145, 'Binghamton',                                        201700],
  [146, 'Wheeling-Steubenville',                             198300],
  [147, 'Rocheser MN-Mason City-Austin',                     194700],
  [148, 'Bangor',                                            193400],
  [149, 'Gainesville',                                       191700],
  [150, 'Springfield-Holyoke',                               190500],
  [151, 'Tyler-Longview',                                    189400],
  [152, 'Hattiesburg-Laurel',                                186800],
  [153, 'Salisbury',                                         184700],
  [154, 'Utica',                                             181600],
  [155, 'Rapid City',                                        179200],
  [156, 'Palm Springs',                                      175700],
  [157, 'Florence-Myrtle Beach',                             174100],
  [158, 'Harlingen-Weslaco-Brownsville',                     173300],
  [159, 'Sherman-Ada',                                       169800],
  [160, 'Clarksburg-Weston',                                 168400],
  [161, 'Dothan',                                            166300],
  [162, 'Jackson TN',                                        163900],
  [163, 'Laredo',                                            162800],
  [164, 'Monroe-El Dorado',                                  159400],
  [165, 'Joplin-Pittsburg',                                  157700],
  [166, 'Abilene-Sweetwater',                                155400],
  [167, 'Lake Charles',                                      153800],
  [168, 'Waco',                                              152300],
  [169, 'Corpus Christi TX',                                 149200],
  [170, 'Anchorage',                                         146300],
  [171, 'Terre Haute',                                       142100],
  [172, 'Meridian',                                          139200],
  [173, 'Biloxi-Gulfport',                                   137400],
  [174, 'Quincy-Hannibal-Keokuk',                            136800],
  [175, 'Elmira-Corning',                                    134100],
  [176, 'Charlottesville',                                   131200],
  [177, 'Greenwood-Greenville',                              128800],
  [178, 'Harrisonburg',                                      125900],
  [179, 'Columbus-Starkville-West Point',                    123200],
  [180, 'Lima',                                              120600],
  [181, 'Monterey-Salinas CA',                               118300],
  [182, 'Chico CA',                                          116800],
  [183, 'Yuma-El Centro',                                    114900],
  [184, 'Gainesville FL',                                    112700],
  [185, 'Odessa TX',                                         110500],
  [186, 'Medford OR',                                        108700],
  [187, 'Ardmore-Ada',                                       107200],
  [188, 'San Angelo',                                        105100],
  [189, 'Marquette',                                         102800],
  [190, 'Bowling Green',                                     101200],
  [191, 'Grand Junction-Montrose',                            98700],
  [192, 'Laramie',                                            96400],
  [193, 'Twin Falls',                                         94200],
  [194, 'Ada-Ardmore OK',                                     91800],
  [195, 'Casper-Riverton',                                    89100],
  [196, 'Idaho Falls-Pocatello',                              87600],
  [197, 'Panama City',                                        85300],
  [198, 'Albany GA',                                          83600],
  [199, 'Clarksburg WV',                                      81200],
  [200, 'Saint Joseph MO',                                    45420],
  [201, 'Fairbanks',                                          37930],
  [202, 'Zanesville',                                         33940],
  [203, 'Victoria TX',                                        33500],
  [204, 'Helena',                                             32420],
  [205, 'Presque Isle',                                       28180],
  [206, 'Juneau',                                             26920],
  [207, 'Alpena',                                             17230],
  [208, 'North Platte',                                       14760],
  [209, 'Glendive',                                            3920],
];

const PROBE_STRATEGIES = [
  {
    tier: 'mega',
    methods: JSON.stringify(['news', 'plain_language', 'reddit', 'facebook', 'zip_grid']),
    queries_per_dma: 40,
    priority_mult: 10.0,
    notes: 'Top 10 DMAs - neighborhood-level granularity needed',
  },
  {
    tier: 'large',
    methods: JSON.stringify(['news', 'plain_language', 'reddit', 'zip_grid']),
    queries_per_dma: 15,
    priority_mult: 5.0,
    notes: 'Ranks 11-35 - city-level sweep + spot checks',
  },
  {
    tier: 'mid',
    methods: JSON.stringify(['news', 'plain_language']),
    queries_per_dma: 6,
    priority_mult: 2.0,
    notes: 'Ranks 36-80 - metro sweep, key suburbs',
  },
  {
    tier: 'small',
    methods: JSON.stringify(['news']),
    queries_per_dma: 2,
    priority_mult: 1.0,
    notes: 'Ranks 81-170 - single news query + 1 spot check',
  },
  {
    tier: 'micro',
    methods: JSON.stringify([]),
    queries_per_dma: 0,
    priority_mult: 0.0,
    notes: 'Ranks 171-210 - likely no coverage, skip',
  },
];

function runMigration(db) {
  log('Starting DDL migration in transaction...');

  db.transaction(() => {
    // ── dmas ──────────────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS dmas (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        tv_homes     INTEGER,
        tier         TEXT NOT NULL,
        centroid_lat REAL,
        centroid_lng REAL,
        notes        TEXT,
        created_at   INTEGER DEFAULT (unixepoch())
      );
    `);
    log('Table dmas: ready');

    // ── dma_counties ──────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS dma_counties (
        dma_id  INTEGER NOT NULL REFERENCES dmas(id),
        state   TEXT NOT NULL,
        county  TEXT NOT NULL,
        PRIMARY KEY (state, county)
      );
    `);
    log('Table dma_counties: ready');

    // ── dma_coverage ──────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS dma_coverage (
        retailer_id        TEXT    NOT NULL REFERENCES retailers(id),
        dma_id             INTEGER NOT NULL REFERENCES dmas(id),
        cities_total       INTEGER DEFAULT 0,
        cities_confirmed   INTEGER DEFAULT 0,
        cities_unavailable INTEGER DEFAULT 0,
        cities_unknown     INTEGER DEFAULT 0,
        coverage_pct       REAL    DEFAULT 0.0,
        confidence         INTEGER DEFAULT 0,
        last_updated       INTEGER DEFAULT (unixepoch()),
        notes              TEXT,
        PRIMARY KEY (retailer_id, dma_id)
      );
    `);
    log('Table dma_coverage: ready');

    // ── probe_strategies ─────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS probe_strategies (
        tier            TEXT PRIMARY KEY,
        methods         TEXT NOT NULL,
        queries_per_dma INTEGER NOT NULL,
        priority_mult   REAL DEFAULT 1.0,
        notes           TEXT
      );
    `);
    log('Table probe_strategies: ready');

    // ── probe_queue ───────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS probe_queue (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        retailer_id    TEXT    NOT NULL REFERENCES retailers(id),
        dma_id         INTEGER REFERENCES dmas(id),
        city           TEXT,
        state          TEXT,
        zip            TEXT,
        query          TEXT    NOT NULL,
        method         TEXT    NOT NULL,
        priority       INTEGER DEFAULT 0,
        status         TEXT    DEFAULT 'pending',
        created_at     INTEGER DEFAULT (unixepoch()),
        started_at     INTEGER,
        finished_at    INTEGER,
        run_id         INTEGER REFERENCES runs(id),
        result_summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_probe_queue_status ON probe_queue(status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_probe_queue_dma    ON probe_queue(dma_id);
    `);
    log('Table probe_queue + indexes: ready');

    // ── signals ───────────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        retailer_id   TEXT    NOT NULL REFERENCES retailers(id),
        dma_id        INTEGER REFERENCES dmas(id),
        city          TEXT,
        state         TEXT,
        zip           TEXT,
        signal_type   TEXT    NOT NULL,
        source        TEXT    NOT NULL,
        source_url    TEXT,
        snippet       TEXT,
        confidence    INTEGER DEFAULT 50,
        discovered_at INTEGER DEFAULT (unixepoch()),
        run_id        INTEGER REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_signals_retailer_dma  ON signals(retailer_id, dma_id);
      CREATE INDEX IF NOT EXISTS idx_signals_retailer_city ON signals(retailer_id, city, state);
      CREATE INDEX IF NOT EXISTS idx_signals_type          ON signals(signal_type);
    `);
    log('Table signals + indexes: ready');

    // ── seed dmas ─────────────────────────────────────────────────────────
    const insertDma = db.prepare(`
      INSERT OR IGNORE INTO dmas (id, name, tv_homes, tier)
      VALUES (@id, @name, @tv_homes, @tier)
    `);
    let seeded = 0;
    for (const [id, name, tv_homes] of DMA_DATA) {
      const result = insertDma.run({ id, name, tv_homes, tier: tier(tv_homes) });
      seeded += result.changes;
    }
    log(`dmas seeded: ${seeded} new rows (${DMA_DATA.length} total in dataset)`);

    // ── seed probe_strategies ─────────────────────────────────────────────
    const insertStrategy = db.prepare(`
      INSERT OR IGNORE INTO probe_strategies (tier, methods, queries_per_dma, priority_mult, notes)
      VALUES (@tier, @methods, @queries_per_dma, @priority_mult, @notes)
    `);
    let strategiesSeeded = 0;
    for (const s of PROBE_STRATEGIES) {
      const result = insertStrategy.run(s);
      strategiesSeeded += result.changes;
    }
    log(`probe_strategies seeded: ${strategiesSeeded} new rows`);
  })();

  log('Transaction committed.');
}

function alterTables(db) {
  log('Applying additive ALTER TABLE changes...');

  const alters = [
    { table: 'cities',        col: 'dma_id INTEGER REFERENCES dmas(id)' },
    { table: 'zip_master',    col: 'dma_id INTEGER REFERENCES dmas(id)' },
    { table: 'city_coverage', col: 'dma_id INTEGER' },
    { table: 'locations',     col: 'dma_id INTEGER REFERENCES dmas(id)' },
    { table: 'locations',     col: 'radius_miles INTEGER DEFAULT 50' },
  ];

  for (const { table, col } of alters) {
    const colName = col.split(' ')[0];
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      log(`  ALTER TABLE ${table} ADD COLUMN ${colName}: done`);
    } catch (e) {
      if (e.message.includes('duplicate column name') || e.message.includes('already exists')) {
        log(`  ALTER TABLE ${table} ADD COLUMN ${colName}: already exists, skipped`);
      } else {
        throw e;
      }
    }
  }

  log('Creating indexes on altered columns...');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cities_dma        ON cities(dma_id);
    CREATE INDEX IF NOT EXISTS idx_zip_master_dma    ON zip_master(dma_id);
    CREATE INDEX IF NOT EXISTS idx_city_coverage_dma ON city_coverage(dma_id);
    CREATE INDEX IF NOT EXISTS idx_locations_dma     ON locations(dma_id);
  `);
  log('Indexes created.');
}

function printRowCounts(db) {
  const tables = [
    'retailers', 'zip_master', 'zip_coverage', 'runs',
    'cities', 'city_coverage', 'locations',
    'dmas', 'dma_counties', 'dma_coverage',
    'probe_strategies', 'probe_queue', 'signals',
  ];

  log('─── Row counts ───────────────────────────────────────');
  for (const t of tables) {
    try {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
      log(`  ${t.padEnd(20)} ${n}`);
    } catch (e) {
      log(`  ${t.padEnd(20)} (error: ${e.message})`);
    }
  }
  log('──────────────────────────────────────────────────────');
}

function main() {
  log(`Opening database at ${DB_PATH}`);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigration(db);
  alterTables(db);
  printRowCounts(db);

  db.close();
  log('Migration complete.');
}

main();
