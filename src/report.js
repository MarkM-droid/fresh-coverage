/**
 * report.js — Generate reports/index.html with Leaflet map + data table
 *
 * Uses Leaflet.js (free, OpenStreetMap tiles, no API key needed).
 * Zip code centroids are derived from zip_master lat/lng when available,
 * or approximated from a built-in state centroid table.
 *
 * Usage:
 *   node src/report.js
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const REPORTS_DIR = join(PROJECT_ROOT, 'reports');

// State centroids fallback (lat, lng) for zips without coordinates
const STATE_CENTROIDS = {
  AL:[32.8,-86.8],AK:[64.2,-153.4],AZ:[34.3,-111.1],AR:[34.8,-92.2],CA:[36.8,-119.4],
  CO:[39.0,-105.5],CT:[41.6,-72.7],DE:[39.0,-75.5],DC:[38.9,-77.0],FL:[27.8,-81.6],
  GA:[32.7,-83.4],HI:[20.3,-156.4],ID:[44.4,-114.6],IL:[40.0,-89.2],IN:[39.9,-86.3],
  IA:[42.1,-93.5],KS:[38.5,-98.4],KY:[37.5,-85.3],LA:[31.2,-91.8],ME:[45.4,-69.2],
  MD:[39.1,-76.8],MA:[42.2,-71.5],MI:[44.3,-85.6],MN:[46.4,-93.1],MS:[32.7,-89.7],
  MO:[38.5,-92.5],MT:[47.0,-110.0],NE:[41.5,-99.9],NV:[38.5,-117.0],NH:[44.0,-71.6],
  NJ:[40.1,-74.7],NM:[34.5,-106.1],NY:[42.9,-75.5],NC:[35.6,-79.8],ND:[47.5,-100.5],
  OH:[40.4,-82.8],OK:[35.6,-96.9],OR:[44.1,-120.5],PA:[40.9,-77.8],RI:[41.7,-71.5],
  SC:[33.8,-80.9],SD:[44.4,-100.2],TN:[35.9,-86.7],TX:[31.5,-99.3],UT:[39.3,-111.1],
  VT:[44.1,-72.7],VA:[37.8,-78.2],WA:[47.4,-120.5],WV:[38.6,-80.6],WI:[44.3,-89.6],WY:[43.0,-107.6]
};

// State abbreviation → 2-digit FIPS (for county→DMA choropleth mapping)
const STATE_FIPS = {
  AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',DC:'11',FL:'12',
  GA:'13',HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',
  MD:'24',MA:'25',MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',
  NJ:'34',NM:'35',NY:'36',NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',
  SC:'45',SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56'
};

function log(msg) {
  console.log(`[report] ${new Date().toISOString()} ${msg}`);
}

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt(unixTs) {
  if (!unixTs) return '—';
  return new Date(unixTs * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function availLabel(a) {
  if (a === 1) return 'Available';
  if (a === 0) return 'Not Available';
  return 'Unknown';
}

function computeTimeline(db, retailers) {
  const byDate = db.prepare(`
    SELECT snapshot_date, retailer_id, total_cities_confirmed, total_cities_probed,
           total_signals, dmas_with_coverage
    FROM snapshot_totals
    ORDER BY snapshot_date ASC, retailer_id ASC
  `).all();

  const byDmaFirstSeen = {};
  for (const r of retailers) {
    byDmaFirstSeen[r.id] = db.prepare(`
      SELECT d.id as dma_id, d.name as dma_name, d.tier,
        MIN(s.snapshot_date) as first_confirmed_date
      FROM snapshots s
      JOIN dmas d ON d.id = s.dma_id
      WHERE s.retailer_id = ? AND s.cities_confirmed > 0
      GROUP BY s.dma_id
      ORDER BY first_confirmed_date ASC
    `).all(r.id);
  }

  return { byDate, byDmaFirstSeen };
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error('Database not found. Run npm run setup first.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const retailers = db.prepare('SELECT * FROM retailers ORDER BY name').all();

  // Summary stats per retailer
  const summaries = {};
  for (const r of retailers) {
    summaries[r.id] = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE zc.available = 1) AS covered,
        COUNT(DISTINCT zm.state) FILTER (WHERE zc.available = 1) AS states,
        MAX(zc.last_checked) AS last_checked
      FROM zip_coverage zc
      JOIN zip_master zm ON zm.zip = zc.zip
      WHERE zc.retailer_id = ?
    `).get(r.id);
  }

  // Coverage rows with coordinates
  const coverageRows = db.prepare(`
    SELECT
      zc.zip, zm.city, zm.state, zm.lat, zm.lng,
      zc.retailer_id, r.name AS retailer_name,
      zc.available, zc.confidence, zc.source, zc.source_url,
      zc.first_seen, zc.last_checked
    FROM zip_coverage zc
    JOIN zip_master zm ON zm.zip = zc.zip
    JOIN retailers r ON r.id = zc.retailer_id
    ORDER BY zm.state, zm.city, zc.zip
  `).all();

  // Locations (store/warehouse addresses)
  const locations = (() => {
    try {
      return db.prepare(`
        SELECT l.*, r.name AS retailer_name
        FROM locations l
        JOIN retailers r ON r.id = l.retailer_id
        ORDER BY l.retailer_id, l.state, l.city
      `).all();
    } catch { return []; }
  })();

  // New this week
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 86400 * 7;
  const newThisWeek = db.prepare(`
    SELECT zc.zip, zm.city, zm.state, zc.retailer_id, r.name AS retailer_name, zc.first_seen
    FROM zip_coverage zc
    JOIN zip_master zm ON zm.zip = zc.zip
    JOIN retailers r ON r.id = zc.retailer_id
    WHERE zc.available = 1 AND zc.first_seen >= ?
    ORDER BY zc.first_seen DESC LIMIT 100
  `).all(oneWeekAgo);

  // DMA coverage per retailer
  const dmaDataByRetailer = {};
  const topCitiesStmt = db.prepare(`
    SELECT c.city, c.state FROM cities c
    JOIN city_coverage cc ON cc.city=c.city AND cc.state=c.state AND cc.retailer_id=? AND cc.available=1
    WHERE c.dma_id=?
    LIMIT 5
  `);
  for (const r of retailers) {
    const rows = db.prepare(`
      SELECT
        d.id as dma_id, d.name as dma_name, d.tier, d.tv_homes,
        COUNT(DISTINCT c.id) as cities_total,
        COUNT(DISTINCT CASE WHEN cc.available=1 THEN c.id END) as cities_confirmed,
        COUNT(DISTINCT CASE WHEN cc.available=0 THEN c.id END) as cities_unavailable,
        COUNT(DISTINCT CASE WHEN cc.available IS NOT NULL THEN c.id END) as cities_probed
      FROM dmas d
      LEFT JOIN cities c ON c.dma_id = d.id
      LEFT JOIN city_coverage cc ON cc.city=c.city AND cc.state=c.state AND cc.retailer_id=?
      GROUP BY d.id
      ORDER BY d.id ASC
    `).all(r.id);
    dmaDataByRetailer[r.id] = rows.map(row => ({
      ...row,
      coverage_pct: row.cities_total > 0 ? (row.cities_confirmed / row.cities_total * 100) : 0,
      top_cities: topCitiesStmt.all(r.id, row.dma_id).map(c => c.city + ', ' + c.state)
    }));
  }

  // ZIP → DMA lookup for embedding in report
  const zipToDma = {};
  db.prepare('SELECT zip, dma_id FROM zip_master WHERE dma_id IS NOT NULL').all()
    .forEach(r => { zipToDma[r.zip] = r.dma_id; });

  // County → DMA mapping (majority-vote per state+county) for choropleth
  const countyDmaVotes = {};
  db.prepare(`
    SELECT state, county, dma_id, COUNT(*) as cnt
    FROM zip_master
    WHERE dma_id IS NOT NULL AND county IS NOT NULL AND county != ''
    GROUP BY state, county, dma_id
  `).all().forEach(row => {
    const fips = STATE_FIPS[row.state];
    if (!fips) return;
    const key = fips + '|' + row.county.toLowerCase().trim();
    if (!countyDmaVotes[key] || countyDmaVotes[key].cnt < row.cnt) {
      countyDmaVotes[key] = { dma_id: row.dma_id, cnt: row.cnt };
    }
  });
  const countyToDma = {};
  Object.entries(countyDmaVotes).forEach(([k, v]) => { countyToDma[k] = v.dma_id; });

  const timeline = computeTimeline(db, retailers);

  db.close();

  const generatedAt = new Date().toLocaleString('en-US', {
    month:'short', day:'numeric', year:'numeric',
    hour:'2-digit', minute:'2-digit', timeZoneName:'short'
  });

  // Build GeoJSON features for map
  const retailerColors = {};
  const palette = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];
  retailers.forEach((r, i) => { retailerColors[r.id] = palette[i % palette.length]; });

  // Available zip points grouped by retailer
  const mapPoints = coverageRows
    .filter(r => r.available === 1)
    .map(r => {
      let lat = r.lat, lng = r.lng;
      if (!lat || !lng) {
        const c = STATE_CENTROIDS[r.state];
        if (c) { lat = c[0] + (Math.random() - 0.5) * 0.5; lng = c[1] + (Math.random() - 0.5) * 0.5; }
      }
      if (!lat || !lng) return null;
      return { lat, lng, zip: r.zip, city: r.city, state: r.state,
               retailer_id: r.retailer_id, retailer_name: r.retailer_name,
               confidence: r.confidence, first_seen: r.first_seen };
    }).filter(Boolean);

  const locPoints = locations.map(l => {
    // Try to extract lat/lng from zip if available
    return { lat: l.lat, lng: l.lng, address: l.address_raw,
             retailer_id: l.retailer_id, retailer_name: l.retailer_name, zip: l.zip };
  }).filter(l => l.lat && l.lng);

  // Build table rows HTML
  const tableRows = coverageRows.map(r => `
<tr data-retailer="${esc(r.retailer_id)}" data-state="${esc(r.state)}" data-avail="${r.available}">
  <td>${esc(r.zip)}</td>
  <td>${esc(r.city)}</td>
  <td>${esc(r.state)}</td>
  <td>${esc(r.retailer_name)}</td>
  <td class="avail-${r.available===1?'yes':r.available===0?'no':'unk'}">${availLabel(r.available)}</td>
  <td>${r.confidence != null ? r.confidence+'%' : '—'}</td>
  <td>${fmt(r.first_seen)}</td>
  <td>${fmt(r.last_checked)}</td>
  ${r.source_url ? `<td><a href="${esc(r.source_url)}" target="_blank">↗</a></td>` : '<td></td>'}
</tr>`).join('');

  const newRows = newThisWeek.length
    ? newThisWeek.map(r => `<tr><td>${esc(r.zip)}</td><td>${esc(r.city)}</td><td>${esc(r.state)}</td><td>${esc(r.retailer_name)}</td><td>${fmt(r.first_seen)}</td></tr>`).join('')
    : '<tr><td colspan="5" style="color:#888;text-align:center">No new coverage this week</td></tr>';

  const summaryCards = retailers.map(r => {
    const s = summaries[r.id] || {};
    return `
    <div class="card" style="border-top:4px solid ${retailerColors[r.id]}">
      <div class="card-name">${esc(r.name)}</div>
      <div class="card-big">${s.covered ?? 0}</div>
      <div class="card-sub">zip codes covered</div>
      <div class="card-meta">${s.states ?? 0} states &nbsp;·&nbsp; updated ${fmt(s.last_checked)}</div>
    </div>`;
  }).join('');

  const legendItems = retailers.map(r =>
    `<div class="legend-item"><span class="legend-dot" style="background:${retailerColors[r.id]}"></span>${esc(r.name)}</div>`
  ).join('') + `<div class="legend-item"><span class="legend-dot" style="background:#ffffff;border:2px solid #555;width:10px;height:10px;margin-right:6px"></span>Fulfillment center</div>`;

  const retailerFilterOpts = retailers.map(r =>
    `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');

  // JSON data for map
  const mapPointsJson = JSON.stringify(mapPoints);
  const locPointsJson = JSON.stringify(locPoints);
  const retailerColorsJson = JSON.stringify(retailerColors);
  const dmaDataByRetailerJson = JSON.stringify(dmaDataByRetailer);
  const zipToDmaJson = JSON.stringify(zipToDma);
  const countyToDmaJson = JSON.stringify(countyToDma);
  const timelineDataJson = JSON.stringify(timeline.byDate);
  const dmaFirstSeenJson = JSON.stringify(timeline.byDmaFirstSeen);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Grocery Delivery Coverage — Rivendell Advisors</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#222;background:#f5f6f8}
header{background:#1a1a2e;color:#fff;padding:16px 28px;display:flex;align-items:center;justify-content:space-between}
header h1{margin:0;font-size:18px;font-weight:700;letter-spacing:-.3px}
header span{font-size:11px;color:#8899bb}
nav{display:flex;gap:2px;background:#111126;padding:0 28px}
nav button{background:none;border:none;color:#aab;padding:10px 16px;cursor:pointer;font-size:13px;border-bottom:3px solid transparent}
nav button.active,nav button:hover{color:#fff;border-bottom-color:#4a90e2}
.view{display:none;padding:24px 28px}
.view.active{display:block}
.cards{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.card{background:#fff;border-radius:8px;padding:18px 22px;min-width:200px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.card-name{font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.card-big{font-size:36px;font-weight:800;color:#1a1a2e;line-height:1.1;margin:6px 0 2px}
.card-sub{font-size:12px;color:#555}
.card-meta{font-size:11px;color:#aaa;margin-top:6px}
#map{height:560px;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.12);margin-bottom:16px}
.legend{background:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.15);font-size:12px}
.legend-title{font-weight:700;margin-bottom:6px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#555}
.legend-item{display:flex;align-items:center;margin:3px 0}
.legend-dot{width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:7px;flex-shrink:0}
.map-controls{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.map-controls select,.map-controls input{padding:6px 10px;border:1px solid #ccc;border-radius:6px;font-size:12px}
section{margin-bottom:32px}
h2{font-size:14px;font-weight:700;color:#333;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #e8e8e8}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
th{background:#f0f2f5;padding:9px 11px;text-align:left;font-size:11px;font-weight:700;color:#555;cursor:pointer;white-space:nowrap;user-select:none}
th:hover{background:#e4e8ee}
th.asc::after{content:' ▲';font-size:9px}th.desc::after{content:' ▼';font-size:9px}
td{padding:7px 11px;border-top:1px solid #f0f0f0}
tr:hover td{background:#fafbff}
.avail-yes{color:#1a8040;font-weight:600}
.avail-no{color:#c0392b}
.avail-unk{color:#999}
.filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.filters input,.filters select{padding:6px 10px;border:1px solid #ccc;border-radius:6px;font-size:12px;background:#fff}
.pager{margin-top:10px;display:flex;gap:8px;align-items:center}
.pager button{padding:4px 12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;font-size:12px}
.pager button:disabled{opacity:.4;cursor:default}
#row-info{font-size:11px;color:#888;margin-left:4px}
a{color:#4a90e2;text-decoration:none}a:hover{text-decoration:underline}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:#e8f5e9;color:#1a8040;margin-left:6px}
/* DMA view */
.view-toggle{display:flex;gap:4px;align-items:center}
.view-toggle button{padding:5px 14px;border:1px solid #555;border-radius:4px;background:#2a2a4e;color:#ccd;font-size:12px;cursor:pointer;transition:background .15s}
.view-toggle button.active{background:#4a90e2;border-color:#4a90e2;color:#fff}
.dma-panel-wrap{position:relative}
#dma-panel{position:fixed;right:0;top:0;width:400px;height:100vh;background:#1a1a2e;color:#dde;overflow-y:auto;transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1);z-index:2000;padding:20px 20px 40px;box-shadow:-4px 0 20px rgba(0,0,0,.5)}
#dma-panel.open{transform:translateX(0)}
#dma-panel h3{font-size:14px;color:#fff;margin:0 0 6px;padding-bottom:8px;border-bottom:1px solid #2a3a5e}
#dma-panel .dma-stat-row{display:flex;gap:20px;margin-bottom:14px;flex-wrap:wrap}
#dma-panel .dma-stat{background:#111126;border-radius:6px;padding:10px 14px;flex:1;min-width:100px}
#dma-panel .dma-stat-n{font-size:26px;font-weight:800;color:#4a90e2}
#dma-panel .dma-stat-label{font-size:11px;color:#88a;margin-top:2px}
#dma-panel table{width:100%;border-collapse:collapse;font-size:11px}
#dma-panel th{background:#0d0d1e;color:#88a;padding:7px 8px;text-align:left;position:sticky;top:0}
#dma-panel td{padding:6px 8px;border-top:1px solid #1e2a4e;white-space:nowrap}
#dma-panel tr.dma-row:hover td{background:#252550;cursor:pointer}
#dma-panel tr.dma-highlighted td{background:#1a3a6e}
.dma-close-btn{position:absolute;top:14px;right:16px;background:none;border:none;color:#88a;font-size:20px;cursor:pointer;line-height:1}
.dma-close-btn:hover{color:#fff}
.dma-toggle-btn{padding:5px 14px;border:1px solid #4a90e2;border-radius:4px;background:#111126;color:#4a90e2;font-size:12px;cursor:pointer;white-space:nowrap}
.dma-toggle-btn:hover{background:#4a90e2;color:#fff}
.choropleth-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:11px;color:#555}
.choropleth-legend span{display:inline-flex;align-items:center;gap:5px}
.choropleth-legend .swatch{width:14px;height:14px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.15)}
#dma-city-list{background:#111126;border-radius:6px;padding:10px;margin-top:10px;font-size:12px;color:#ccd;display:none}
#dma-city-list ul{margin:4px 0 0;padding-left:16px}
/* Timeline view */
#timeline-view{background:#111126;color:#dde;min-height:calc(100vh - 100px)}
#timeline-view h2{color:#dde;border-bottom-color:#2a3a5e}
.tl-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px}
.tl-chart-box{background:#1a1a2e;border-radius:10px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.tl-chart-box.full{grid-column:1/-1}
.tl-chart-box h3{margin:0 0 14px;font-size:13px;font-weight:700;color:#aac;text-transform:uppercase;letter-spacing:.5px}
.tl-chart-box canvas{width:100%!important}
.tl-placeholder{color:#556;font-size:12px;text-align:center;padding:40px 0;border:1px dashed #2a3a5e;border-radius:6px;margin-top:8px}
.tl-stat-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.tl-stat{background:#1a1a2e;border-radius:8px;padding:14px 18px;flex:1;min-width:140px}
.tl-stat-n{font-size:28px;font-weight:800;color:#4a90e2}
.tl-stat-label{font-size:11px;color:#88a;margin-top:3px}
</style>
</head>
<body>
<header>
  <h1>🛒 Grocery Delivery Coverage Tracker</h1>
  <span>Rivendell Advisors &nbsp;·&nbsp; ${esc(generatedAt)}</span>
</header>
<nav>
  <button class="active" onclick="showView('map-view',this)">🗺 Map</button>
  <button onclick="showView('data-view',this)">📊 Data Table</button>
  <button onclick="showView('new-view',this)">🆕 New This Week</button>
  <button onclick="showView('timeline-view',this);initTimeline()">📈 Timeline</button>
</nav>

<!-- MAP VIEW -->
<div id="map-view" class="view active">
  <div class="cards">${summaryCards}</div>
  <div class="map-controls">
    <div class="view-toggle">
      <button id="btn-city-view" class="active" onclick="setMapView('city')">City View</button>
      <button id="btn-dma-view" onclick="setMapView('dma')">DMA View</button>
    </div>
    <select id="map-retailer-filter">
      <option value="">All retailers</option>
      ${retailerFilterOpts}
    </select>
    <select id="map-avail-filter">
      <option value="1">Available zips</option>
      <option value="all">All zips</option>
    </select>
    <label style="font-size:12px;color:#555">
      <input type="checkbox" id="show-locations" checked> Show fulfillment centers
    </label>
    <span style="font-size:11px;color:#888" id="map-count"></span>
    <button class="dma-toggle-btn" onclick="toggleDmaPanel()">DMA Stats ▶</button>
  </div>
  <div id="map"></div>
  <div class="legend" id="city-legend">
    <div class="legend-title">Legend</div>
    ${legendItems}
  </div>
  <div class="legend" id="dma-legend" style="display:none">
    <div class="legend-title">DMA Coverage</div>
    <div class="choropleth-legend">
      <span><span class="swatch" style="background:#1a8040"></span>High (&ge;50% cities)</span>
      <span><span class="swatch" style="background:#3cb371"></span>Some (&lt;50%)</span>
      <span><span class="swatch" style="background:#b8860b"></span>Probed, 0%</span>
      <span><span class="swatch" style="background:#444"></span>Not yet probed</span>
    </div>
  </div>
</div>

<!-- DMA Stats Panel -->
<div id="dma-panel">
  <button class="dma-close-btn" onclick="toggleDmaPanel()">✕</button>
  <h3>DMA Coverage Dashboard</h3>
  <div class="dma-stat-row" id="dma-stat-row">
    <div class="dma-stat"><div class="dma-stat-n" id="stat-total">—</div><div class="dma-stat-label">Total DMAs</div></div>
    <div class="dma-stat"><div class="dma-stat-n" id="stat-covered">—</div><div class="dma-stat-label">With Coverage</div></div>
    <div class="dma-stat"><div class="dma-stat-n" id="stat-pct">—</div><div class="dma-stat-label">Avg Coverage %</div></div>
  </div>
  <div id="dma-city-list">
    <strong id="dma-city-list-title"></strong>
    <ul id="dma-city-list-ul"></ul>
  </div>
  <h3 style="margin-top:14px">Top 20 DMAs by TV Homes</h3>
  <div style="overflow-x:auto">
  <table id="dma-stats-table">
    <thead><tr>
      <th>#</th><th>DMA</th><th>Tier</th><th>TV Homes</th><th>Confirmed</th><th>Coverage%</th>
    </tr></thead>
    <tbody id="dma-stats-body"></tbody>
  </table>
  </div>
</div>

<!-- DATA TABLE VIEW -->
<div id="data-view" class="view">
  <section>
    <h2>Coverage Detail</h2>
    <div class="filters">
      <input type="text" id="filter-text" placeholder="Search zip, city, state..."/>
      <select id="filter-state"><option value="">All states</option></select>
      <select id="filter-retailer"><option value="">All retailers</option>${retailerFilterOpts}</select>
      <select id="filter-avail">
        <option value="">All</option>
        <option value="1">Available</option>
        <option value="0">Not available</option>
        <option value="2">Unknown</option>
      </select>
    </div>
    <span id="row-info"></span>
    <table id="cov-table">
      <thead><tr>
        <th data-col="0">Zip</th><th data-col="1">City</th><th data-col="2">State</th>
        <th data-col="3">Retailer</th><th data-col="4">Available</th>
        <th data-col="5">Confidence</th><th data-col="6">First Seen</th>
        <th data-col="7">Last Checked</th><th>Source</th>
      </tr></thead>
      <tbody id="cov-body">${tableRows}</tbody>
    </table>
    <div class="pager">
      <button id="prev-btn">← Prev</button>
      <span id="page-info"></span>
      <button id="next-btn">Next →</button>
      <span id="row-info2"></span>
    </div>
  </section>
</div>

<!-- NEW THIS WEEK VIEW -->
<div id="new-view" class="view">
  <section>
    <h2>New Coverage This Week <span class="badge">${newThisWeek.length}</span></h2>
    <table>
      <thead><tr><th>Zip</th><th>City</th><th>State</th><th>Retailer</th><th>First Seen</th></tr></thead>
      <tbody>${newRows}</tbody>
    </table>
  </section>
</div>

<!-- TIMELINE VIEW -->
<div id="timeline-view" class="view">
  <section>
    <h2>Coverage Growth Timeline</h2>
    <div class="tl-stat-row" id="tl-stats"></div>
    <div class="tl-grid">
      <div class="tl-chart-box full">
        <h3>Coverage Growth — Cities Confirmed Over Time</h3>
        <canvas id="chart-growth" height="90"></canvas>
      </div>
      <div class="tl-chart-box">
        <h3>New DMAs Unlocked Per Day (by Tier)</h3>
        <canvas id="chart-dma-unlock" height="200"></canvas>
      </div>
      <div class="tl-chart-box">
        <h3>Signal Velocity (Signals Per Day)</h3>
        <canvas id="chart-signals" height="200"></canvas>
        <div class="tl-placeholder" id="tl-signal-placeholder">Multi-day history needed for velocity.<br>Today shown as baseline bar.</div>
      </div>
    </div>
  </section>
</div>

<script>
// ── View switcher ─────────────────────────────────────────────────────────────
function showView(id, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  if (id === 'map-view' && window._map) window._map.invalidateSize();
}

// ── Map ───────────────────────────────────────────────────────────────────────
const MAP_POINTS = ${mapPointsJson};
const LOC_POINTS = ${locPointsJson};
const COLORS = ${retailerColorsJson};
window.DMA_DATA = ${dmaDataByRetailerJson};
const ZIP_TO_DMA = ${zipToDmaJson};
const COUNTY_TO_DMA = ${countyToDmaJson};
window.TIMELINE_DATA = ${timelineDataJson};
window.DMA_FIRST_SEEN = ${dmaFirstSeenJson};

const map = L.map('map').setView([38.5, -96], 4);
window._map = map;

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
  maxZoom: 18
}).addTo(map);

// Layer groups per retailer
const zipLayers = {};
const locLayer = L.layerGroup().addTo(map);

function buildZipLayers(retailerFilter) {
  Object.values(zipLayers).forEach(lg => lg.clearLayers());

  const points = retailerFilter
    ? MAP_POINTS.filter(p => p.retailer_id === retailerFilter)
    : MAP_POINTS;

  points.forEach(p => {
    if (!zipLayers[p.retailer_id]) {
      zipLayers[p.retailer_id] = L.layerGroup().addTo(map);
    }
    const color = COLORS[p.retailer_id] || '#888';
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: 6, color: color, fillColor: color,
      fillOpacity: 0.7, weight: 1
    });
    marker.bindPopup(
      '<b>' + p.zip + '</b> — ' + (p.city||'') + ', ' + p.state +
      '<br><span style="color:' + color + '">' + p.retailer_name + '</span>' +
      (p.confidence ? '<br>Confidence: ' + p.confidence + '%' : '') +
      (p.first_seen ? '<br>First seen: ' + new Date(p.first_seen*1000).toLocaleDateString() : '')
    );
    zipLayers[p.retailer_id].addLayer(marker);
  });

  document.getElementById('map-count').textContent = points.length + ' zip codes shown';
}

function buildLocLayer(show) {
  locLayer.clearLayers();
  if (!show) return;
  LOC_POINTS.forEach(p => {
    const icon = L.divIcon({
      html: '<div style="background:#fff;border:2px solid #333;border-radius:50%;width:10px;height:10px"></div>',
      className:'', iconAnchor:[5,5]
    });
    L.marker([p.lat, p.lng], {icon})
      .bindPopup('<b>Fulfillment Center</b><br>' + (p.address||'') + '<br><i>' + p.retailer_name + '</i>')
      .addTo(locLayer);
  });
}

buildZipLayers('');
buildLocLayer(true);

document.getElementById('map-retailer-filter').addEventListener('change', function() {
  if (currentMapView === 'city') buildZipLayers(this.value);
  else { hideDmaLayer(); showDmaLayer(); }
  refreshDmaPanel();
});
document.getElementById('show-locations').addEventListener('change', function() {
  buildLocLayer(this.checked);
});

// ── DMA choropleth ─────────────────────────────────────────────────────────────
let currentMapView = 'city';
let countyGeoData = null;
let dmaLayer = null;

function getDmaDataForRetailer() {
  const rid = document.getElementById('map-retailer-filter').value;
  const allRetailers = Object.keys(window.DMA_DATA);
  const key = rid || allRetailers[0];
  return window.DMA_DATA[key] || [];
}

function dmaColor(d) {
  if (!d || d.cities_probed === 0) return '#404060';
  if (d.cities_confirmed === 0) return '#b8860b';
  if (d.coverage_pct >= 50) return '#1a8040';
  return '#3cb371';
}

function dmaFillOpacity(d) {
  if (!d || d.cities_probed === 0) return 0.25;
  return 0.65;
}

async function showDmaLayer() {
  if (!countyGeoData) {
    try {
      const resp = await fetch('../data/us_counties.geojson');
      countyGeoData = await resp.json();
    } catch(e) {
      console.error('Failed to load county GeoJSON:', e);
      return;
    }
  }

  const dmaArr = getDmaDataForRetailer();
  const dmaMap = {};
  dmaArr.forEach(d => { dmaMap[d.dma_id] = d; });

  dmaLayer = L.geoJSON(countyGeoData, {
    style: feature => {
      const stateFips = feature.properties.STATE;
      const countyName = (feature.properties.NAME || '').toLowerCase().trim();
      const key = stateFips + '|' + countyName;
      const dmaId = COUNTY_TO_DMA[key];
      const d = dmaId ? dmaMap[dmaId] : null;
      return {
        fillColor: dmaColor(d),
        fillOpacity: dmaFillOpacity(d),
        color: '#1a1a2e',
        weight: 0.4
      };
    },
    onEachFeature: (feature, layer) => {
      const stateFips = feature.properties.STATE;
      const countyName = (feature.properties.NAME || '').toLowerCase().trim();
      const key = stateFips + '|' + countyName;
      const dmaId = COUNTY_TO_DMA[key];
      const d = dmaId ? dmaMap[dmaId] : null;
      layer.bindPopup(
        '<b>' + feature.properties.NAME + ' County</b>' +
        (d
          ? '<br>DMA: <b>' + d.dma_name + '</b>' +
            '<br>Cities confirmed: ' + d.cities_confirmed + ' / ' + d.cities_total +
            '<br>Coverage: ' + d.coverage_pct.toFixed(1) + '%' +
            (d.top_cities && d.top_cities.length
              ? '<br><small>' + d.top_cities.slice(0,3).join(', ') + '</small>'
              : '')
          : '<br><i>No DMA data</i>')
      );
    }
  }).addTo(map);

  document.getElementById('map-count').textContent = '3,221 counties colored by DMA';
}

function hideDmaLayer() {
  if (dmaLayer) { map.removeLayer(dmaLayer); dmaLayer = null; }
}

function setMapView(mode) {
  currentMapView = mode;
  if (mode === 'dma') {
    Object.values(zipLayers).forEach(lg => { try { map.removeLayer(lg); } catch(e){} });
    showDmaLayer();
    document.getElementById('city-legend').style.display = 'none';
    document.getElementById('dma-legend').style.display = '';
    document.getElementById('btn-city-view').classList.remove('active');
    document.getElementById('btn-dma-view').classList.add('active');
  } else {
    hideDmaLayer();
    Object.values(zipLayers).forEach(lg => { try { lg.addTo(map); } catch(e){} });
    buildZipLayers(document.getElementById('map-retailer-filter').value);
    document.getElementById('dma-legend').style.display = 'none';
    document.getElementById('city-legend').style.display = '';
    document.getElementById('btn-dma-view').classList.remove('active');
    document.getElementById('btn-city-view').classList.add('active');
  }
}

// ── DMA stats panel ────────────────────────────────────────────────────────────
function toggleDmaPanel() {
  const panel = document.getElementById('dma-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) refreshDmaPanel();
}

function refreshDmaPanel() {
  const dmaArr = getDmaDataForRetailer();
  const total = dmaArr.length;
  const covered = dmaArr.filter(d => d.cities_confirmed > 0).length;
  const avgPct = total ? (dmaArr.reduce((s,d) => s + d.coverage_pct, 0) / total) : 0;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-covered').textContent = covered;
  document.getElementById('stat-pct').textContent = avgPct.toFixed(1) + '%';

  const top20 = dmaArr
    .filter(d => d.tv_homes)
    .sort((a,b) => b.tv_homes - a.tv_homes)
    .slice(0, 20);

  const fmt = n => n ? n.toLocaleString() : '—';
  const tbody = document.getElementById('dma-stats-body');
  tbody.innerHTML = '';
  top20.forEach((d, i) => {
    const pct = d.coverage_pct.toFixed(1);
    const dotColor = d.cities_confirmed > 0
      ? (d.coverage_pct >= 50 ? '#1a8040' : '#3cb371')
      : (d.cities_probed > 0 ? '#b8860b' : '#404060');
    const tr = document.createElement('tr');
    tr.className = 'dma-row';
    tr.innerHTML =
      '<td style="color:#88a">' + (i+1) + '</td>' +
      '<td style="color:#eef"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + dotColor + ';margin-right:6px"></span>' + d.dma_name + '</td>' +
      '<td style="color:#88a">' + d.tier + '</td>' +
      '<td style="color:#ccd">' + fmt(d.tv_homes) + '</td>' +
      '<td style="color:#' + (d.cities_confirmed > 0 ? '3cb371' : '666') + '">' + d.cities_confirmed + '</td>' +
      '<td style="color:#ccd">' + pct + '%</td>';
    tr.addEventListener('click', () => {
      document.querySelectorAll('#dma-stats-body .dma-row').forEach(r => r.classList.remove('dma-highlighted'));
      tr.classList.add('dma-highlighted');
      showDmaCities(d);
    });
    tbody.appendChild(tr);
  });
}

function showDmaCities(d) {
  const el = document.getElementById('dma-city-list');
  const title = document.getElementById('dma-city-list-title');
  const ul = document.getElementById('dma-city-list-ul');
  title.textContent = d.dma_name + ' — confirmed cities:';
  ul.innerHTML = '';
  if (d.top_cities && d.top_cities.length) {
    d.top_cities.forEach(c => {
      const li = document.createElement('li');
      li.textContent = c;
      ul.appendChild(li);
    });
    if (d.cities_confirmed > d.top_cities.length) {
      const li = document.createElement('li');
      li.style.color = '#88a';
      li.textContent = '… and ' + (d.cities_confirmed - d.top_cities.length) + ' more';
      ul.appendChild(li);
    }
  } else {
    const li = document.createElement('li');
    li.style.color = '#88a';
    li.textContent = 'No confirmed cities yet';
    ul.appendChild(li);
  }
  el.style.display = '';
}

// ── Data table ────────────────────────────────────────────────────────────────
(function() {
  const tbody = document.getElementById('cov-body');
  const allRows = Array.from(tbody.querySelectorAll('tr'));
  let filtered = allRows.slice();
  let sortCol = -1, sortDir = 1, page = 0;
  const PAGE = 250;

  // State filter options
  const states = [...new Set(allRows.map(r => r.dataset.state).filter(Boolean))].sort();
  const stateEl = document.getElementById('filter-state');
  states.forEach(s => { const o = document.createElement('option'); o.value=s; o.textContent=s; stateEl.appendChild(o); });

  function applyFilter() {
    const txt = document.getElementById('filter-text').value.toLowerCase();
    const state = stateEl.value;
    const retailer = document.getElementById('filter-retailer').value;
    const avail = document.getElementById('filter-avail').value;

    filtered = allRows.filter(row => {
      if (state && row.dataset.state !== state) return false;
      if (retailer && row.dataset.retailer !== retailer) return false;
      if (avail !== '' && row.dataset.avail !== avail) return false;
      if (txt) {
        const t = Array.from(row.cells).map(c=>c.textContent).join(' ').toLowerCase();
        if (!t.includes(txt)) return false;
      }
      return true;
    });
    if (sortCol >= 0) doSort();
    page = 0;
    render();
  }

  function doSort() {
    filtered.sort((a, b) => {
      const av = a.cells[sortCol]?.innerText?.trim() ?? '';
      const bv = b.cells[sortCol]?.innerText?.trim() ?? '';
      const an = parseFloat(av), bn = parseFloat(bv);
      if (!isNaN(an) && !isNaN(bn)) return sortDir * (an - bn);
      return sortDir * av.localeCompare(bv);
    });
  }

  function render() {
    const start = page * PAGE;
    const slice = filtered.slice(start, start + PAGE);
    tbody.innerHTML = '';
    slice.forEach(r => tbody.appendChild(r));
    const end = Math.min(start + slice.length, filtered.length);
    document.getElementById('row-info').textContent =
      filtered.length + ' rows matching filters';
    document.getElementById('page-info').textContent =
      'Page ' + (page+1) + '/' + Math.max(1, Math.ceil(filtered.length/PAGE));
    document.getElementById('row-info2').textContent =
      'Showing ' + (start+1) + '–' + end;
    document.getElementById('prev-btn').disabled = page === 0;
    document.getElementById('next-btn').disabled = end >= filtered.length;
  }

  document.getElementById('cov-table').querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = parseInt(th.dataset.col);
      if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = 1; }
      document.querySelectorAll('#cov-table th').forEach(h => h.classList.remove('asc','desc'));
      th.classList.add(sortDir===1?'asc':'desc');
      doSort(); page = 0; render();
    });
  });

  document.getElementById('prev-btn').addEventListener('click', () => { page--; render(); });
  document.getElementById('next-btn').addEventListener('click', () => { page++; render(); });
  ['filter-text','filter-state','filter-retailer','filter-avail'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyFilter);
  });

  render();
})();

// ── Timeline charts ────────────────────────────────────────────────────────────
let _timelineInited = false;
function initTimeline() {
  if (_timelineInited) return;
  _timelineInited = true;

  const tlData = window.TIMELINE_DATA || [];
  const dmaFirstSeen = window.DMA_FIRST_SEEN || {};
  const COLORS_MAP = ${retailerColorsJson};

  // Group byDate by retailer
  const retailerIds = [...new Set(tlData.map(d => d.retailer_id))];
  const allDates = [...new Set(tlData.map(d => d.snapshot_date))].sort();

  // Populate stat cards for the first retailer with data
  const statsEl = document.getElementById('tl-stats');
  statsEl.innerHTML = '';
  for (const rid of retailerIds) {
    const latest = tlData.filter(d => d.retailer_id === rid).slice(-1)[0];
    if (!latest) continue;
    const color = COLORS_MAP[rid] || '#4a90e2';
    statsEl.innerHTML += \`
      <div class="tl-stat" style="border-top:3px solid \${color}">
        <div class="tl-stat-n">\${latest.total_cities_confirmed}</div>
        <div class="tl-stat-label">\${rid} — confirmed cities</div>
      </div>
      <div class="tl-stat" style="border-top:3px solid \${color}">
        <div class="tl-stat-n">\${latest.dmas_with_coverage}</div>
        <div class="tl-stat-label">\${rid} — DMAs with coverage</div>
      </div>
      <div class="tl-stat" style="border-top:3px solid \${color}">
        <div class="tl-stat-n">\${latest.total_signals}</div>
        <div class="tl-stat-label">\${rid} — total signals</div>
      </div>
    \`;
  }

  const chartDefaults = {
    plugins: { legend: { labels: { color: '#aac', font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#88a', font: { size: 10 } }, grid: { color: '#1e2a4e' } },
      y: { ticks: { color: '#88a', font: { size: 10 } }, grid: { color: '#1e2a4e' } }
    }
  };

  // Chart 1: Coverage Growth Line Chart
  const growthDatasets = retailerIds.map(rid => {
    const color = COLORS_MAP[rid] || '#4a90e2';
    return {
      label: rid,
      data: allDates.map(d => {
        const row = tlData.find(r => r.retailer_id === rid && r.snapshot_date === d);
        return row ? row.total_cities_confirmed : null;
      }),
      borderColor: color,
      backgroundColor: color + '33',
      pointBackgroundColor: color,
      pointRadius: 4,
      tension: 0.3,
      fill: false,
      spanGaps: true
    };
  });
  new Chart(document.getElementById('chart-growth'), {
    type: 'line',
    data: { labels: allDates, datasets: growthDatasets },
    options: {
      responsive: true,
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        title: { display: false },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const d = items[0]?.label;
              const today = new Date().toISOString().slice(0,10);
              return d === today ? ['Today'] : [];
            }
          }
        }
      }
    }
  });

  // Chart 2: DMA Unlock Bar Chart (new DMAs per day stacked by tier)
  const tierColors = { mega: '#e74c3c', large: '#f39c12', mid: '#3498db', small: '#2ecc71' };
  const tiers = ['mega', 'large', 'mid', 'small'];
  // For primary retailer (first one with dmaFirstSeen data)
  const primaryRid = retailerIds.find(r => (dmaFirstSeen[r] || []).length > 0) || retailerIds[0];
  const firstSeenRows = dmaFirstSeen[primaryRid] || [];
  const dmaUnlockByDate = {};
  for (const row of firstSeenRows) {
    const d = row.first_confirmed_date;
    if (!d) continue;
    if (!dmaUnlockByDate[d]) dmaUnlockByDate[d] = { mega:0, large:0, mid:0, small:0 };
    const tier = row.tier || 'small';
    dmaUnlockByDate[d][tier] = (dmaUnlockByDate[d][tier] || 0) + 1;
  }
  const dmaUnlockDates = Object.keys(dmaUnlockByDate).sort();
  new Chart(document.getElementById('chart-dma-unlock'), {
    type: 'bar',
    data: {
      labels: dmaUnlockDates.length ? dmaUnlockDates : allDates,
      datasets: tiers.map(tier => ({
        label: tier,
        data: (dmaUnlockDates.length ? dmaUnlockDates : allDates).map(d => dmaUnlockByDate[d]?.[tier] || 0),
        backgroundColor: tierColors[tier] || '#888',
        stack: 'dma'
      }))
    },
    options: {
      responsive: true,
      ...chartDefaults,
      plugins: { ...chartDefaults.plugins },
      scales: {
        x: { ...chartDefaults.scales.x, stacked: true },
        y: { ...chartDefaults.scales.y, stacked: true }
      }
    }
  });

  // Chart 3: Signal Velocity
  const signalDatasets = retailerIds.map(rid => {
    const color = COLORS_MAP[rid] || '#4a90e2';
    return {
      label: rid,
      data: allDates.map(d => {
        const row = tlData.find(r => r.retailer_id === rid && r.snapshot_date === d);
        return row ? row.total_signals : 0;
      }),
      backgroundColor: color + 'cc'
    };
  });
  new Chart(document.getElementById('chart-signals'), {
    type: 'bar',
    data: { labels: allDates, datasets: signalDatasets },
    options: {
      responsive: true,
      ...chartDefaults,
      plugins: { ...chartDefaults.plugins }
    }
  });

  if (allDates.length <= 1) {
    document.getElementById('tl-signal-placeholder').style.display = '';
  } else {
    document.getElementById('tl-signal-placeholder').style.display = 'none';
  }
}
<\/script>
</body>
</html>`;

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const out = join(REPORTS_DIR, 'index.html');
  writeFileSync(out, html);
  log(`Report written → ${out} (${coverageRows.length} rows, ${locations.length} locations, ${newThisWeek.length} new this week)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
