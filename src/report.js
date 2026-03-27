/**
 * report.js — Generate reports/index.html with 4-layer Leaflet coverage map
 *
 * Layers:
 *  1. Facility network (toggleable per type)
 *  2. DMA boundaries choropleth (toggleable)
 *  3. Confirmed cities (toggleable)
 *  4. 50-mile service reach circles (toggleable, default OFF)
 *
 * Usage: node src/report.js
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'coverage.db');
const REPORTS_DIR = join(PROJECT_ROOT, 'reports');

const STATE_FIPS = {
  AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',DC:'11',FL:'12',
  GA:'13',HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',
  MD:'24',MA:'25',MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',
  NJ:'34',NM:'35',NY:'36',NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',
  SC:'45',SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56'
};

function log(msg) { console.log(`[report] ${new Date().toISOString()} ${msg}`); }
function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(unixTs) {
  if (!unixTs) return '—';
  return new Date(unixTs * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

/** Extract facility code from address_raw */
function extractFacilityCode(addr) {
  if (!addr) return null;
  // Match e.g. "DAL3 - 1234 Main St" or facility codes like VBX3, UAB7, etc.
  const dashMatch = addr.match(/^([A-Z][A-Z0-9]{2,5})\s*-\s*/);
  if (dashMatch) return dashMatch[1];
  const codeMatch = addr.match(/\b([A-Z][A-Z0-9]{2,5})\b/);
  return codeMatch ? codeMatch[1] : null;
}

/** Why a facility type is/isn't fresh-capable */
function facilityCapabilityNote(type) {
  switch (type) {
    case 'ssd_fulfillment':   return 'Primary grocery node — SSD facility with temperature-controlled zones';
    case 'fresh_hub':         return 'Amazon Fresh Online hub — dedicated perishable fulfillment';
    case 'whole_foods_node':  return 'Whole Foods store serving as microfulfillment node';
    case 'amazon_fresh_store':return 'Amazon Fresh store (closing) — may transition to online-only hub';
    case 'fresh_distribution':return 'Fresh distribution — likely grocery-capable';
    case 'same_day_facility': return 'Same-day facility — grocery capability unconfirmed';
    case 'fulfillment_center':return 'Standard fulfillment center — does not typically handle perishables';
    case 'delivery_station':  return 'Last-mile delivery station — not a fulfillment facility';
    case 'sortation_center':  return 'Sortation center — package routing, not grocery fulfillment';
    case 'distribution_center':return 'Distribution center — general logistics, not fresh-specific';
    default:                   return 'Amazon facility — grocery capability unconfirmed';
  }
}

function computeTimeline(db, retailers) {
  const byDate = db.prepare(`
    SELECT snapshot_date, retailer_id, total_cities_confirmed, total_cities_probed,
           total_signals, dmas_with_coverage
    FROM snapshot_totals
    WHERE retailer_id = 'amazon_same_day'
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

  const retailers = db.prepare("SELECT * FROM retailers WHERE id = 'amazon_same_day'").all();

  // ── Data queries ─────────────────────────────────────────────────────────────

  // Coverage rows for data table
  const coverageRows = db.prepare(`
    SELECT cc.city, cc.state, cc.available, cc.confidence, cc.source, cc.first_seen,
           cc.dma_id, d.name AS dma_name, d.tier,
           c.lat, c.lng,
           cc.retailer_id, r.name AS retailer_name,
           cc.source_url, cc.confidence_tier,
           cc.evidence_snippet, cc.evidence_query
    FROM city_coverage cc
    LEFT JOIN cities c ON c.city=cc.city AND c.state=cc.state
    LEFT JOIN dmas d ON d.id=cc.dma_id
    JOIN retailers r ON r.id=cc.retailer_id
    ORDER BY cc.state, cc.city
  `).all();

  // Map points — confirmed cities with coords
  const mapPoints = db.prepare(`
    SELECT cc.city, cc.state, cc.confidence_tier, cc.source, cc.source_url,
           cc.evidence_snippet, cc.first_seen, cc.dma_id,
           d.name AS dma_name,
           c.lat, c.lng
    FROM city_coverage cc
    LEFT JOIN cities c ON c.city=cc.city AND c.state=cc.state
    LEFT JOIN dmas d ON d.id=cc.dma_id
    WHERE cc.available=1 AND c.lat IS NOT NULL AND c.lng IS NOT NULL
    ORDER BY cc.state, cc.city
  `).all().map(r => ({
    lat: r.lat, lng: r.lng, city: r.city, state: r.state,
    dma_name: r.dma_name || null,
    confidence_tier: r.confidence_tier || 'verified',
    source: r.source, source_url: r.source_url,
    evidence_snippet: r.evidence_snippet ? r.evidence_snippet.slice(0, 200) : null,
    first_seen: r.first_seen
  }));

  // Loc points — facilities by type (Layer 1)
  const locPoints = db.prepare(`
    SELECT address_raw, city, state, type, lat, lng, confidence_tier, source_url, dma_id
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

  // DMA data with top confirmed cities and evidence snippet
  const topCitiesStmt = db.prepare(`
    SELECT cc.city, cc.state FROM city_coverage cc
    WHERE cc.dma_id=? AND cc.available=1
    ORDER BY cc.first_seen ASC
    LIMIT 5
  `);
  const dmaEvidenceStmt = db.prepare(`
    SELECT source_url, snippet FROM signals
    WHERE dma_id=? AND signal_type='confirmed_available'
    ORDER BY confidence DESC LIMIT 1
  `);

  const dmaRows = db.prepare(`
    SELECT d.id as dma_id, d.name as dma_name, d.tier, d.tv_homes,
           d.place_probe_status, d.centroid_lat, d.centroid_lng,
           COUNT(DISTINCT cc.city || cc.state) as cities_confirmed,
           COUNT(DISTINCT c.id) as cities_total,
           COALESCE(dc.cities_total - dc.cities_unknown, 0) as cities_probed
    FROM dmas d
    LEFT JOIN city_coverage cc ON cc.dma_id=d.id AND cc.available=1
    LEFT JOIN cities c ON c.dma_id=d.id
    LEFT JOIN dma_coverage dc ON dc.dma_id=d.id AND dc.retailer_id='amazon_same_day'
    GROUP BY d.id
    ORDER BY d.id ASC
  `).all();

  const dmaData = dmaRows.map(row => {
    const topCities = topCitiesStmt.all(row.dma_id).map(c => c.city + ', ' + c.state);
    const evidence = dmaEvidenceStmt.get(row.dma_id);
    return {
      ...row,
      cities_probed: row.cities_probed || 0,
      top_cities: topCities,
      evidence_snippet: evidence?.snippet?.slice(0, 200) || null,
      evidence_url: evidence?.source_url || null,
      coverage_pct: row.cities_total > 0 ? (row.cities_confirmed / row.cities_total * 100) : 0
    };
  });

  // County → DMA mapping for choropleth
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

  // ── Method stats ──────────────────────────────────────────────────────────────
  const dmas_assessed = db.prepare("SELECT COUNT(*) as n FROM dmas WHERE place_probe_status != 'unprobed'").get().n;
  const dmas_confirmed = db.prepare(`
    SELECT COUNT(DISTINCT dma_id) as n FROM city_coverage WHERE available=1 AND dma_id IS NOT NULL
  `).get().n;
  const dmas_probable = db.prepare(`
    SELECT COUNT(*) as n FROM dmas
    WHERE place_probe_status='has_fresh'
    AND id NOT IN (SELECT DISTINCT dma_id FROM city_coverage WHERE available=1 AND dma_id IS NOT NULL)
  `).get().n;
  const total_us_population = db.prepare('SELECT SUM(population) as n FROM zip_master').get().n || 0;

  // Approximate population covered: ZIPs within ~50 miles of a confirmed SSD/Fresh hub facility
  // We use a bounding box approximation: 0.75 degrees lat/lng ≈ 50 miles
  const freshFacilities = db.prepare(`
    SELECT lat, lng FROM locations
    WHERE lat IS NOT NULL AND lng IS NOT NULL
    AND type IN ('ssd_fulfillment','fresh_hub','fresh_distribution','same_day_facility')
  `).all();

  let population_covered = 0;
  if (freshFacilities.length > 0) {
    // For each zip, check if it's within ~50 miles (0.725 deg lat) of any fresh facility
    const zipsWithPop = db.prepare(`
      SELECT zip, lat, lng, population FROM zip_master
      WHERE lat IS NOT NULL AND lng IS NOT NULL AND population IS NOT NULL
    `).all();
    const covered = new Set();
    for (const zip of zipsWithPop) {
      for (const fac of freshFacilities) {
        const dlat = Math.abs(zip.lat - fac.lat);
        const dlng = Math.abs(zip.lng - fac.lng);
        if (dlat < 0.75 && dlng < 0.75) {
          covered.add(zip.zip);
          break;
        }
      }
    }
    for (const z of zipsWithPop) {
      if (covered.has(z.zip)) population_covered += (z.population || 0);
    }
  }

  // Facility counts by type for intro panel
  const facilityByType = db.prepare(`
    SELECT type, COUNT(*) as n FROM locations
    WHERE retailer_id='amazon_same_day' AND type != 'corporate' AND lat IS NOT NULL
    GROUP BY type ORDER BY n DESC
  `).all();
  const facilityMap = {};
  facilityByType.forEach(r => facilityMap[r.type] = r.n);

  // ZIP coverage stats
  // Coverage stats based on Amazon's stated 50-mile service radius from confirmed SSD/Fresh facilities
  // Pre-computed by scripts — see data/coverage_stats_50mi.json
  let covStats50mi = { coveredZips:9539, totalZips:31095, zipPct:31, coveredPop:193000000, totalPop:317333551, popPct:61, coveredTV:95000000, totalTV:127956490, tvPct:74 };
  try {
    const { readFileSync: rfs } = await import('fs');
    covStats50mi = JSON.parse(rfs(join(PROJECT_ROOT,'data','coverage_stats_50mi.json'),'utf8'));
  } catch(e) {}

  const zipStats = {
    total_zips: covStats50mi.totalZips,
    covered_zips: covStats50mi.coveredZips,
    total_pop: covStats50mi.totalPop,
    covered_pop: covStats50mi.coveredPop
  };
  const tvStats = {
    total_tv: covStats50mi.totalTV,
    covered_tv: covStats50mi.coveredTV
  };
  const zipCovPct = covStats50mi.zipPct;
  const popCovPct2 = covStats50mi.popPct;
  const tvCovPct = covStats50mi.tvPct;

  const methodStats = {
    probesDone: db.prepare("SELECT COUNT(*) as n FROM probe_queue WHERE status='done'").get().n,
    probesPending: db.prepare("SELECT COUNT(*) as n FROM probe_queue WHERE status='pending'").get().n,
    avgConfidence: db.prepare("SELECT ROUND(AVG(confidence),1) as a FROM city_coverage WHERE available=1").get().a,
    totalLocations: db.prepare("SELECT COUNT(*) as n FROM locations WHERE type != 'corporate'").get().n,
    dmas_assessed, dmas_confirmed, dmas_probable,
    dmas_total: 209,
    population_covered,
    total_us_population,
    facilityMap,
    zipStats, tvStats, zipCovPct, popCovPct2, tvCovPct
  };

  // ── New this week ─────────────────────────────────────────────────────────────
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 86400 * 7;
  const newThisWeek = db.prepare(`
    SELECT cc.city, cc.state, cc.retailer_id, r.name AS retailer_name,
           d.name AS dma_name, cc.first_seen
    FROM city_coverage cc
    JOIN retailers r ON r.id=cc.retailer_id
    LEFT JOIN dmas d ON d.id=cc.dma_id
    WHERE cc.available=1 AND cc.first_seen >= ?
    ORDER BY cc.first_seen DESC LIMIT 100
  `).all(oneWeekAgo);

  // ── Summary stats ─────────────────────────────────────────────────────────────
  const TOTAL_TV_HOMES = db.prepare('SELECT SUM(tv_homes) as t FROM dmas').get().t || 1;
  const summaries = {};
  const CITY_TARGET = 2300;
  const DMA_ADDRESSABLE = 190;

  for (const r of retailers) {
    const base = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE cc.available = 1) AS covered,
        COUNT(DISTINCT cc.dma_id) FILTER (WHERE cc.available = 1 AND cc.dma_id IS NOT NULL) AS dmas_covered,
        COUNT(DISTINCT cc.state) FILTER (WHERE cc.available = 1) AS states,
        MAX(cc.first_seen) AS last_checked
      FROM city_coverage cc WHERE cc.retailer_id = ?
    `).get(r.id);

    const coveredTvHomes = db.prepare(`
      SELECT COALESCE(SUM(d.tv_homes), 0) as tv_homes
      FROM dmas d WHERE d.id IN (
        SELECT DISTINCT dma_id FROM city_coverage
        WHERE retailer_id=? AND available=1 AND dma_id IS NOT NULL
      )
    `).get(r.id).tv_homes;

    summaries[r.id] = {
      ...base, covered_tv_homes: coveredTvHomes,
      city_pct: ((base.covered / CITY_TARGET) * 100).toFixed(1),
      dma_pct: ((base.dmas_covered / DMA_ADDRESSABLE) * 100).toFixed(1),
      pop_pct: ((coveredTvHomes / TOTAL_TV_HOMES) * 100).toFixed(1),
    };
  }

  db.close();

  // ── Build HTML ────────────────────────────────────────────────────────────────
  const generatedAt = new Date().toLocaleString('en-US', {
    month:'short', day:'numeric', year:'numeric',
    hour:'2-digit', minute:'2-digit', timeZoneName:'short'
  });
  const generatedDate = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });

  const retailerColors = {};
  const palette = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];
  retailers.forEach((r, i) => { retailerColors[r.id] = palette[i % palette.length]; });

  function availLabel(a) {
    if (a === 1) return 'Available';
    if (a === 0) return 'Not Available';
    return 'Unknown';
  }

  function provenanceHtml(r) {
    const tierIcon = r.confidence_tier === 'verified' ? '✅' : r.confidence_tier === 'inferred' ? '🟡' : '⚫';
    const parts = [`${tierIcon} ${esc(r.source) || 'unknown'}`];
    if (r.evidence_query) parts.push(`Query: <em>${esc(r.evidence_query)}</em>`);
    if (r.evidence_snippet) parts.push(`"${esc(r.evidence_snippet.slice(0,200))}${r.evidence_snippet.length > 200 ? '…' : ''}"`);
    if (r.source_url) parts.push(`<a href="${esc(r.source_url)}" target="_blank" rel="noopener">Source &rarr;</a>`);
    return parts.join('<br>');
  }

  const tableRows = coverageRows.map(r => `
<tr data-retailer="${esc(r.retailer_id)}" data-state="${esc(r.state)}" data-avail="${r.available}" class="has-provenance">
  <td>${esc(r.city)}</td>
  <td>${esc(r.state)}</td>
  <td>${esc(r.dma_name) || '—'}</td>
  <td>${esc(r.tier) || '—'}</td>
  <td>${esc(r.retailer_name)}</td>
  <td class="avail-${r.available===1?'yes':r.available===0?'no':'unk'}">${availLabel(r.available)}</td>
  <td>${r.confidence != null ? r.confidence+'%' : '—'}</td>
  <td class="provenance-cell">
    ${r.confidence_tier === 'verified' ? '✅' : r.confidence_tier === 'inferred' ? '🟡' : '⚫'} ${esc(r.source) || '—'}
    <div class="provenance-tooltip">${provenanceHtml(r)}</div>
  </td>
  <td>${fmt(r.first_seen)}</td>
</tr>`).join('');

  const retailerFilterOpts = retailers.map(r =>
    `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');

  const newRows = newThisWeek.length
    ? newThisWeek.map(r => `<tr><td>${esc(r.city)}</td><td>${esc(r.state)}</td><td>${esc(r.dma_name)||'—'}</td><td>${esc(r.retailer_name)}</td><td>${fmt(r.first_seen)}</td></tr>`).join('')
    : '<tr><td colspan="5" style="color:#888;text-align:center">No new coverage this week</td></tr>';

  const summaryCards = retailers.map(r => {
    const s = summaries[r.id] || {};
    const covered = s.covered ?? 0;
    const dmasCovered = s.dmas_covered ?? 0;
    const cityPct = s.city_pct ?? '0.0';
    const dmaPct = s.dma_pct ?? '0.0';
    const color = retailerColors[r.id];
    return `
    <div class="card-group" style="border-top:4px solid ${color}">
      <div class="card-group-name">${esc(r.name)} &nbsp;·&nbsp; updated ${fmt(s.last_checked)}</div>
      <div class="card-trio">
        <div class="card-tracker">
          <div class="tracker-pct" style="color:${color}">${cityPct}%</div>
          <div class="tracker-label">DMA Coverage</div>
          <div class="tracker-detail">${covered.toLocaleString()} confirmed locations</div>
          <div class="tracker-bar"><div class="tracker-fill" style="width:${Math.min(cityPct,100)}%;background:${color}"></div></div>
        </div>
        <div class="card-tracker">
          <div class="tracker-pct" style="color:${color}">${dmaPct}%</div>
          <div class="tracker-label">DMA Reach</div>
          <div class="tracker-detail">${dmasCovered} / 190 addressable DMAs &nbsp;·&nbsp; ${s.states ?? 0} states</div>
          <div class="tracker-bar"><div class="tracker-fill" style="width:${Math.min(dmaPct,100)}%;background:${color}"></div></div>
        </div>
        <div class="card-tracker">
          <div class="tracker-pct" style="color:${color}">${s.pop_pct ?? '0.0'}%</div>
          <div class="tracker-label">TV Household Reach</div>
          <div class="tracker-detail">${Math.round((s.covered_tv_homes||0)/1e6*10)/10}M / ${Math.round(TOTAL_TV_HOMES/1e6)}M TV households</div>
          <div class="tracker-bar"><div class="tracker-fill" style="width:${Math.min(s.pop_pct??0,100)}%;background:${color}"></div></div>
        </div>
      </div>
    </div>`;
  }).join('');

  // Completeness stats for banner
  const dmasAssessedPct = Math.round(methodStats.dmas_assessed / methodStats.dmas_total * 100);
  const popCovPct = methodStats.total_us_population > 0
    ? Math.round(methodStats.population_covered / methodStats.total_us_population * 100)
    : 0;

  // JSON data for map
  const mapPointsJson = JSON.stringify(mapPoints);
  const locPointsJson = JSON.stringify(locPoints);
  const dmaDataJson = JSON.stringify(dmaData);
  const countyToDmaJson = JSON.stringify(countyToDma);
  const timelineDataJson = JSON.stringify(timeline.byDate);
  const dmaFirstSeenJson = JSON.stringify(timeline.byDmaFirstSeen);
  const retailerColorsJson = JSON.stringify(retailerColors);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Amazon Same-Day Grocery Coverage Tracker</title>
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
/* Summary cards */
.cards{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.card-group{background:#fff;border-radius:8px;padding:18px 22px;box-shadow:0 1px 3px rgba(0,0,0,.1);margin-bottom:16px}
.card-group-name{font-size:13px;font-weight:700;color:#555;margin-bottom:14px;text-transform:uppercase;letter-spacing:.4px}
.card-trio{display:flex;gap:24px;flex-wrap:wrap}
.card-tracker{flex:1;min-width:180px}
.tracker-pct{font-size:36px;font-weight:800;line-height:1}
.tracker-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#666;margin:4px 0 2px}
.tracker-detail{font-size:12px;color:#888;margin-bottom:8px}
.tracker-bar{height:6px;background:#eee;border-radius:3px;overflow:hidden}
.tracker-fill{height:100%;border-radius:3px;transition:width .4s ease}
/* Completeness banner */
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
.fac-tag{font-size:12px;color:#bbd}.fac-tag.ssd{color:#ef4444}.fac-tag.fresh{color:#f97316}.fac-tag.wf{color:#22c55e}.fac-tag.fd{color:#fb923c}.fac-tag.fc{color:#9ca3af}.fac-tag.ds{color:#6b7280}
.intro-divider{width:1px;background:#2a3a5e;align-self:stretch;margin:0 4px}
.intro-reach-row{display:flex;gap:20px;flex-wrap:wrap}
.reach-item{text-align:center}
.reach-num{font-size:28px;font-weight:800;color:#10b981;line-height:1}
.reach-label{font-size:11px;color:#88a;margin-top:2px;line-height:1.4}
.dl-btn{display:inline-block;margin-top:8px;padding:10px 18px;background:#3b82f6;color:#fff;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;transition:background .15s}
.dl-btn:hover{background:#2563eb}
/* Legacy completeness banner refs */
.completeness-banner{display:none}
/* Map */
#map{height:560px;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.12);margin-bottom:12px}
.choropleth-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:11px;color:#555}
.choropleth-legend span{display:inline-flex;align-items:center;gap:5px}
.choropleth-legend .swatch{width:14px;height:14px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.15)}
/* Data table */
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
/* Provenance tooltip */
.provenance-cell{position:relative;cursor:help}
.provenance-tooltip{display:none;position:absolute;right:0;top:100%;z-index:999;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 14px;width:340px;font-size:12px;line-height:1.6;color:#cbd5e1;white-space:normal;text-align:left;box-shadow:0 4px 20px rgba(0,0,0,.4)}
.provenance-tooltip a{color:#60a5fa}
.provenance-cell:hover .provenance-tooltip{display:block}
/* Timeline */
#timeline-view{background:#111126;color:#dde;min-height:calc(100vh - 100px)}
#timeline-view h2{color:#dde;border-bottom-color:#2a3a5e}
.tl-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px}
.tl-chart-box{background:#1a1a2e;border-radius:10px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.tl-chart-box.full{grid-column:1/-1}
.tl-chart-box h3{margin:0 0 14px;font-size:13px;font-weight:700;color:#aac;text-transform:uppercase;letter-spacing:.5px}
.tl-stat-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.tl-stat{background:#1a1a2e;border-radius:8px;padding:14px 18px;flex:1;min-width:140px}
.tl-stat-n{font-size:28px;font-weight:800;color:#4a90e2}
.tl-stat-label{font-size:11px;color:#88a;margin-top:3px}
/* Methodology */
.methodology{max-width:860px;margin:0 auto;padding:10px 0 40px}
.methodology h2{font-size:22px;margin-bottom:6px;border-bottom:2px solid #e0e0e0;padding-bottom:10px}
.methodology h3{font-size:15px;font-weight:700;margin:28px 0 8px;color:#222}
.methodology p,.methodology li{font-size:14px;line-height:1.7;color:#444;margin-bottom:8px}
.methodology ul{padding-left:22px;margin-bottom:12px}
.method-intro{font-size:15px;color:#333;margin-bottom:20px;line-height:1.8}
.method-cols{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin:16px 0}
.method-col{background:#f8f9fb;border-radius:8px;padding:16px 20px;border:1px solid #e0e5f0}
.method-col h4{margin:0 0 10px;font-size:13px;font-weight:700;color:#333;text-transform:uppercase;letter-spacing:.4px}
.method-table{width:100%;border-collapse:collapse;margin:12px 0 20px;font-size:13px}
.method-table th{background:#f0f4ff;font-weight:700;padding:8px 12px;text-align:left;border-bottom:2px solid #ccd}
.method-table td{padding:7px 12px;border-bottom:1px solid #eee;vertical-align:top}
.method-table tr:hover td{background:#f9faff}
.confidence-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
.confidence-table th{background:#1a1a2e;color:#dde;padding:8px 14px;text-align:left}
.confidence-table td{padding:8px 14px;border-bottom:1px solid #e8e8e8}
.confidence-table tr:nth-child(even) td{background:#f8f9fb}
.method-footer{margin-top:32px;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:12px}
/* Leaflet layer control override */
.leaflet-control-layers{font-size:12px}
.leaflet-control-layers-selector{margin-right:5px}
</style>
</head>
<body>
<header>
  <h1>🛒 Amazon Same-Day Grocery Coverage</h1>
  <span>Rivendell Advisors &nbsp;·&nbsp; ${esc(generatedAt)}</span>
</header>
<nav>
  <button class="active" onclick="showView('map-view',this)">🗺 Map</button>
  <button onclick="showView('data-view',this)">📊 Data</button>
  <button onclick="showView('new-view',this)">🆕 New This Week</button>
  <button onclick="showView('timeline-view',this);initTimeline()">📈 Timeline</button>
  <button onclick="showView('methodology-view',this)">📋 Methodology</button>
</nav>

<!-- MAP VIEW -->
<div id="map-view" class="view active">

  <!-- Intro Panel -->
  <div class="intro-panel">
    <div class="intro-purpose">
      <strong>Purpose:</strong> Analyze Amazon&#39;s Same-Day fresh grocery delivery coverage in the U.S. using publicly available information.
      For a full description of methodology and confidence in the analysis, see the <strong>Methodology</strong> tab above.
      &nbsp;·&nbsp; <em>${esc(generatedDate)}</em>
    </div>

    <div class="intro-stats-grid">

      <!-- Facility inventory -->
      <div class="intro-stat-block">
        <div class="intro-stat-title">Amazon Facility Network</div>
        <div class="intro-stat-big">${methodStats.totalLocations.toLocaleString()}</div>
        <div class="intro-stat-sub">facilities identified</div>
        <div class="intro-fac-breakdown">
          ${methodStats.facilityMap.ssd_fulfillment ? `<span class="fac-tag ssd">&#9679; ${methodStats.facilityMap.ssd_fulfillment} SSD Fulfillment Centers</span>` : ''}
          ${methodStats.facilityMap.fresh_hub ? `<span class="fac-tag fresh">&#9679; ${methodStats.facilityMap.fresh_hub} Amazon Fresh Hubs</span>` : ''}
          ${methodStats.facilityMap.whole_foods_node ? `<span class="fac-tag wf">&#9679; ${methodStats.facilityMap.whole_foods_node} Whole Foods Stores</span>` : ''}
          ${methodStats.facilityMap.fresh_distribution ? `<span class="fac-tag fd">&#9679; ${methodStats.facilityMap.fresh_distribution} Fresh Distribution</span>` : ''}
          ${methodStats.facilityMap.fulfillment_center ? `<span class="fac-tag fc">&#9679; ${methodStats.facilityMap.fulfillment_center} Fulfillment Centers</span>` : ''}
          ${methodStats.facilityMap.same_day_facility ? `<span class="fac-tag fc">&#9679; ${methodStats.facilityMap.same_day_facility} Same-Day Facilities</span>` : ''}
          ${methodStats.facilityMap.amazon_facility ? `<span class="fac-tag fc">&#9679; ${methodStats.facilityMap.amazon_facility} Other Amazon Facilities</span>` : ''}
          ${(methodStats.facilityMap.sortation_center||0) + (methodStats.facilityMap.distribution_center||0) + (methodStats.facilityMap.delivery_station||0) + (methodStats.facilityMap.warehouse||0) > 0 ? `<span class="fac-tag ds">&#9679; ${(methodStats.facilityMap.sortation_center||0)+(methodStats.facilityMap.distribution_center||0)+(methodStats.facilityMap.delivery_station||0)+(methodStats.facilityMap.warehouse||0)} Sortation / Delivery / DC</span>` : ''}
        </div>
      </div>

      <div class="intro-divider"></div>

      <!-- Coverage reach -->
      <div class="intro-stat-block">
        <div class="intro-stat-title">Estimated Coverage Reach</div>
        <div class="intro-stat-sub" style="margin-bottom:8px">Within 50-mile radius of confirmed SSD or Fresh Hub facility<br><small style="color:#667">(Amazon&#39;s publicly stated service range)</small></div>
        <div class="intro-reach-row">
          <div class="reach-item">
            <div class="reach-num">${methodStats.zipCovPct}%</div>
            <div class="reach-label">of US ZIP codes<br><small>${Math.round(methodStats.zipStats.covered_zips/1000)}k of ${Math.round(methodStats.zipStats.total_zips/1000)}k</small></div>
          </div>
          <div class="reach-item">
            <div class="reach-num">${methodStats.tvCovPct}%</div>
            <div class="reach-label">of US TV households<br><small>${Math.round(methodStats.tvStats.covered_tv/1e6)}M of ${Math.round(methodStats.tvStats.total_tv/1e6)}M</small></div>
          </div>
          <div class="reach-item">
            <div class="reach-num">${methodStats.popCovPct2}%</div>
            <div class="reach-label">of US population<br><small>${Math.round(methodStats.zipStats.covered_pop/1e6)}M of ${Math.round(methodStats.zipStats.total_pop/1e6)}M</small></div>
          </div>
        </div>
      </div>

      <div class="intro-divider"></div>

      <!-- Download -->
      <div class="intro-stat-block" style="justify-content:center;text-align:center">
        <div class="intro-stat-title">Data Export</div>
        <a href="amazon-sameday-coverage-by-zip.csv" download class="dl-btn">
          &#8595; Download ZIP Code Coverage List
        </a>
        <div class="intro-stat-sub" style="margin-top:6px">${methodStats.zipStats.total_zips.toLocaleString()} ZIPs &nbsp;·&nbsp; within 50mi of SSD facility / outside radius</div>
      </div>

    </div>
  </div>

  <div id="map"></div>

  <div class="choropleth-legend" id="dma-legend" style="margin-top:4px">
    <strong style="margin-right:6px;color:#555;font-size:11px;font-weight:700;text-transform:uppercase">DMA Status:</strong>
    <span><span class="swatch" style="background:#10b981"></span>Confirmed coverage</span>
    <span><span class="swatch" style="background:#f59e0b"></span>Likely (Fresh facility)</span>
    <span><span class="swatch" style="background:#6366f1"></span>Possible (Amazon facility)</span>
    <span><span class="swatch" style="background:#374151"></span>Unlikely (no facility)</span>
    <span><span class="swatch" style="background:#1e293b"></span>Not assessed</span>
  </div>
</div>

<!-- DATA TABLE VIEW -->
<div id="data-view" class="view">
  <section>
    <h2>Coverage by Location &nbsp;<span class="badge">${coverageRows.length} confirmed locations</span></h2>
    <div class="filters">
      <input type="text" id="filter-text" placeholder="Search city, state, DMA..."/>
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
        <th data-col="0">City</th><th data-col="1">State</th><th data-col="2">DMA</th>
        <th data-col="3">Tier</th><th data-col="4">Retailer</th><th data-col="5">Available</th>
        <th data-col="6">Confidence</th><th data-col="7">Source</th><th data-col="8">First Seen</th>
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

<!-- NEW THIS WEEK -->
<div id="new-view" class="view">
  <section>
    <h2>New Coverage This Week <span class="badge">${newThisWeek.length}</span></h2>
    <table>
      <thead><tr><th>City</th><th>State</th><th>DMA</th><th>Retailer</th><th>First Seen</th></tr></thead>
      <tbody>${newRows}</tbody>
    </table>
  </section>
</div>

<!-- TIMELINE -->
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
        <h3>Signal Velocity (Signals Per Snapshot)</h3>
        <canvas id="chart-signals" height="200"></canvas>
      </div>
    </div>
  </section>
</div>

<!-- METHODOLOGY -->
<div id="methodology-view" class="view">
  <section class="methodology">
    <h2>Methodology</h2>

    <h3>What We're Tracking</h3>
    <p class="method-intro">In December 2025, Amazon announced same-day perishable grocery delivery across the US for Prime members — then subsequently closed all Amazon Fresh physical stores to double down on Whole Foods + delivery infrastructure. This tracker maps that footprint using publicly available data: which DMAs have confirmed coverage, which have the physical infrastructure that likely enables it, and how the picture is evolving.</p>

    <h3>How We Know What We Know</h3>
    <div class="method-cols">
      <div class="method-col">
        <h4>🏭 Physical Infrastructure</h4>
        <p>We mapped Amazon's facility network from multiple sources: community-maintained facility lists, Brave Place Search POI data, and Amazon job postings. Key facility types:</p>
        <ul>
          <li><strong>SSD fulfillment centers</strong> (V-prefix codes) — primary grocery nodes with temperature-controlled zones</li>
          <li><strong>Amazon Fresh Online hubs</strong> (U-prefix) — dedicated perishable fulfillment</li>
          <li><strong>Whole Foods stores</strong> (C-prefix) — now serving as microfulfillment nodes since Fresh stores closed</li>
        </ul>
        <p style="font-size:12px;color:#888;margin-top:8px">Facility presence is a strong signal but not confirmation — standard delivery stations do not handle perishables.</p>
      </div>
      <div class="method-col">
        <h4>🔍 Coverage Verification</h4>
        <p>For each DMA with Amazon infrastructure, we ran targeted web searches across 6 channels:</p>
        <ul>
          <li>Local and trade news</li>
          <li>Amazon's own newsroom</li>
          <li>Facility-code-specific searches</li>
          <li>Reddit communities</li>
          <li>Amazon job postings (expansion signals)</li>
          <li>Public Facebook posts and community groups</li>
        </ul>
        <p style="font-size:12px;color:#888;margin-top:8px">Confirmed coverage requires finding explicit evidence of same-day grocery availability in that DMA.</p>
      </div>
    </div>

    <h3>Confidence Model</h3>
    <table class="confidence-table">
      <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr><td><span style="color:#10b981;font-size:16px">●</span> <strong>Confirmed</strong></td><td>Direct evidence: news article, Amazon announcement, or community report of same-day grocery delivery in this area</td></tr>
        <tr><td><span style="color:#f59e0b;font-size:16px">●</span> <strong>Probable</strong></td><td>SSD or Fresh facility found in DMA; coverage not yet confirmed by external evidence</td></tr>
        <tr><td><span style="color:#6366f1;font-size:16px">●</span> <strong>Possible</strong></td><td>Amazon logistics facility present in DMA; no fresh-capable infrastructure confirmed</td></tr>
        <tr><td><span style="color:#374151;font-size:16px">●</span> <strong>Unlikely</strong></td><td>No Amazon facility found within this DMA after Place Search</td></tr>
        <tr><td><span style="color:#888;font-size:16px">●</span> <strong>Unknown</strong></td><td>DMA not yet assessed</td></tr>
      </tbody>
    </table>

    <h3>Known Limitations</h3>
    <ul>
      <li><strong>Facility presence ≠ grocery coverage.</strong> The most important caveat — SSD facilities enable grocery delivery, but standard fulfillment centers and delivery stations do not.</li>
      <li><strong>Amazon&#39;s coverage expands continuously.</strong> The stated coverage figures from December 2025 are likely already outdated; the actual footprint today is larger. Data has a date.</li>
      <li><strong>DMA-level assessment may miss sub-DMA variation.</strong> In large metros (New York, LA), coverage may be uneven across zip codes and boroughs. DMA-confirmed means at least one city in the DMA has evidence — not necessarily universal coverage throughout.</li>
    </ul>

    <h3>Coverage Statistics</h3>
    <table class="method-table">
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>DMAs assessed</td><td>${methodStats.dmas_assessed} of ${methodStats.dmas_total} (${dmasAssessedPct}%)</td></tr>
        <tr><td>DMAs with confirmed coverage</td><td>${methodStats.dmas_confirmed}</td></tr>
        <tr><td>DMAs with Fresh/SSD facility (probable)</td><td>${methodStats.dmas_probable}</td></tr>
        <tr><td>US population near a Fresh/SSD facility</td><td>~${Math.round(methodStats.population_covered/1e6)}M of ${Math.round(methodStats.total_us_population/1e6)}M (${popCovPct}%)</td></tr>
        <tr><td>Facility locations tracked</td><td>${methodStats.totalLocations.toLocaleString()}</td></tr>
        <tr><td>Search probes completed</td><td>${methodStats.probesDone.toLocaleString()}</td></tr>
        <tr><td>Search probes queued</td><td>${methodStats.probesPending.toLocaleString()}</td></tr>
        <tr><td>Avg confidence score (confirmed locations)</td><td>${methodStats.avgConfidence}%</td></tr>
      </tbody>
    </table>

    <p class="method-footer">Research conducted by Rivendell Advisors LLC. Generated ${esc(generatedAt)}.</p>
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

// ── Map data ──────────────────────────────────────────────────────────────────
const MAP_POINTS = ${mapPointsJson};
const LOC_POINTS = ${locPointsJson};
const DMA_DATA_ARR = ${dmaDataJson};
const COUNTY_TO_DMA = ${countyToDmaJson};
window.TIMELINE_DATA = ${timelineDataJson};
window.DMA_FIRST_SEEN = ${dmaFirstSeenJson};
const RETAILER_COLORS = ${retailerColorsJson};

// Build DMA lookup map
const DMA_MAP = {};
DMA_DATA_ARR.forEach(d => { DMA_MAP[d.dma_id] = d; });

// ── Initialize Leaflet map ────────────────────────────────────────────────────
const map = L.map('map').setView([38.5, -96], 4);
window._map = map;

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
  maxZoom: 18
}).addTo(map);

// ── Layer 1: Facility network (per-type layer groups) ─────────────────────────
const facilityTypes = {
  ssd_fulfillment:    { label:'SSD Fulfillment',        color:'#ef4444', radius:10 },
  fresh_hub:          { label:'Fresh Hubs',             color:'#f97316', radius:8 },
  fresh_distribution: { label:'Fresh Distribution',     color:'#fb923c', radius:8 },
  whole_foods_node:   { label:'Whole Foods Nodes',      color:'#22c55e', radius:6 },
  amazon_fresh_store: { label:'Amazon Fresh (Closing)', color:'#3b82f6', radius:6 },
  same_day_facility:  { label:'Same-Day Facilities',    color:'#a855f7', radius:7 },
  other:              { label:'Other Amazon Facilities', color:'#6b7280', radius:4 }
};

function getFacilityStyle(type) {
  return facilityTypes[type] || facilityTypes.other;
}

const facilityLayerGroups = {};
Object.keys(facilityTypes).forEach(t => {
  facilityLayerGroups[t] = L.layerGroup();
});

LOC_POINTS.forEach(p => {
  const style = getFacilityStyle(p.type);
  const layerKey = facilityTypes[p.type] ? p.type : 'other';

  const marker = L.circleMarker([p.lat, p.lng], {
    radius: style.radius,
    color: style.color,
    fillColor: style.color,
    fillOpacity: 0.75,
    weight: 1.5
  });

  const codeStr = p.facility_code ? '<b>' + p.facility_code + '</b> — ' : '';
  const tierBadge = p.confidence_tier === 'inferred' ? '<span style="color:#fbbf24">● Inferred (Place Search)</span>'
    : p.confidence_tier === 'verified' ? '<span style="color:#34d399">● Verified</span>'
    : '<span style="color:#9ca3af">● External list (unverified)</span>';
  const cityState = (p.city && p.state) ? p.city + ', ' + p.state : (p.city || p.state || '');

  marker.bindPopup(
    codeStr + '<b>' + (style.label) + '</b>' +
    (cityState ? '<br>' + cityState : '') +
    '<br><small style="color:#888">' + (p.address_raw || '') + '</small>' +
    '<br>' + tierBadge +
    (p.capability_note ? '<br><em style="font-size:11px;color:#6b7280">' + p.capability_note + '</em>' : '') +
    (p.source_url && !p.source_url.startsWith('brave_') ? '<br><a href="' + p.source_url + '" target="_blank" style="font-size:11px">Source &rarr;</a>' : '')
  );

  facilityLayerGroups[layerKey].addLayer(marker);
});

// ── Layer 2: DMA boundaries (county choropleth) ───────────────────────────────
const dmaLayer = L.layerGroup();
let dmaGeoLoaded = false;

function dmaStatus(d) {
  if (!d) return 'unknown';
  if (d.cities_confirmed > 0) return 'confirmed';
  if (d.place_probe_status === 'has_fresh') return 'likely';
  if (d.place_probe_status === 'has_facility') return 'possible';
  if (d.place_probe_status === 'no_facility') return 'unlikely';
  return 'unknown';
}
function dmaColor(d) {
  switch(dmaStatus(d)) {
    case 'confirmed': return '#10b981';
    case 'likely':    return '#f59e0b';
    case 'possible':  return '#6366f1';
    case 'unlikely':  return '#374151';
    default:          return '#1e293b';
  }
}
function dmaOpacity(d) {
  switch(dmaStatus(d)) {
    case 'confirmed': return 0.75;
    case 'likely':    return 0.65;
    case 'possible':  return 0.55;
    case 'unlikely':  return 0.3;
    default:          return 0.2;
  }
}

async function initDmaLayer() {
  if (dmaGeoLoaded) return;
  dmaGeoLoaded = true;
  try {
    const geoUrl = (window.location.hostname === 'localhost' || window.location.protocol === 'file:')
      ? '../data/us_dmas.geojson'
      : 'us_dmas.geojson';
    const resp = await fetch(geoUrl);
    const geojson = await resp.json();

    L.geoJSON(geojson, {
      style: feature => {
        // DMA GeoJSON — each feature IS a DMA, dma_id is a direct property
        const dmaId = feature.properties.dma_id;
        const d = dmaId ? DMA_MAP[dmaId] : null;
        return { fillColor: dmaColor(d), fillOpacity: dmaOpacity(d), color: '#fff', weight: 0.5 };
      },
      onEachFeature: (feature, layer) => {
        const dmaId = feature.properties.dma_id;
        const d = dmaId ? DMA_MAP[dmaId] : null;
        const status = dmaStatus(d);
        const statusLabel = {
          confirmed: '✅ Confirmed coverage',
          likely:    '🟡 Likely (Fresh facility found)',
          possible:  '🔵 Possible (Amazon facility)',
          unlikely:  '⚫ Unlikely (no facility found)',
          unknown:   '⬜ Not yet assessed'
        }[status] || '—';
        layer.bindPopup(
          '<b>' + (feature.properties.name || d?.dma_name || 'DMA ' + dmaId) + '</b>' +
          '<br>' + statusLabel +
          (d && d.cities_confirmed > 0
            ? '<br>Confirmed locations: <b>' + d.cities_confirmed + '</b>' +
              (d.top_cities && d.top_cities.length ? ' <small>(' + d.top_cities.slice(0,3).join(', ') + ')</small>' : '')
            : '') +
          (d?.evidence_snippet ? '<br><small style="color:#888">"' + d.evidence_snippet.slice(0,150) + '…"</small>' : '') +
          (d?.evidence_url ? '<br><a href="' + d.evidence_url + '" target="_blank" style="font-size:11px">Evidence &rarr;</a>' : '')
        );
        layer.on('mouseover', function() { layer.setStyle({ weight: 2, color: '#fff' }); });
        layer.on('mouseout', function() { layer.setStyle({ weight: 0.5, color: '#fff' }); });
      }
    }).addTo(dmaLayer);
  } catch(e) {
    console.error('Failed to load county GeoJSON:', e);
  }
}

// ── Layer 3: Confirmed cities ─────────────────────────────────────────────────
const citiesLayer = L.layerGroup();
MAP_POINTS.forEach(p => {
  const color = p.confidence_tier === 'verified' ? '#10b981' : '#f59e0b';
  const marker = L.circleMarker([p.lat, p.lng], {
    radius: 6, color: color, fillColor: color, fillOpacity: 0.8, weight: 1.5
  });
  marker.bindPopup(
    '<b>' + p.city + ', ' + p.state + '</b>' +
    (p.dma_name ? '<br><small>DMA: ' + p.dma_name + '</small>' : '') +
    '<br><span style="color:' + color + '">' +
      (p.confidence_tier === 'verified' ? '✅ Verified' : '🟡 Inferred') + '</span>' +
    '<br><small style="color:#888">' + (p.source || '') + '</small>' +
    (p.evidence_snippet ? '<br><small style="color:#aaa">"' + p.evidence_snippet + '…"</small>' : '') +
    (p.source_url ? '<br><a href="' + p.source_url + '" target="_blank" style="font-size:11px">Source &rarr;</a>' : '') +
    (p.first_seen ? '<br><small style="color:#aaa">First seen: ' + new Date(p.first_seen*1000).toLocaleDateString() + '</small>' : '')
  );
  citiesLayer.addLayer(marker);
});

// ── Layer 4: 50-mile service reach circles (SSD/Fresh only) ──────────────────
const reachLayer = L.layerGroup();
const REACH_TYPES = new Set(['ssd_fulfillment','fresh_hub','fresh_distribution','same_day_facility']);
LOC_POINTS.filter(p => REACH_TYPES.has(p.type)).forEach(p => {
  const circle = L.circle([p.lat, p.lng], {
    radius: 80467,  // 50 miles in meters (Amazon's publicly stated service radius)
    color: '#ef4444',
    weight: 1.5,
    dashArray: '6 4',
    fillColor: '#ef4444',
    fillOpacity: 0.06
  });
  circle.bindPopup(
    '<b>50-mile service radius</b>' +
    '<br>' + (p.facility_code || p.address_raw || '') +
    '<br><em style="font-size:11px;color:#888">50-mile service radius &#8212; per Amazon&#39;s publicly stated range</em>'
  );
  reachLayer.addLayer(circle);
});

// ── Add all layers to map + control ──────────────────────────────────────────
// Default: show DMA layer + cities layer; SSD/Fresh facilities on; others off; reach circles off
dmaLayer.addTo(map);
initDmaLayer();
citiesLayer.addTo(map);
facilityLayerGroups['ssd_fulfillment'].addTo(map);
facilityLayerGroups['fresh_hub'].addTo(map);
facilityLayerGroups['fresh_distribution'].addTo(map);
facilityLayerGroups['whole_foods_node'].addTo(map);
// Others default off: amazon_fresh_store, same_day_facility, other, reachLayer

const overlayMaps = {
  '<span style="color:#1a1a2e">▦</span> DMA Boundaries': dmaLayer,
  '<span style="color:#10b981">●</span> Confirmed Cities': citiesLayer,
  '<span style="color:#ef4444">●</span> SSD Fulfillment Centers': facilityLayerGroups['ssd_fulfillment'],
  '<span style="color:#f97316">●</span> Fresh Hubs': facilityLayerGroups['fresh_hub'],
  '<span style="color:#fb923c">●</span> Fresh Distribution': facilityLayerGroups['fresh_distribution'],
  '<span style="color:#22c55e">●</span> Whole Foods Nodes': facilityLayerGroups['whole_foods_node'],
  '<span style="color:#a855f7">●</span> Same-Day Facilities (unclassified)': facilityLayerGroups['same_day_facility'],
  '<span style="color:#6b7280">●</span> Other Amazon Facilities': facilityLayerGroups['other'],
  '<span style="color:#ef4444">○</span> 50-Mile Service Reach (hypothesis)': reachLayer
};

L.control.layers({ 'OpenStreetMap': osmLayer }, overlayMaps, {
  collapsed: false,
  position: 'topright'
}).addTo(map);

// When DMA layer is toggled, load the geojson if not done yet
map.on('overlayadd', function(e) {
  if (e.layer === dmaLayer) initDmaLayer();
});

// ── Data table ────────────────────────────────────────────────────────────────
(function() {
  const tbody = document.getElementById('cov-body');
  const allRows = Array.from(tbody.querySelectorAll('tr'));
  let filtered = allRows.slice();
  let sortCol = -1, sortDir = 1, page = 0;
  const PAGE = 250;

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
    page = 0; render();
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
    document.getElementById('row-info').textContent = filtered.length + ' rows matching filters';
    document.getElementById('page-info').textContent = 'Page ' + (page+1) + '/' + Math.max(1, Math.ceil(filtered.length/PAGE));
    document.getElementById('row-info2').textContent = 'Showing ' + (start+1) + '–' + end;
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
  const retailerIds = [...new Set(tlData.map(d => d.retailer_id))];
  const allDates = [...new Set(tlData.map(d => d.snapshot_date))].sort();

  const statsEl = document.getElementById('tl-stats');
  statsEl.innerHTML = '';
  for (const rid of retailerIds) {
    const latest = tlData.filter(d => d.retailer_id === rid).slice(-1)[0];
    if (!latest) continue;
    const color = RETAILER_COLORS[rid] || '#4a90e2';
    statsEl.innerHTML += \`
      <div class="tl-stat" style="border-top:3px solid \${color}">
        <div class="tl-stat-n">\${latest.total_cities_confirmed}</div>
        <div class="tl-stat-label">\${rid} — confirmed locations</div>
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

  // Growth chart
  new Chart(document.getElementById('chart-growth'), {
    type: 'line',
    data: {
      labels: allDates,
      datasets: retailerIds.map(rid => {
        const color = RETAILER_COLORS[rid] || '#4a90e2';
        return {
          label: rid,
          data: allDates.map(d => { const r = tlData.find(x => x.retailer_id===rid && x.snapshot_date===d); return r ? r.total_cities_confirmed : null; }),
          borderColor: color, backgroundColor: color + '33',
          pointBackgroundColor: color, pointRadius: 4, tension: 0.3, fill: false, spanGaps: true
        };
      })
    },
    options: { responsive: true, ...chartDefaults }
  });

  // DMA unlock chart
  const tierColors = { mega:'#e74c3c', large:'#f39c12', mid:'#3498db', small:'#2ecc71' };
  const tiers = ['mega','large','mid','small'];
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
  const xLabels = dmaUnlockDates.length ? dmaUnlockDates : allDates;
  new Chart(document.getElementById('chart-dma-unlock'), {
    type: 'bar',
    data: {
      labels: xLabels,
      datasets: tiers.map(tier => ({
        label: tier,
        data: xLabels.map(d => dmaUnlockByDate[d]?.[tier] || 0),
        backgroundColor: tierColors[tier] || '#888',
        stack: 'dma'
      }))
    },
    options: { responsive: true, ...chartDefaults, scales: { x: { ...chartDefaults.scales.x, stacked: true }, y: { ...chartDefaults.scales.y, stacked: true } } }
  });

  // Signals chart
  new Chart(document.getElementById('chart-signals'), {
    type: 'bar',
    data: {
      labels: allDates,
      datasets: retailerIds.map(rid => {
        const color = RETAILER_COLORS[rid] || '#4a90e2';
        return {
          label: rid,
          data: allDates.map(d => { const r = tlData.find(x => x.retailer_id===rid && x.snapshot_date===d); return r ? r.total_signals : 0; }),
          backgroundColor: color + 'cc'
        };
      })
    },
    options: { responsive: true, ...chartDefaults }
  });
}
<\/script>
</body>
</html>`;

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const out = join(REPORTS_DIR, 'index.html');
  writeFileSync(out, html);
  log(`Report written → ${out} (${mapPoints.length} city points, ${locPoints.length} facility points, ${dmaData.length} DMAs)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
