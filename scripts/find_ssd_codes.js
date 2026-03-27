/**
 * find_ssd_codes.js — Mine Reddit + web for V/U prefix SSD facility codes
 */
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try { const { config } = await import('dotenv'); config(); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'coverage.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const key = process.env.BRAVE_API_KEY;
const RETAILER_ID = 'amazon_same_day';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Known codes we already have
const existingCodes = new Set(
  db.prepare(`SELECT address_raw FROM locations WHERE retailer_id=? AND type IN ('ssd_fulfillment','fresh_hub')`)
    .all(RETAILER_ID)
    .map(r => r.address_raw.match(/^([A-Z][A-Z0-9]{2,4})/)?.[1])
    .filter(Boolean)
);
console.log('Existing SSD/Fresh codes:', [...existingCodes].join(', '));

const queries = [
  // Reddit + facility code searches
  'site:reddit.com "sub same day" Amazon facility "V" code address 2024 2025',
  'site:reddit.com AmazonFlexDrivers "sub same day" warehouse list codes',
  'site:reddit.com "VTX" OR "VFL" OR "VGA" OR "VNC" OR "VMD" "sub same day" Amazon',
  'site:reddit.com "VCA" OR "VIL" OR "VOH" OR "VTN" OR "VNY" "sub same day" Amazon',
  'site:reddit.com "VWA" OR "VCO" OR "VAZ" OR "VMI" OR "VIN" "sub same day" Amazon',
  'site:reddit.com "VMN" OR "VPA" OR "VNJ" OR "VCT" OR "VMA" "sub same day" Amazon',
  
  // TikTok and social (often have facility mentions)
  '"sub same day" Amazon facility code address Texas California Florida',
  '"sub same day" Amazon "VTX5" OR "VTX6" OR "VTX9" Houston Dallas',
  
  // General searches for facility lists
  'Amazon "sub same day" fulfillment centers list addresses 2025',
  '"AmazonFlexDrivers" wiki "sub same day" facility list complete',
  
  // Job posting approach
  'Amazon "sub same day" "operations manager" job "TX" OR "CA" OR "FL" site:linkedin.com',
  'Amazon "Global Specialty Fulfillment" "sub same day" address location hiring',
  
  // Trucker/freight sources
  'Amazon "sub same day" warehouse "dock appointment" address shipper',
  'Amazon SSD facility address list "temperature controlled" grocery 2025',
];

const codeRe = /\b([VU][A-Z0-9]{3,5})\b/g;
const foundCodes = new Map(); // code -> { urls, cities }

for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', q);
  url.searchParams.set('count', '10');
  
  try {
    const res = await fetch(url, { headers: { 'X-Subscription-Token': key }});
    const data = await res.json();
    const results = data?.web?.results || [];
    
    for (const r of results) {
      const text = (r.title || '') + ' ' + (r.description || '') + ' ' + (r.url || '');
      const codes = [...text.matchAll(codeRe)].map(m => m[1].toUpperCase());
      for (const code of codes) {
        if (!existingCodes.has(code)) {
          if (!foundCodes.has(code)) foundCodes.set(code, { urls: [], snippets: [] });
          foundCodes.get(code).urls.push(r.url);
          foundCodes.get(code).snippets.push(text.slice(0, 200));
        }
      }
    }
    
    if (results.length > 0) {
      console.log(`[${i+1}/${queries.length}] "${q.slice(0,60)}" → ${results.length} results`);
    }
  } catch(err) {
    console.log(`Error on query ${i+1}:`, err.message);
  }
  
  await sleep(1200);
}

console.log('\n=== New V/U codes found ===');
const newCodes = [...foundCodes.entries()].filter(([code]) => 
  code.length >= 4 && /^[VU][A-Z]{2}/.test(code)
);
console.log(`Total new codes: ${newCodes.length}`);
newCodes.forEach(([code, data]) => {
  console.log(`\n${code}:`);
  console.log('  URL:', data.urls[0]);
  console.log('  Snippet:', data.snippets[0]?.slice(0, 150));
});

// Also try fetching the Flex wiki via a Google cache or mirror
console.log('\n=== Attempting Flex wiki via alternative access ===');
try {
  const wikiResp = await fetch('https://www.reddit.com/r/AmazonFlexDrivers/wiki/lists/warehouses.json?raw_json=1', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    }
  });
  if (wikiResp.ok) {
    const wikiData = await wikiResp.json();
    const content = wikiData?.data?.content_md || wikiData?.data?.description || '';
    console.log('Wiki content length:', content.length);
    if (content.length > 100) {
      const wikicodes = [...content.matchAll(codeRe)].map(m => m[1]).filter(c => !existingCodes.has(c));
      const uniqueNew = [...new Set(wikicodes)].filter(c => /^[VU][A-Z]{2}/.test(c));
      console.log('New V/U codes from wiki:', uniqueNew.join(', '));
    }
  } else {
    console.log('Wiki status:', wikiResp.status);
  }
} catch(err) {
  console.log('Wiki error:', err.message);
}

db.close();
