#!/usr/bin/env node
// build_msa_zip_targets.js — Precompute 3 ZIP codes per MSA for amazon_msa_probe_v2.js
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const db = new Database(join(ROOT, 'data', 'coverage.db'));
const csvText = readFileSync(join(ROOT, 'data', 'top200_msa_probe_targets.csv'), 'utf8');
const geojson = JSON.parse(readFileSync(join(ROOT, 'data', 'us_msas.geojson'), 'utf8'));

// Parse CSV rows
const rows = csvText.replace(/\r/g, '').trim().split('\n').slice(1).map(line => {
  // Format: msa_id,"msa_name",population,zip,city,state,zip_population
  const m = line.match(/^(\d+),"([^"]+)",(\d+),(\d{5}),([^,]+),([A-Z]{2}),(\d+)$/);
  if (m) {
    return { msa_id: m[1], msa_name: m[2], msa_population: parseInt(m[3]), zip: m[4], city: m[5], state: m[6], zip_population: parseInt(m[7]) };
  }
  // Fallback parse — handle missing ZIP fields
  const parts = line.split(',');
  const zipRaw = (parts[3] || '').trim();
  const zip = /^\d{5}$/.test(zipRaw) ? zipRaw : null;
  return {
    msa_id: parts[0]?.trim(),
    msa_name: (parts[1] || '').replace(/"/g,'').trim(),
    msa_population: parseInt(parts[2]) || 0,
    zip,
    city: (parts[4] || '').trim(),
    state: (parts[5] || '').trim(),
    zip_population: parseInt(parts[6]) || 0
  };
}).filter(r => r.msa_id && r.zip); // Skip rows with no valid ZIP

// Build MSA feature map
const msaMap = {};
for (const f of geojson.features) {
  msaMap[f.properties.msa_id] = f;
}

function computeCentroid(feature) {
  const geom = feature.geometry;
  let allCoords = [];
  if (geom.type === 'Polygon') {
    allCoords = geom.coordinates[0];
  } else if (geom.type === 'MultiPolygon') {
    let maxLen = 0;
    for (const poly of geom.coordinates) {
      if (poly[0].length > maxLen) { maxLen = poly[0].length; allCoords = poly[0]; }
    }
  }
  const lat = allCoords.reduce((a,c)=>a+c[1],0)/allCoords.length;
  const lng = allCoords.reduce((a,c)=>a+c[0],0)/allCoords.length;
  return { lat, lng };
}

function getBBox(feature) {
  const geom = feature.geometry;
  let allCoords = [];
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) allCoords.push(...ring);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) for (const ring of poly) allCoords.push(...ring);
  }
  const lats = allCoords.map(c=>c[1]);
  const lngs = allCoords.map(c=>c[0]);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
}

function pointInPolygon(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function pointInFeature(lng, lat, feature) {
  const geom = feature.geometry;
  if (geom.type === 'Polygon') return pointInPolygon(lng, lat, geom.coordinates[0]);
  if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) if (pointInPolygon(lng, lat, poly[0])) return true;
  }
  return false;
}

const closestStmt = db.prepare(`
  SELECT zip, city, state, lat, lng, population FROM zip_master
  WHERE lat IS NOT NULL
  ORDER BY ((lat - ?) * (lat - ?) + (lng - ?) * (lng - ?)) ASC
  LIMIT 5
`);

const bboxZipsStmt = db.prepare(`
  SELECT zip, city, state, lat, lng, population FROM zip_master
  WHERE lat IS NOT NULL
    AND lat BETWEEN ? AND ?
    AND lng BETWEEN ? AND ?
  ORDER BY population DESC
  LIMIT 100
`);

const results = {};

for (const row of rows) {
  const msaFeat = msaMap[row.msa_id];
  const centroid = msaFeat ? computeCentroid(msaFeat) : null;

  // ZIP 1: from CSV (highest-pop ZIP in MSA per prior analysis)
  const zip1 = row.zip;

  // ZIP 2: closest to MSA centroid
  let zip2 = zip1;
  if (centroid) {
    const candidates = closestStmt.all(centroid.lat, centroid.lat, centroid.lng, centroid.lng);
    for (const c of candidates) {
      if (c.zip !== zip1) { zip2 = c.zip; break; }
    }
    if (zip2 === zip1) zip2 = candidates[0]?.zip || zip1;
  }

  // ZIP 3: highest-pop ZIP within MSA polygon
  let zip3 = zip1;
  if (msaFeat) {
    const bbox = getBBox(msaFeat);
    const bboxZips = bboxZipsStmt.all(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
    // Try polygon test first
    for (const z of bboxZips) {
      if (z.zip !== zip1 && z.zip !== zip2 && pointInFeature(z.lng, z.lat, msaFeat)) {
        zip3 = z.zip;
        break;
      }
    }
    // Fallback: any bbox ZIP not already used
    if (zip3 === zip1) {
      for (const z of bboxZips) {
        if (z.zip !== zip1 && z.zip !== zip2) { zip3 = z.zip; break; }
      }
    }
  }

  const zips = [...new Set([zip1, zip2, zip3])];

  results[row.msa_id] = {
    msa_id: row.msa_id,
    msa_name: row.msa_name,
    msa_population: row.msa_population,
    zips,
    zip_csv: zip1,
    zip_centroid: zip2,
    zip_urban: zip3,
  };
}

const outPath = join(ROOT, 'data', 'msa_zip_targets.json');
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`Written ${outPath} with ${Object.keys(results).length} MSAs`);
console.log('Sample NY:', JSON.stringify(results['35620']));
