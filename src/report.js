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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Grocery Delivery Coverage — Rivendell Advisors</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
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
</nav>

<!-- MAP VIEW -->
<div id="map-view" class="view active">
  <div class="cards">${summaryCards}</div>
  <div class="map-controls">
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
  </div>
  <div id="map"></div>
  <div class="legend">
    <div class="legend-title">Legend</div>
    ${legendItems}
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
  buildZipLayers(this.value);
});
document.getElementById('show-locations').addEventListener('change', function() {
  buildLocLayer(this.checked);
});

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
<\/script>
</body>
</html>`;

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const out = join(REPORTS_DIR, 'index.html');
  writeFileSync(out, html);
  log(`Report written → ${out} (${coverageRows.length} rows, ${locations.length} locations, ${newThisWeek.length} new this week)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
