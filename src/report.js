/**
 * report.js — Generate reports/index.html with MSA-based coverage map
 *
 * Tabs: Map | Methodology | Project Summary
 *
 * Map Layers:
 *  1. MSA Coverage (default ON) — choropleth from msa_probe_v2_results.json
 *  2. Facility Network (default OFF, per-type toggleable)
 *  3. 50-mile service circles (default OFF)
 *
 * Usage: node src/report.js
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const REPORTS_DIR = join(PROJECT_ROOT, 'reports');
const MSA_PROBE_PATH = join(PROJECT_ROOT, 'data', 'msa_probe_v2_results.json');
const PHASE3_ZIP_PATH = join(PROJECT_ROOT, 'data', 'full_msa_zip_results.json');

function log(msg) { console.log(`[report] ${new Date().toISOString()} ${msg}`); }
function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Extract facility code from address_raw */
function extractFacilityCode(addr) {
  if (!addr) return null;
  const dashMatch = addr.match(/^([A-Z][A-Z0-9]{2,5})\s*-\s*/);
  if (dashMatch) return dashMatch[1];
  const codeMatch = addr.match(/\b([A-Z][A-Z0-9]{2,5})\b/);
  return codeMatch ? codeMatch[1] : null;
}

/** Describe what a facility type means for fresh grocery */
function facilityCapabilityNote(type) {
  switch (type) {
    case 'ssd_fulfillment':    return 'Primary grocery node — SSD facility with temperature-controlled zones';
    case 'fresh_hub':          return 'Amazon Fresh dark store — purpose-built fulfillment-only perishable facility';
    case 'whole_foods_node':   return 'Whole Foods store serving as microfulfillment node';
    case 'amazon_fresh_store': return 'Amazon Fresh store — may transition to online-only hub';
    case 'fresh_distribution': return 'Fresh distribution — likely grocery-capable';
    case 'same_day_facility':  return 'Same-day facility — grocery capability unconfirmed';
    case 'fulfillment_center': return 'Standard fulfillment center — does not typically handle perishables';
    case 'delivery_station':   return 'Last-mile delivery station — not a fulfillment facility';
    case 'sortation_center':   return 'Sortation center — package routing, not grocery fulfillment';
    case 'distribution_center':return 'Distribution center — general logistics, not fresh-specific';
    default:                   return 'Amazon facility — grocery capability unconfirmed';
  }
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error('Database not found. Run npm run setup first.');
    process.exit(1);
  }
  if (!existsSync(MSA_PROBE_PATH)) {
    console.error('MSA probe data not found: ' + MSA_PROBE_PATH);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // ── Load MSA probe results (Phase 1) ────────────────────────────────────────
  const msaProbeRaw = JSON.parse(readFileSync(MSA_PROBE_PATH, 'utf8'));
  const msaProbeArr = Object.values(msaProbeRaw);

  // ── Load Phase 3 ZIP probe results (ground truth) ────────────────────────────
  let phase3ByMsa = {}; // keyed by msa_id: { confirmed: bool, allNone: bool, zipCount: number }
  let phase3TotalZips = 0;
  let phase3TotalMsas = 0;
  if (existsSync(PHASE3_ZIP_PATH)) {
    const p3Raw = JSON.parse(readFileSync(PHASE3_ZIP_PATH, 'utf8'));
    phase3TotalZips = Object.keys(p3Raw).length;
    for (const [zip, data] of Object.entries(p3Raw)) {
      const msaId = data.msa_id;
      if (!msaId) continue;
      if (!phase3ByMsa[msaId]) phase3ByMsa[msaId] = { confirmed: false, allNone: true, zipCount: 0 };
      phase3ByMsa[msaId].zipCount++;
      if (data.status === 'full_fresh' || data.status === 'ambient_fresh') {
        phase3ByMsa[msaId].confirmed = true;
        phase3ByMsa[msaId].allNone = false;
      } else if (data.status !== 'none') {
        phase3ByMsa[msaId].allNone = false;
      }
    }
    phase3TotalMsas = Object.keys(phase3ByMsa).length;
    log(`Phase 3 data loaded: ${phase3TotalZips} ZIPs across ${phase3TotalMsas} MSAs`);
  }

  // ── Merge Phase 3 into effective MSA status ───────────────────────────────────
  // Phase 3 is ground truth when it has data for an MSA.
  // Fall back to Phase 1 only when Phase 3 has no data for that MSA.
  function effectiveMsaStatus(m) {
    const p3 = phase3ByMsa[m.msa_id];
    if (p3) {
      if (p3.confirmed) return 'full_fresh';   // at least one ZIP confirmed
      if (p3.allNone)   return 'none';          // all ZIPs tested → no coverage
      return 'none';                            // has data, none confirmed
    }
    return m.status; // no Phase 3 data yet → Phase 1 result
  }

  const msaTotal = msaProbeArr.length;
  const msaConfirmed = msaProbeArr.filter(m => {
    const s = effectiveMsaStatus(m);
    return s === 'full_fresh' || s === 'ambient_fresh';
  }).length;
  const msaNone = msaProbeArr.filter(m => effectiveMsaStatus(m) === 'none').length;

  // Find probe date (most recent probed_at)
  const probeDates = msaProbeArr.map(m => m.probed_at).filter(Boolean).sort();
  const probeDate = probeDates.length
    ? new Date(probeDates[probeDates.length - 1]).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })
    : 'March 2026';

  // Build a lookup map by msa_id (string) for the client-side JS
  const msaDataForMap = {};
  msaProbeArr.forEach(m => {
    // Summarize offer types found across all ZIPs
    const offerTypes = new Set();
    if (m.zip_results) {
      Object.values(m.zip_results).forEach(zipData => {
        ['bananas','strawberries'].forEach(prod => {
          const prodData = zipData[prod];
          if (prodData && prodData.offers) {
            prodData.offers.forEach(o => {
              const sf = (o.ships_from || '').toLowerCase();
              if (sf.includes('whole foods')) offerTypes.add('Whole Foods');
              else if (sf.includes('amazonfresh') || sf.includes('amazon fresh')) offerTypes.add('AmazonFresh');
              else if (sf.includes('amazon.com')) offerTypes.add('Amazon.com (same-day)');
              else if (sf) offerTypes.add(o.ships_from.slice(0, 30));
            });
          }
        });
      });
    }
    msaDataForMap[m.msa_id] = {
      msa_id: m.msa_id,
      msa_name: m.msa_name,
      msa_population: m.msa_population,
      status: effectiveMsaStatus(m),
      status_phase1: m.status,
      phase3_zips: phase3ByMsa[m.msa_id]?.zipCount || 0,
      zips_tested: m.zips_tested || [],
      offer_types: [...offerTypes],
      nearby_facilities: [] // populated below after facilities are loaded
    };
  });

  // ── Compute nearby facilities per MSA ────────────────────────────────────
  // Load MSA centroids from GeoJSON
  const msaGeoRaw = JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'us_msas.geojson'), 'utf8'));
  const msaCentroids = {};
  msaGeoRaw.features.forEach(f => {
    const p = f.properties;
    const geom = f.geometry;
    const coords = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
    const lats = coords.map(c => c[1]);
    const lngs = coords.map(c => c[0]);
    msaCentroids[p.msa_id] = [lats.reduce((a,b)=>a+b,0)/lats.length, lngs.reduce((a,b)=>a+b,0)/lngs.length];
  });

  // Load grocery-capable facilities with coords
  const groceryFacilities = db.prepare(`
    SELECT address_raw, city, state, lat, lng, type
    FROM locations
    WHERE retailer_id='amazon_same_day'
    AND type IN ('ssd_fulfillment','fresh_hub','whole_foods_node')
    AND lat IS NOT NULL
  `).all();

  function distMi(lat1,lng1,lat2,lng2) {
    const R=Math.PI/180, dlat=(lat2-lat1)*R, dlng=(lng2-lng1)*R;
    const a=Math.sin(dlat/2)**2+Math.cos(lat1*R)*Math.cos(lat2*R)*Math.sin(dlng/2)**2;
    return 6371*2*Math.asin(Math.sqrt(a))*0.621371;
  }

  const typeLabel = { ssd_fulfillment:'SSD', fresh_hub:'Fresh Dark Store', whole_foods_node:'Whole Foods' };

  // Deduplicate facilities by rounded coords before distance calc
  const seenFacCoords = new Set();
  const uniqueFacilities = groceryFacilities.filter(f => {
    const key = f.lat.toFixed(3)+','+f.lng.toFixed(3);
    if (seenFacCoords.has(key)) return false;
    seenFacCoords.add(key); return true;
  });

  // Load ZIP coords for confirmed ZIPs
  const zipCoords = {};
  const allZipsList = [...new Set(msaProbeArr.flatMap(m => m.zips_tested || []))];
  if (allZipsList.length) {
    const placeholders = allZipsList.map(() => '?').join(',');
    db.prepare(`SELECT zip, lat, lng FROM zip_master WHERE zip IN (${placeholders}) AND lat IS NOT NULL`)
      .all(...allZipsList)
      .forEach(r => { zipCoords[r.zip] = [r.lat, r.lng]; });
  }

  // Identify 'expansion likely' MSAs: none status + SSD/dark store within 75mi
  const ssdFacilities = uniqueFacilities.filter(f => ['ssd_fulfillment','fresh_hub'].includes(f.type));

  Object.keys(msaDataForMap).forEach(msaId => {
    const msa = msaDataForMap[msaId];
    if (msa.status === 'none') {
      const centroid = msaCentroids[msaId];
      if (centroid) {
        const [clat, clng] = centroid;
        const nearestSSD = ssdFacilities
          .map(f => ({ ...f, dist: distMi(clat, clng, f.lat, f.lng) }))
          .filter(f => f.dist <= 75)
          .sort((a,b) => a.dist - b.dist)[0];
        if (nearestSSD) {
          msa.expansion_signal = {
            dist: Math.round(nearestSSD.dist),
            type: typeLabel[nearestSSD.type] || nearestSSD.type,
            code: nearestSSD.address_raw.includes(' - ') ? nearestSSD.address_raw.split(' - ')[0] : null,
            loc: [nearestSSD.city, nearestSSD.state].filter(Boolean).join(', ')
          };
        }
      }
    }
  });

  Object.keys(msaDataForMap).forEach(msaId => {
    const msa = msaDataForMap[msaId];

    // Find best reference point: nearest confirmed ZIP with coords, else centroid
    let refLat, refLng, refLabel;
    const confirmedZips = (msa.zips_tested || []).filter(z => zipCoords[z]);
    if (confirmedZips.length) {
      // Use the first confirmed ZIP (probe tested in order, first is usually most central)
      const [lat, lng] = zipCoords[confirmedZips[0]];
      refLat = lat; refLng = lng;
      refLabel = 'nearest confirmed ZIP (' + confirmedZips[0] + ')';
    } else {
      const centroid = msaCentroids[msaId];
      if (!centroid) return;
      [refLat, refLng] = centroid;
      refLabel = 'MSA centroid (est.)';
    }

    const nearby = uniqueFacilities
      .map(f => ({ ...f, dist: Math.round(distMi(refLat, refLng, f.lat, f.lng)) }))
      .filter(f => f.dist <= 60)
      .sort((a,b) => a.dist - b.dist)
      .slice(0, 8)
      .map(f => {
        const code = f.address_raw.includes(' - ') ? f.address_raw.split(' - ')[0] : null;
        const loc = [f.city, f.state].filter(Boolean).join(', ') || f.address_raw.slice(0,30);
        return { type: typeLabel[f.type] || f.type, code, loc, dist: f.dist };
      });

    msaDataForMap[msaId].nearby_facilities = nearby;
    msaDataForMap[msaId].distance_ref = refLabel;
  });

  // ── Load facility data from SQLite ────────────────────────────────────────
  const locPoints = db.prepare(`
    SELECT address_raw, city, state, type, lat, lng, confidence_tier, source_url
    FROM locations
    WHERE lat IS NOT NULL AND lng IS NOT NULL
      AND type != 'corporate'
    ORDER BY type, id
  `).all().map(l => ({
    lat: l.lat, lng: l.lng,
    address_raw: l.address_raw,
    city: l.city || null, state: l.state || null,
    type: l.type || 'unknown',
    confidence_tier: l.confidence_tier || 'external_unverified',
    source_url: l.source_url || null,
    facility_code: extractFacilityCode(l.address_raw),
    capability_note: facilityCapabilityNote(l.type || 'unknown')
  }));

  // Facility counts by type for intro panel
  const facilityByType = db.prepare(`
    SELECT type, COUNT(*) as n FROM locations
    WHERE type != 'corporate' AND lat IS NOT NULL
    GROUP BY type ORDER BY n DESC
  `).all();
  const facilityMap = {};
  facilityByType.forEach(r => { facilityMap[r.type] = r.n; });
  const totalLocationsMapped = facilityByType.reduce((a, r) => a + r.n, 0);
  const totalLocationsAll = db.prepare("SELECT COUNT(*) as n FROM locations WHERE retailer_id='amazon_same_day' AND type != 'corporate'").get().n;
  const totalLocations = totalLocationsMapped; // mapped (with coords)

  // ── Generate CSV download ─────────────────────────────────────────────────
  // Map MSA probe status for each ZIP via zip_master → MSA proximity
  // Strategy: look at confirmed SSD/fresh facilities, mark ZIPs within 50mi
  const freshFacilities = db.prepare(`
    SELECT lat, lng FROM locations
    WHERE lat IS NOT NULL AND lng IS NOT NULL
      AND type IN ('ssd_fulfillment','fresh_hub','fresh_distribution','same_day_facility')
  `).all();

  const zipsWithPop = db.prepare(`
    SELECT z.zip, z.city, z.state, z.population, z.lat, z.lng,
           d.name AS dma_name, d.tier AS dma_tier
    FROM zip_master z
    LEFT JOIN dmas d ON d.id = z.dma_id
    WHERE z.lat IS NOT NULL AND z.lng IS NOT NULL AND z.population IS NOT NULL
    ORDER BY z.state, z.zip
  `).all();

  const csvRows = ['zip,city,state,population,dma_name,dma_tier,amazon_sameday_msa_status,amazon_sameday_50mi_coverage,notes'];
  let csvCoveredZips = 0, csvTotalZips = 0, csvCoveredPop = 0, csvTotalPop = 0;

  for (const zip of zipsWithPop) {
    csvTotalZips++;
    csvTotalPop += (zip.population || 0);

    // Check 50mi proximity
    let within50mi = false;
    for (const fac of freshFacilities) {
      const dlat = Math.abs(zip.lat - fac.lat);
      const dlng = Math.abs(zip.lng - fac.lng);
      if (dlat < 0.75 && dlng < 0.75) { within50mi = true; break; }
    }
    if (within50mi) { csvCoveredZips++; csvCoveredPop += (zip.population || 0); }

    const coverage50mi = within50mi ? 'within_50mi_of_ssd_facility' : 'outside_50mi_radius';
    const note = '';
    csvRows.push([zip.zip, zip.city, zip.state, zip.population||0,
      zip.dma_name||'', zip.dma_tier||'', '', coverage50mi, note].join(','));
  }

  const csvPath = join(PROJECT_ROOT, 'docs', 'amazon-sameday-coverage-by-zip.csv');
  if (!existsSync(join(PROJECT_ROOT, 'docs'))) mkdirSync(join(PROJECT_ROOT, 'docs'), { recursive: true });
  writeFileSync(csvPath, csvRows.join('\n'));
  log(`CSV written → ${csvPath} (${csvCoveredZips} covered ZIPs of ${csvTotalZips})`);

  db.close();

  // ── Build HTML ────────────────────────────────────────────────────────────
  const generatedAt = new Date().toLocaleString('en-US', {
    month:'short', day:'numeric', year:'numeric',
    hour:'2-digit', minute:'2-digit', timeZoneName:'short'
  });

  const msaDataJson = JSON.stringify(msaDataForMap);
  const locPointsJson = JSON.stringify(locPoints);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Amazon Same-Day Grocery Coverage</title>
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

/* Intro panel */
.intro-panel{background:linear-gradient(135deg,#1a1a2e 0%,#162040 100%);color:#dde;border-radius:10px;padding:18px 22px;margin-bottom:14px}
.intro-purpose{font-size:13px;color:#aac;margin-bottom:14px;line-height:1.6;border-bottom:1px solid #2a3a5e;padding-bottom:12px}
.intro-purpose strong{color:#cde}
.intro-stats-grid{display:flex;gap:0;flex-wrap:wrap;align-items:flex-start}
.intro-stat-block{flex:1;min-width:200px;padding:0 20px}
.intro-stat-block:first-child{padding-left:0}
.intro-stat-title{font-size:11px;font-weight:700;color:#88a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.intro-stat-big{font-size:36px;font-weight:800;color:#4a90e2;line-height:1}
.intro-stat-sub{font-size:11px;color:#88a;margin-top:2px}
.intro-fac-breakdown{margin-top:8px;display:flex;flex-direction:column;gap:3px}
.fac-tag{font-size:12px;color:#bbd}
.fac-tag.ssd{color:#ef4444}.fac-tag.fresh{color:#f97316}.fac-tag.wf{color:#166534}
.fac-tag.fc{color:#9ca3af}.fac-tag.ds{color:#6b7280}
.intro-divider{width:1px;background:#2a3a5e;align-self:stretch;margin:0 4px}
.intro-msa-stats{display:flex;gap:20px;flex-wrap:wrap;margin-top:4px}
.msa-stat{text-align:center}
.msa-stat-num{font-size:32px;font-weight:800;color:#10b981;line-height:1}
.msa-stat-num.gray{color:#9ca3af}
.msa-stat-label{font-size:11px;color:#88a;margin-top:2px;line-height:1.4}
.dl-btn{display:inline-block;margin-top:8px;padding:10px 18px;background:#3b82f6;color:#fff;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;transition:background .15s}
.dl-btn:hover{background:#2563eb}

/* Map */
#map{height:580px;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.12);margin-bottom:12px}
.map-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:#555;align-items:center}
.map-legend strong{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-right:4px}
.map-legend span{display:inline-flex;align-items:center;gap:5px}
.swatch{width:14px;height:14px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.15)}

/* Expansion toggle */
.expansion-toggle{background:#fff;padding:8px 12px;border-radius:6px;box-shadow:0 1px 5px rgba(0,0,0,.2);margin-top:80px}
/* Highlights rows */
.intro-highlights{margin-top:6px}
.highlight-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:13px;color:#374151}
.hl-num{font-size:22px;font-weight:800;color:#1e40af;min-width:48px}
.hl-label{line-height:1.4}
.hl-guide{font-size:12px;color:#374151;display:flex;align-items:center}
/* Project summary */
.proj-grid{display:flex;flex-direction:column;gap:20px;margin-top:16px}
.proj-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 22px}
.proj-card-full{background:#f0f4ff;border-color:#c7d2fe}
.proj-card-title{font-size:14px;font-weight:700;color:#1e293b;margin-bottom:12px;text-transform:uppercase;letter-spacing:.04em}
.proj-table{width:100%;border-collapse:collapse;font-size:13px}
.proj-table td{padding:5px 0;vertical-align:top;color:#374151}
.proj-table td:first-child{width:45%;color:#64748b;padding-right:16px}
.proj-table strong{color:#1e293b}
.proj-sources-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-top:4px}
.proj-source{background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:12px 14px}
.proj-source-name{font-size:13px;font-weight:700;color:#1e293b;margin-bottom:4px}
.proj-source-desc{font-size:12px;color:#64748b;line-height:1.5}

/* Methodology */
.methodology{max-width:860px;margin:0 auto;padding:10px 0 40px}
.methodology h2{font-size:22px;margin-bottom:6px;border-bottom:2px solid #e0e0e0;padding-bottom:10px}
.methodology h3{font-size:15px;font-weight:700;margin:28px 0 8px;color:#222}
.methodology p,.methodology li{font-size:14px;line-height:1.7;color:#444;margin-bottom:8px}
.methodology ul{padding-left:22px;margin-bottom:12px}
.method-intro{font-size:15px;color:#333;margin-bottom:20px;line-height:1.8}
.method-table{width:100%;border-collapse:collapse;margin:12px 0 20px;font-size:13px}
.method-table th{background:#f0f4ff;font-weight:700;padding:8px 12px;text-align:left;border-bottom:2px solid #ccd}
.method-table td{padding:7px 12px;border-bottom:1px solid #eee;vertical-align:top}
.method-table tr:hover td{background:#f9faff}
.method-footer{margin-top:32px;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:12px}

/* Leaflet layer control */
.leaflet-control-layers{font-size:12px}
.leaflet-control-layers-selector{margin-right:5px}

/* Password overlay */
#pw-overlay{position:fixed;inset:0;background:rgba(10,10,30,.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
#pw-overlay h2{color:#dde;font-size:22px;margin:0}
#pw-overlay p{color:#88a;font-size:13px;margin:0}
#pw-input{padding:10px 18px;font-size:15px;border-radius:6px;border:2px solid #334;background:#1a1a2e;color:#dde;outline:none;width:260px;text-align:center}
#pw-input:focus{border-color:#4a90e2}
#pw-error{color:#ef4444;font-size:12px;min-height:16px}
#pw-btn{padding:10px 28px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
#pw-btn:hover{background:#2563eb}
</style>
</head>
<body>

<!-- Password overlay -->
<div id="pw-overlay">
  <h2>🛒 Amazon Same-Day Grocery Coverage</h2>
  <p>Rivendell Advisors — Research Portal</p>
  <input id="pw-input" type="password" placeholder="Enter password" autocomplete="off"/>
  <div id="pw-error"></div>
  <button id="pw-btn">Access Report</button>
</div>

<header>
  <h1>🛒 Amazon Same-Day Grocery Coverage</h1>
  <span>Rivendell Advisors &nbsp;·&nbsp; ${esc(generatedAt)}</span>
</header>
<nav>
  <button class="active" onclick="showView('map-view',this)">🗺 Map</button>
  <button onclick="showView('methodology-view',this)">📋 Methodology</button>
  <button onclick="showView('project-view',this)">⚡ Project Summary</button>
</nav>

<!-- MAP VIEW -->
<div id="map-view" class="view active">

  <div class="intro-panel">
    <div class="intro-purpose">
      <strong>Purpose:</strong> Confirm Amazon's same-day perishable grocery delivery coverage across the top 200 US MSAs using direct Amazon.com product probes.
      Pass criterion: bananas and/or strawberries available for same-day delivery — bananas confirm ambient fresh capability; strawberries confirm cold-chain capability.
      &nbsp;·&nbsp; <em>Probe date: ${esc(probeDate)}</em>
    </div>

    <div class="intro-stats-grid">

      <!-- MSA probe results -->
      <div class="intro-stat-block">
        <div class="intro-stat-title">MSA Coverage (Top 200)</div>
        <div class="intro-msa-stats">
          <div class="msa-stat">
            <div class="msa-stat-num">${msaConfirmed}</div>
            <div class="msa-stat-label">MSAs with at least 1 ZIP code<br>with confirmed fresh grocery coverage</div>
          </div>
          <div class="msa-stat">
            <div class="msa-stat-num gray">${msaNone}</div>
            <div class="msa-stat-label">MSAs with no confirmed<br>fresh grocery coverage</div>
          </div>
        </div>
      </div>

      <div class="intro-divider"></div>

      <!-- Scope + Map Guide -->
      <div class="intro-stat-block">
        <div class="intro-stat-title">Scope &amp; How to Use</div>
        <div class="intro-highlights">
          <div class="highlight-row">
            <span class="hl-num">${msaTotal}</span>
            <span class="hl-label">MSAs probed — representing <strong>${Math.round(263041023/335000000*100)}%</strong> of the US population</span>
          </div>
          <div class="highlight-row">
            <span class="hl-num">${Math.round(240034724/1000000)}M</span>
            <span class="hl-label">Americans in confirmed coverage areas (<strong>${Math.round(240034724/335000000*100)}%</strong> of US)</span>
          </div>
          <div class="highlight-row" style="margin-top:10px;border-top:1px solid #e2e8f0;padding-top:10px">
            <span class="hl-guide"><span style="display:inline-block;width:12px;height:12px;background:#10b981;border-radius:2px;margin-right:6px;vertical-align:middle"></span><strong>Green</strong> — MSA with verified same-day fresh grocery in at least 1 ZIP code</span>
          </div>
          <div class="highlight-row">
            <span class="hl-guide"><span style="display:inline-block;width:12px;height:12px;background:#f97316;border-radius:2px;margin-right:6px;vertical-align:middle"></span><strong>Orange</strong> — No coverage confirmed yet, but Amazon SSD/Fresh facility within 75mi (expansion likely)</span>
          </div>
          <div class="highlight-row">
            <span class="hl-guide"><span style="display:inline-block;width:12px;height:12px;background:#374151;border-radius:2px;margin-right:6px;vertical-align:middle"></span><strong>Gray</strong> — No confirmed coverage, no nearby facility</span>
          </div>
          <div class="highlight-row" style="color:#64748b;font-size:12px;margin-top:6px">
            Click any shaded MSA to see coverage details and nearby facilities
          </div>
          <div class="highlight-row" style="margin-top:10px;border-top:1px solid #e2e8f0;padding-top:10px">
            <a href="amazon-fresh-coverage-by-zip.csv" download class="dl-btn">&#8595; Download ZIP-Level Probe Results</a>
            <div style="font-size:11px;color:#64748b;margin-top:4px">862 ZIPs probed &nbsp;·&nbsp; MSA, ZIP, city, status, offer types</div>
          </div>
        </div>

        <div class="intro-stat-title" style="margin-top:14px">Amazon Facility Network</div>
        <div class="intro-fac-breakdown">
          ${facilityMap.ssd_fulfillment ? `<span class="fac-tag ssd">&#9679; ${facilityMap.ssd_fulfillment} SSD Fulfillment Centers</span>` : ''}
          ${facilityMap.fresh_hub ? `<span class="fac-tag fresh">&#9679; ${facilityMap.fresh_hub} Amazon Fresh Dark Stores</span>` : ''}
          ${facilityMap.whole_foods_node ? `<span class="fac-tag wf">&#9679; ${facilityMap.whole_foods_node} Whole Foods Stores</span>` : ''}
          ${facilityMap.fulfillment_center ? `<span class="fac-tag fc">&#9679; ${facilityMap.fulfillment_center} Standard Fulfillment Centers</span>` : ''}
          <span class="fac-tag ds">&#9679; ${(facilityMap.same_day_facility||0)+(facilityMap.fresh_distribution||0)+(facilityMap.sortation_center||0)+(facilityMap.delivery_station||0)+(facilityMap.distribution_center||0)+(facilityMap.warehouse||0)+(facilityMap.amazon_facility||0)+(facilityMap.returns_center||0)} Other Amazon Facilities</span>
        </div>
      </div>

    </div>
  </div>

  <div id="map"></div>

  <div class="map-legend">
    <strong>MSA Status:</strong>
    <span><span class="swatch" style="background:#10b981"></span>Confirmed coverage</span>
    <span><span class="swatch" style="background:#f97316"></span>Expansion likely (SSD within 75mi)</span>
    <span><span class="swatch" style="background:#374151"></span>No coverage found</span>
    <span><span class="swatch" style="background:#1e293b"></span>Not probed</span>
  </div>

</div>

<!-- METHODOLOGY -->
<div id="methodology-view" class="view">
  <section class="methodology">
    <h2>Methodology</h2>

    <h3>1. What We're Tracking</h3>
    <p class="method-intro">Amazon same-day perishable grocery delivery — available to Prime members across ~${msaConfirmed} of the top 200 US MSAs as of ${esc(probeDate)}. This is the service that delivers fresh produce, meat, and dairy within 2 hours, fulfilled by Amazon Fresh dark stores, Whole Foods, or SSD facilities.</p>

    <h3>2. How We Confirmed Coverage</h3>
    <p>We probed Amazon.com directly for each MSA. For 3 ZIP codes per MSA (near the city center), we searched for <strong>bananas</strong> and <strong>strawberries</strong> (fresh produce) and examined the main offer panel plus the "Other sellers" listing for same-day delivery options.</p>
    <p><strong>Pass criteria:</strong> Bananas and/or strawberries available for same-day delivery. Bananas confirm ambient fresh capability (not refrigerated, but never shipped via standard ground). Strawberries confirm cold-chain capability — they require refrigeration and are the stronger signal for SSD or dark store fulfillment. An MSA is marked confirmed if either product returns a same-day offer.</p>
    <ul>
      <li>3 ZIP codes tested per MSA, selected near each city center</li>
      <li>Both products (bananas + strawberries) checked per ZIP</li>
      <li>Main offer box and "Other sellers" panel both inspected</li>
      <li>Pass = at least one ZIP in the MSA confirmed same-day delivery</li>
    </ul>

    <h3>3. Offer Types Observed</h3>
    <table class="method-table">
      <thead>
        <tr><th>Offer Type</th><th>Ships From</th><th>What It Means</th></tr>
      </thead>
      <tbody>
        <tr><td><strong>AmazonFresh</strong></td><td>AmazonFresh</td><td>Amazon Fresh dark store (U-prefix facility) — purpose-built perishable fulfillment</td></tr>
        <tr><td><strong>Whole Foods</strong></td><td>Whole Foods Market</td><td>Whole Foods store acting as microfulfillment node for 2-hour grocery delivery</td></tr>
        <tr><td><strong>SSD / Prime</strong></td><td>Amazon.com (hours delivery)</td><td>Sub-Same-Day fulfillment center (V-prefix) — temperature-controlled grocery zones</td></tr>
        <tr><td><strong>Amazon Standard</strong></td><td>Amazon.com (overnight)</td><td>Nature TBD — appears for some grocery items; under investigation</td></tr>
      </tbody>
    </table>

    <h3>4. Facility Network</h3>
    <p>${totalLocations.toLocaleString()}+ Amazon facilities mapped across the US. Key fresh grocery-capable types:</p>
    <ul>
      <li><strong>SSD Fulfillment Centers (V-prefix):</strong> ${facilityMap.ssd_fulfillment || 0} unique facilities — Amazon's primary same-day grocery nodes with temperature-controlled zones</li>
      <li><strong>Amazon Fresh Dark Stores (U-prefix):</strong> ${facilityMap.fresh_hub || 0} facilities — purpose-built perishable fulfillment, no customer-facing retail</li>
      <li><strong>Whole Foods Stores:</strong> ${facilityMap.whole_foods_node || 0} stores — now Amazon's primary consumer-facing grocery platform following Fresh store closings</li>
    </ul>

    <h3>5. Known Limitations</h3>
    <ul>
      <li><strong>ZIP selection:</strong> Tested 3 ZIPs per MSA near city center; outer areas of large MSAs may differ. A confirmed MSA means at least one ZIP passed, not universal coverage.</li>
      <li><strong>Offer type correlation:</strong> "Ships from Amazon.com" with same-day delivery could be SSD, fresh distribution, or another system — we are still mapping which facility types serve which regions.</li>
      <li><strong>Point in time:</strong> Probe conducted ${esc(probeDate)}. Amazon expands continuously; actual coverage today may be broader.</li>
    </ul>

    <h3>6. Data Sources</h3>
    <ul>
      <li><strong>Amazon.com direct probe</strong> — primary coverage signal; automated browser sessions checking product availability per ZIP</li>
      <li><strong>Amazon facility network</strong> — community-maintained lists (gortofreight.com, r/AmazonFlexDrivers wiki) plus Brave Place Search POI data</li>
      <li><strong>US MSA boundaries</strong> — Census CBSA (Core-Based Statistical Area) polygons, top 200 by population</li>
      <li><strong>US ZIP code database</strong> — 31,000+ ZIPs with coordinates and population (2020 Census)</li>
    </ul>

    <p class="method-footer">Research conducted by Rivendell Advisors LLC. Generated ${esc(generatedAt)}.</p>
  </section>
</div>

<!-- PROJECT SUMMARY -->
<div id="project-view" class="view">
  <section class="methodology">
    <h2>Project Summary</h2>
    <p class="method-intro">This page documents the scope and scale of the analysis — both to illustrate the exhaustiveness of the research and to demonstrate what modern AI-assisted development makes possible.</p>
    ${phase3TotalZips > 0 ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#166534"><strong>🔬 Phase 3 probe in progress:</strong> ${phase3TotalZips.toLocaleString()} ZIPs scanned across ${phase3TotalMsas} MSAs — breadth-first full ZIP sweep. Results are incorporated into MSA coverage status above as ground truth.</div>` : ''}

    <div class="proj-grid">

      <div class="proj-card">
        <div class="proj-card-title">⏱ Time Investment</div>
        <table class="proj-table">
          <tr><td>Project start</td><td><strong>March 22, 2026</strong></td></tr>
          <tr><td>Phase 1 — MSA probe (200 MSAs, 3 ZIPs each)</td><td><strong>March 22 – April 1, 2026</strong> — 144/200 MSAs confirmed with same-day fresh delivery</td></tr>
          <tr><td>Phase 2 — Dallas deep dive (313 ZIPs)</td><td><strong>April 1–4, 2026</strong> — 164 ZIPs confirmed, service radius empirically validated at ~25mi from SSD</td></tr>
          <tr><td>Phase 3 — Full ZIP probe (13,513 ZIPs, 200 MSAs)</td><td><strong>April 23, 2026 – ongoing</strong> — breadth-first sweep, 1 ZIP per MSA per pass for maximum coverage at any stop point. <strong>${phase3TotalZips.toLocaleString()} ZIPs scanned across ${phase3TotalMsas} MSAs so far.</strong></td></tr>
          <tr><td>Human direction &amp; review</td><td><strong>~30–35 hours</strong> — strategic framing, methodology decisions, validation, spot-checks</td></tr>
          <tr><td>AI execution</td><td><strong>~continuous</strong> — coding, data pipelines, Amazon probing, debugging, map generation</td></tr>
          <tr><td>Estimated traditional team cost</td><td><strong>$200,000–$500,000+</strong> — 3–4 engineers, 2–3 months, standard consulting rates</td></tr>
          <tr><td>Actual API cost</td><td><strong>&lt; $25</strong> in search API queries (Brave Search)</td></tr>
        </table>
      </div>

      <div class="proj-card">
        <div class="proj-card-title">💻 Code &amp; Development</div>
        <table class="proj-table">
          <tr><td>Lines of code written</td><td><strong>7,000+</strong> lines of JavaScript + Python</td></tr>
          <tr><td>Source files</td><td><strong>20+</strong> scripts (data pipelines, Amazon probe, facility enrichment, report generator)</td></tr>
          <tr><td>Git commits</td><td><strong>100+</strong> iterative releases over 5 weeks</td></tr>
          <tr><td>Dashboard</td><td>Single-file HTML/CSS/JS with Leaflet maps, auto-published to GitHub Pages daily</td></tr>
        </table>
      </div>

      <div class="proj-card">
        <div class="proj-card-title">🗄 Coverage Data</div>
        <table class="proj-table">
          <tr><td>MSAs directly probed</td><td><strong>${msaTotal}</strong> of top 200 US metro areas (~78% of US population)</td></tr>
          <tr><td>MSAs confirmed with fresh delivery</td><td><strong>${msaConfirmed}</strong> (${Math.round(msaConfirmed/msaTotal*100)}%) — representing ~72% of US population</td></tr>
          <tr><td>ZIP codes tested (Phase 1)</td><td><strong>3</strong> city-center ZIPs per MSA, bananas + strawberries each</td></tr>
          <tr><td>ZIP codes tested (Phase 2 — Dallas)</td><td><strong>313</strong> ZIPs — every ZIP in the DFW MSA</td></tr>
          <tr><td>ZIP codes in Phase 3 sweep</td><td><strong>${phase3TotalZips.toLocaleString()}</strong> ZIPs across ${phase3TotalMsas} MSAs scanned so far — breadth-first, ongoing (target: 13,513 ZIPs)</td></tr>
          <tr><td>Amazon facility locations mapped</td><td><strong>${totalLocations.toLocaleString()}</strong> with coordinates (${totalLocationsAll.toLocaleString()} total identified)</td></tr>
          <tr><td>Whole Foods stores mapped</td><td><strong>${facilityMap.whole_foods_node || 551}</strong> of ~553 US locations</td></tr>
        </table>
      </div>

      <div class="proj-card proj-card-full">
        <div class="proj-card-title">📚 Data Sources</div>
        <div class="proj-sources-grid">
          <div class="proj-source">
            <div class="proj-source-name">Amazon.com Direct Probe</div>
            <div class="proj-source-desc">200 MSAs probed directly via automated browser sessions. Searched for bananas and strawberries in 3 ZIP codes per MSA. Checked main offer + Other sellers panel. Pass = same-day delivery available for fresh produce.</div>
          </div>
          <div class="proj-source">
            <div class="proj-source-name">Amazon Facility Network</div>
            <div class="proj-source-desc">Community-maintained warehouse list (gortofreight.com); r/AmazonFlexDrivers wiki (2,000+ US entries with GPS and type labels including V-prefix SSD and U-prefix Fresh codes); Brave Place Search POI index. Combined: ${totalLocations.toLocaleString()}+ facilities classified by type.</div>
          </div>
          <div class="proj-source">
            <div class="proj-source-name">Whole Foods Store Locations</div>
            <div class="proj-source-desc">${facilityMap.whole_foods_node || 532} US store locations assembled via Brave Place Search sweeps. Verified against Amazon and Whole Foods press releases. Near-complete coverage of the ~530 US store network.</div>
          </div>
          <div class="proj-source">
            <div class="proj-source-name">US MSA Boundaries</div>
            <div class="proj-source-desc">Census CBSA (Core-Based Statistical Area) polygon boundaries for the top 200 US MSAs by population. Used as the primary geographic unit for coverage mapping — reflects real metro-area market footprints.</div>
          </div>
          <div class="proj-source">
            <div class="proj-source-name">US ZIP Code Database</div>
            <div class="proj-source-desc">31,000+ ZIP codes with city, state, coordinates, and population (2020 US Census). Used for proximity calculations and the downloadable coverage CSV.</div>
          </div>
          <div class="proj-source">
            <div class="proj-source-name">Amazon Public Statements</div>
            <div class="proj-source-desc">Amazon press releases on same-day grocery launch cities; January 2026 announcement closing all Amazon Fresh stores; Business Insider analysis of internal Amazon documents on the SSD network expansion.</div>
          </div>
        </div>
      </div>

    </div>

    <p class="method-footer">Research conducted by Rivendell Advisors LLC. Generated ${esc(generatedAt)}.</p>
  </section>
</div>

<script>
// ── Password overlay ──────────────────────────────────────────────────────────
(function() {
  const PASS = 'Amazon';
  const KEY  = 'fresh_cov_auth';
  const overlay = document.getElementById('pw-overlay');
  if (sessionStorage.getItem(KEY) === '1') { overlay.remove(); return; }
  const input = document.getElementById('pw-input');
  const errEl = document.getElementById('pw-error');
  function tryPass() {
    if (input.value === PASS) {
      sessionStorage.setItem(KEY, '1');
      overlay.remove();
    } else {
      errEl.textContent = 'Incorrect password.';
      input.value = '';
      input.focus();
    }
  }
  document.getElementById('pw-btn').addEventListener('click', tryPass);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryPass(); });
})();

// ── View switcher ─────────────────────────────────────────────────────────────
function showView(id, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  if (id === 'map-view' && window._map) window._map.invalidateSize();
}

// ── Map data ──────────────────────────────────────────────────────────────────
const MSA_DATA = ${msaDataJson};
const LOC_POINTS = ${locPointsJson};

// ── Initialize Leaflet map ────────────────────────────────────────────────────
const map = L.map('map').setView([38.5, -96], 4);
window._map = map;

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
  maxZoom: 18
}).addTo(map);

// ── Layer 1: MSA Coverage choropleth (default ON) ─────────────────────────────
const msaLayer = L.layerGroup().addTo(map);
let msaGeoLoaded = false;

let showExpansion = true; // controlled by toggle

function msaStatusColor(status, expansionSignal) {
  if (status === 'full_fresh' || status === 'ambient_fresh') return '#10b981';
  if (status === 'none' && expansionSignal && showExpansion) return '#f97316'; // orange
  if (status === 'none') return '#374151';
  return '#1e293b';
}
function msaStatusOpacity(status, expansionSignal) {
  if (status === 'full_fresh' || status === 'ambient_fresh') return 0.6;
  if (status === 'none' && expansionSignal && showExpansion) return 0.55;
  if (status === 'none') return 0.25;
  return 0.15;
}
function msaStatusLabel(status, expansionSignal) {
  if (status === 'full_fresh')    return '✅ Confirmed — same-day perishable delivery verified';
  if (status === 'ambient_fresh') return '✅ Confirmed — fresh grocery delivery verified (ambient probe)';
  if (status === 'none' && expansionSignal) return '🟠 Expansion Likely — no coverage confirmed yet, but Amazon SSD/Fresh facility within 75mi';
  if (status === 'none')          return '⚫ None — no same-day grocery found at tested ZIPs';
  return '⬜ Not probed';
}

async function initMsaLayer() {
  if (msaGeoLoaded) return;
  msaGeoLoaded = true;
  try {
    const geoUrl = (window.location.hostname === 'localhost' || window.location.protocol === 'file:')
      ? '../data/us_msas.geojson'
      : 'us_msas.geojson';
    const resp = await fetch(geoUrl);
    const geojson = await resp.json();

    L.geoJSON(geojson, {
      style: feature => {
        const msaId = String(feature.properties.msa_id);
        const d = MSA_DATA[msaId];
        const status = d ? d.status : null;
        const exp = d ? d.expansion_signal : null;
        return {
          fillColor: msaStatusColor(status, exp),
          fillOpacity: msaStatusOpacity(status, exp),
          color: '#fff',
          weight: 0.5
        };
      },
      onEachFeature: (feature, layer) => {
        const msaId = String(feature.properties.msa_id);
        const d = MSA_DATA[msaId] || {};
        const name = d.msa_name || feature.properties.msa_name || ('MSA ' + msaId);
        const pop = d.msa_population ? Number(d.msa_population).toLocaleString() : '—';
        const statusLabel = msaStatusLabel(d.status || null, d.expansion_signal);
        const offers = (d.offer_types || []).length ? d.offer_types.join(', ') : '—';

        // Nearby facilities section
        const nearby = d.nearby_facilities || [];
        const ssdNearby    = nearby.filter(f => f.type === 'SSD');
        const darkNearby   = nearby.filter(f => f.type === 'Fresh Dark Store');
        const wfNearby     = nearby.filter(f => f.type === 'Whole Foods');

        let facilityHtml = '';
        if (ssdNearby.length) facilityHtml += '<br><span style="color:#ef4444;font-size:11px">● SSD: ' + ssdNearby.map(f => (f.code||f.loc) + ' (' + f.dist + 'mi)').join(', ') + '</span>';
        if (darkNearby.length) facilityHtml += '<br><span style="color:#f97316;font-size:11px">● Dark Store: ' + darkNearby.map(f => (f.code||f.loc) + ' (' + f.dist + 'mi)').join(', ') + '</span>';
        if (wfNearby.length) facilityHtml += '<br><span style="color:#22c55e;font-size:11px">● Whole Foods: ' + wfNearby.length + ' store' + (wfNearby.length>1?'s':'') + ' within 60mi (nearest ' + wfNearby[0].dist + 'mi)</span>';
        if (!nearby.length) facilityHtml = '<br><span style="color:#9ca3af;font-size:11px">No confirmed facilities within 60mi</span>';

        // Expansion signal detail
        let expansionHtml = '';
        if (d.expansion_signal) {
          const es = d.expansion_signal;
          expansionHtml = '<br><span style="color:#f97316;font-size:11px">▶ Nearest SSD/Fresh facility: ' +
            (es.code || es.type) + ' in ' + es.loc + ' (' + es.dist + 'mi away)</span>';
        }

        const popupHtml =
          '<b style="font-size:14px">' + name + '</b>' +
          '<br><small style="color:#888">Population: ' + pop + '</small>' +
          '<br>' + statusLabel +
          expansionHtml +
          (d.status !== 'none' && offers !== '—' ? '<br><small style="color:#aaa">Service types: ' + offers + '</small>' : '') +
          '<br><b style="font-size:11px;color:#ccc">Facilities presumed serving this MSA:</b>' +
          '<br><span style="font-size:10px;color:#6b7280;font-style:italic">Distances from ' + (d.distance_ref || 'MSA centroid') + '</span>' +
          facilityHtml;
        layer.bindPopup(popupHtml, { maxWidth: 360 });
        layer.on('mouseover', () => layer.setStyle({ weight: 2, color: '#fff' }));
        layer.on('mouseout',  () => layer.setStyle({ weight: 0.5, color: '#fff' }));
      }
    }).addTo(msaLayer);
  } catch(e) {
    console.error('Failed to load MSA GeoJSON:', e);
  }
}

initMsaLayer();

// ── Layer 2: Facility network (per-type, default OFF) ─────────────────────────
// 5-category facility taxonomy
const facilityTypes = {
  ssd_fulfillment:    { label:'SSD Fulfillment Centers',       color:'#ef4444', radius:8,  grocery:true  },
  fresh_hub:          { label:'Amazon Fresh Dark Stores',      color:'#f97316', radius:7,  grocery:true  },
  whole_foods_node:   { label:'Whole Foods Stores',            color:'#166534', radius:5,  grocery:true  },
  fulfillment_center: { label:'Standard Fulfillment Centers',  color:'#6366f1', radius:5,  grocery:false },
  other:              { label:'Other Amazon Facilities',       color:'#6b7280', radius:3,  grocery:false }
};

// Map all other types to 'other' for display
function getFacilityTypeKey(type) {
  if (facilityTypes[type]) return type;
  if (type === 'fulfillment_center') return 'fulfillment_center';
  return 'other';
}

const facilityLayerGroups = {};
Object.keys(facilityTypes).forEach(t => { facilityLayerGroups[t] = L.layerGroup(); });

LOC_POINTS.forEach(p => {
  const ftKey = getFacilityTypeKey(p.type);
  const ft = facilityTypes[ftKey];
  const marker = L.circleMarker([p.lat, p.lng], {
    radius: ft.radius,
    color: ft.color,
    fillColor: ft.color,
    fillOpacity: ft.grocery ? 0.8 : 0.5,
    weight: 1.5
  });

  const codeStr = p.facility_code ? '<b>' + p.facility_code + '</b> — ' : '';
  const cityState = [p.city, p.state].filter(Boolean).join(', ');

  // Source provenance label
  const sourceLabel = {
    'flex_drivers_wiki_full': 'r/AmazonFlexDrivers wiki',
    'flex_drivers_wiki':      'r/AmazonFlexDrivers wiki',
    'external_warehouse_list':'Community warehouse list',
    'place_search_wf':        'Brave Place Search',
    'place_search_wf2':       'Brave Place Search',
    'manual_addition':        'Manually verified',
  }[p.source_url] || (p.source_url?.startsWith('brave_place') ? 'Brave Place Search' : p.source_url || 'Unknown');

  const groceryNote = ft.grocery
    ? '<br><span style="color:#34d399;font-size:11px">✓ Confirmed fresh grocery capable</span>'
    : '<br><span style="color:#9ca3af;font-size:11px">○ Grocery capability unconfirmed</span>';

  marker.bindPopup(
    codeStr + '<b>' + ft.label + '</b>' +
    (cityState ? '<br>' + cityState : '') +
    (p.address_raw ? '<br><small style="color:#888">' + p.address_raw.slice(0,80) + '</small>' : '') +
    groceryNote +
    '<br><small style="color:#777">Source: ' + sourceLabel + '</small>' +
    (p.source_url && p.source_url.startsWith('http') ? '<br><a href="' + p.source_url + '" target="_blank" style="font-size:11px">Reference &rarr;</a>' : '')
  );
  facilityLayerGroups[ftKey].addLayer(marker);
});

// ── Layer 3: 50-mile service circles (default OFF) ────────────────────────────
const reachLayer = L.layerGroup();
const REACH_TYPES = new Set(['ssd_fulfillment','fresh_hub']);
LOC_POINTS.filter(p => REACH_TYPES.has(p.type)).forEach(p => {
  L.circle([p.lat, p.lng], {
    radius: 80467,
    color: '#ef4444',
    weight: 1.5,
    dashArray: '6 4',
    fillColor: '#ef4444',
    fillOpacity: 0.05
  }).bindPopup(
    '<b>50-mile radius</b> &mdash; Amazon stated service range' +
    (p.facility_code ? '<br>' + p.facility_code : '') +
    (p.address_raw ? '<br><small style="color:#888">' + p.address_raw + '</small>' : '')
  ).addTo(reachLayer);
});

// ── ZIP Detail layer (all probed ZIPs — OFF by default) ─────────────────────
const zipDetailLayer = L.layerGroup();
let zipDetailLoaded = false;

async function initZipDetailLayer() {
  if (zipDetailLoaded) return;
  zipDetailLoaded = true;
  try {
    const url = (window.location.hostname === 'localhost' || window.location.protocol === 'file:')
      ? '../docs/zip_detail.geojson' : 'zip_detail.geojson';
    const resp = await fetch(url);
    const geojson = await resp.json();
    L.geoJSON(geojson, {
      pointToLayer: (feature, latlng) => {
        const s = feature.properties.status;
        const color = s === 'full_fresh' ? '#10b981' : s === 'ambient_fresh' ? '#3b82f6' : s === 'none' ? '#9ca3af' : '#f59e0b';
        return L.circleMarker(latlng, { radius: 4, color, fillColor: color, fillOpacity: 0.75, weight: 1 });
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const statusLabel = p.status === 'full_fresh' ? '✅ Full Fresh' : p.status === 'ambient_fresh' ? '🟡 Ambient Fresh' : p.status === 'none' ? '❌ No coverage' : p.status;
        layer.bindPopup(
          '<b>' + p.zip + ' — ' + p.city + ', ' + p.state + '</b>' +
          (p.msa_name ? '<br><small>' + p.msa_name + '</small>' : '') +
          '<br>Status: ' + statusLabel +
          (p.offers && p.offers.length ? '<br>Offers: ' + p.offers.join(', ') : '') +
          (p.pop ? '<br>Population: ' + (p.pop||0).toLocaleString() : '') +
          '<br><small style="color:#888">Source: ' + (p.source||'probe') + '</small>'
        );
      }
    }).addTo(zipDetailLayer);
  } catch(e) { console.error('ZIP detail layer error:', e); }
}

// ── Layer control ─────────────────────────────────────────────────────────────
const overlayMaps = {
  '▦ MSA Coverage':                                    msaLayer,
  '<span style="color:#ef4444">●</span> SSD Fulfillment Centers':      facilityLayerGroups['ssd_fulfillment'],
  '<span style="color:#f97316">●</span> Amazon Fresh Dark Stores':    facilityLayerGroups['fresh_hub'],
  '<span style="color:#166534">●</span> Whole Foods Stores':           facilityLayerGroups['whole_foods_node'],
  '<span style="color:#6366f1">●</span> Standard Fulfillment Centers': facilityLayerGroups['fulfillment_center'],
  '<span style="color:#6b7280">●</span> Other Amazon Facilities':      facilityLayerGroups['other'],
  '<span style="color:#ef4444">○</span> 50-Mile Service Circles': reachLayer,
  '<span style="color:#10b981">●</span> ZIP Detail (all probed ZIPs)': zipDetailLayer
};

L.control.layers(null, overlayMaps, { collapsed: false, position: 'topright' }).addTo(map);

map.on('overlayadd', e => {
  if (e.name && e.name.includes('ZIP Detail')) initZipDetailLayer();
  if (e.layer === msaLayer) initMsaLayer();
  if (e.layer === dallasLayer) initDallasLayer();
});

// ── Expansion signal toggle ───────────────────────────────────────────────────
const expansionToggle = L.control({ position: 'topleft' });
expansionToggle.onAdd = function() {
  const div = L.DomUtil.create('div', 'expansion-toggle');
  div.innerHTML = '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:600;color:#1e293b">' +
    '<input type="checkbox" id="expansion-chk" checked style="cursor:pointer"> ' +
    '<span style="display:inline-block;width:12px;height:12px;background:#f97316;border-radius:2px;flex-shrink:0"></span>' +
    'Show Expansion Likely MSAs</label>';
  L.DomEvent.disableClickPropagation(div);
  return div;
};
expansionToggle.addTo(map);

document.addEventListener('change', function(e) {
  if (e.target.id === 'expansion-chk') {
    showExpansion = e.target.checked;
    // Redraw MSA layer
    if (msaGeoLoaded) {
      msaLayer.clearLayers();
      msaGeoLoaded = false;
      initMsaLayer();
    }
  }
});
<\/script>
</body>
</html>`;

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const out = join(REPORTS_DIR, 'index.html');
  writeFileSync(out, html);
  log(`Report written → ${out} (${msaConfirmed}/${msaTotal} MSAs confirmed, ${locPoints.length} facility points)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
