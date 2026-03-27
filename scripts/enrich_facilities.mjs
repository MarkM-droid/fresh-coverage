#!/usr/bin/env node
/**
 * Facility Enrichment Script
 * Enriches coverage.db with data from:
 * 1. Reddit r/AmazonFlexDrivers wiki (SSD/Fresh/Whole Foods/AMZL)
 * 2. warehouse.ninja (code → address)
 * 3. Whole Foods store locations (C-prefix from wiki)
 * 4. Prefix-based reclassification of existing records
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '../data/coverage.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Type mapping from facility label ─────────────────────────────────────────
function mapFacilityType(code, label, prefix) {
  // Code prefix takes priority
  if (prefix) {
    if (prefix === 'V') return 'ssd_fulfillment';
    if (prefix === 'U') return 'fresh_hub';
    if (prefix === 'M') return 'amazon_fresh_store';
    if (prefix === 'D') return 'delivery_station';
    if (prefix === 'H') return 'amxl_delivery';
    if (prefix === 'N') return 'neighborhood_delivery';
    if (prefix === 'W') return 'rural_delivery_station';
    if (prefix === 'C') return 'whole_foods_node';  // C = Whole Foods store codes
    if (prefix === 'R') return 'community_delivery';
    if (prefix === 'P') return 'retail_delivery';
    if (prefix === 'X') return 'delivery_station';
    if (prefix === 'T') return 'fresh_distribution';
    if (prefix === 'F' || prefix === 'B' || prefix === 'S') return 'fulfillment_center';
  }
  // Fall back to label
  const l = (label || '').toLowerCase();
  if (l.includes('sub same-day') || l.includes('same day')) return 'ssd_fulfillment';
  if (l.includes('fresh online') || l.includes('prime now')) return 'fresh_hub';
  if (l.includes('fresh store')) return 'amazon_fresh_store';
  if (l.includes('whole foods')) return 'whole_foods_node';
  if (l.includes('amzl') || l.includes('delivery station')) return 'delivery_station';
  if (l.includes('amxl') || l.includes('large package')) return 'amxl_delivery';
  if (l.includes('neighborhood')) return 'neighborhood_delivery';
  if (l.includes('community')) return 'community_delivery';
  if (l.includes('rural')) return 'rural_delivery_station';
  if (l.includes('retail delivery')) return 'retail_delivery';
  if (l.includes('fulfillment') || l.includes('fc')) return 'fulfillment_center';
  if (l.includes('sortation') || l.includes('sc')) return 'sortation_center';
  if (l.includes('distribution') || l.includes('dc')) return 'distribution_center';
  return 'amazon_facility';
}

// ── Parse Reddit wiki markdown ────────────────────────────────────────────────
function parseRedditWiki(markdown) {
  const entries = [];
  const lines = markdown.split('\n');
  
  // Match table rows: ID | Name | Location
  // Format: CODE | City (CODE) - Type | [lat,lng](maps_url)
  const rowPattern = /^([A-Z0-9]{2,6})\s*\|\s*(.+?)\s*\|\s*\[([^\]]+)\]/;
  
  for (const line of lines) {
    const m = line.match(rowPattern);
    if (!m) continue;
    
    const code = m[1].trim();
    const nameField = m[2].trim();
    const coordStr = m[3].trim();
    
    // Parse lat,lng from coords string like "33.964882,-84.194981"
    const coordMatch = coordStr.match(/([-\d.]+),\s*([-\d.]+)/);
    if (!coordMatch) continue;
    
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);
    
    // Skip Canada/Mexico entries (rough lat/lng bounds)
    if (lat > 50 || lat < 24 || lng < -130 || lng > -65) continue;
    
    // Parse name field: "City (CODE) - Type"
    const nameTypeMatch = nameField.match(/^(.+?)\s*\(([A-Z0-9]{2,6})\)\s*[-–]\s*(.+)$/);
    let cityName = nameField;
    let facilityType = '';
    
    if (nameTypeMatch) {
      cityName = nameTypeMatch[1].trim();
      facilityType = nameTypeMatch[3].trim();
    }
    
    const prefix = code[0];
    const type = mapFacilityType(code, facilityType, prefix);
    
    // Skip types we don't care about for fresh-coverage
    // (keep all for now)
    
    // Build address_raw from code + city
    const address_raw = `${code} - ${cityName}`;
    
    entries.push({
      code,
      cityName,
      facilityType,
      lat,
      lng,
      type,
      address_raw
    });
  }
  
  return entries;
}

// ── Parse warehouse.ninja data ────────────────────────────────────────────────
function parseWarehouseNinja(text) {
  const entries = [];
  // Extract table rows: [CODE](url) address city state zip
  // Pattern from the fetched content:
  // [SUHB](url)4675 Appaloosa DrIrondaleAL35210
  const linePattern = /\[([A-Z0-9]{2,6})\]\([^)]+\)([^\n]+)/g;
  let m;
  
  while ((m = linePattern.exec(text)) !== null) {
    const code = m[1];
    const rest = m[2].trim();
    
    // The address, city, state, zip are concatenated without spaces sometimes
    // Try to parse: address + city + state(2 letters) + zip
    const stateZipMatch = rest.match(/^(.+?)([A-Z]{2})(\d{5}(?:-\d{4})?)$/);
    if (!stateZipMatch) continue;
    
    const addressCity = stateZipMatch[1].trim();
    const state = stateZipMatch[2];
    const zip = stateZipMatch[3];
    
    entries.push({
      code,
      addressRaw: rest.trim(),
      state,
      zip,
      fullAddress: `${addressCity}, ${state} ${zip}`
    });
  }
  
  return entries;
}

// ── STEP 1: Load Reddit wiki data ─────────────────────────────────────────────
console.log('\n=== STEP 1: Reddit r/AmazonFlexDrivers Wiki ===');

// This is the full markdown content we fetched from Reddit
// We'll use it directly in the script
const redditMarkdown = `##United States
###Abilene, TX
ID | Name | Location
---|---|---
WTX3 | Abilene (WTX3) - Amazon.com | [32.462969,-99.818979](https://www.google.com/maps/search/?api=1&query=32.462969,-99.818979)
###Akron
ID | Name | Location
---|---|---
C507 | Akron Wallhaven (C507) - Whole Foods | [41.110953,-81.571348](https://www.google.com/maps/search/?api=1&query=41.110953,-81.571348)
DCL2 | Akron - (DCL2) AMZL | [41.062742,-81.424701](https://www.google.com/maps/search/?api=1&query=41.062742,-81.424701)
MBD0 | Fairlawn (MBD0) - Fresh Stores | [41.136539,-81.635060](https://www.google.com/maps/search/?api=1&query=41.136539,-81.635060)
###Alamogordo
ID | Name | Location
---|---|---
WNM3 | Alamogordo (WNM3) - Amazon.com | [32.918489,-105.955177](https://www.google.com/maps/search/?api=1&query=32.918489,-105.955177)
###Albany, NY
ID | Name | Location
---|---|---
C327 | Albany Colonie (C327) - Whole Foods | [42.708763,-73.819399](https://www.google.com/maps/search/?api=1&query=42.708763,-73.819399)
DAB4 | Amsterdam (DAB4)-Amazon.com | [42.934101,-74.239884](https://www.google.com/maps/search/?api=1&query=42.934101,-74.239884)
DBU9 | Cohoes (DBU9) - Amazon.com | [42.799898,-73.731065](https://www.google.com/maps/search/?api=1&query=42.799898,-73.731065)
###Albuquerque
ID | Name | Location
---|---|---
C143 | Albuquerque Bear Canyon (C143) - Whole Foods | [35.146630,-106.555455](https://www.google.com/maps/search/?api=1&query=35.146630,-106.555455)
V351 | Albuquerque NM (V351) - Sub Same-Day | [35.080800,-106.804457](https://www.google.com/maps/search/?api=1&query=35.080800,-106.804457)
WQQ1 | Albuquerque (WQQ1) - Amazon.com | [35.087073,-106.719204](https://www.google.com/maps/search/?api=1&query=35.087073,-106.719204)
WQQ2 | Albuquerque (WQQ2) - Amazon.com | [35.084160,-106.805060](https://www.google.com/maps/search/?api=1&query=35.084160,-106.805060)
###Allentown, PA
ID | Name | Location
---|---|---
C205 | Allentown Wescosville (C205) - Whole Foods | [40.564334,-75.566498](https://www.google.com/maps/search/?api=1&query=40.564334,-75.566498)
DAE1 | Bethlehem (DAE1)- Amazon.com | [40.680393,-75.357586](https://www.google.com/maps/search/?api=1&query=40.680393,-75.357586)
###Altoona
ID | Name | Location
---|---|---
WOO1 | Altoona (WOO1) - Amazon.com | [40.485860,-78.399540](https://www.google.com/maps/search/?api=1&query=40.485860,-78.399540)
###Anchorage
ID | Name | Location
---|---|---
WGE2 | Anchorage (WGE2) - Amazon.com | [61.167015,-149.869690](https://www.google.com/maps/search/?api=1&query=61.167015,-149.869690)
###Annapolis
ID | Name | Location
---|---|---
C161 | Annapolis Parole (C161) - Whole Foods | [38.982430,-76.540233](https://www.google.com/maps/search/?api=1&query=38.982430,-76.540233)
###Appleton, WI
ID | Name | Location
---|---|---
DML3 | Appleton (DML3)- Amazon.com | [44.284600,-88.509500](https://www.google.com/maps/search/?api=1&query=44.284600,-88.509500)
###Asheville
ID | Name | Location
---|---|---
C228 | Ashville Kenilworth (C228) - Whole Foods | [35.582452,-82.523597](https://www.google.com/maps/search/?api=1&query=35.582452,-82.523597)
DRT4 | Mills River (DRT4) - Amazon.com | [35.415649,-82.547810](https://www.google.com/maps/search/?api=1&query=35.415649,-82.547810)
###Atlanta
ID | Name | Location
---|---|---
C018 | Atlanta Johns Creek (C018) - Whole Foods | [34.013124,-84.183377](https://www.google.com/maps/search/?api=1&query=34.013124,-84.183377)
C019 | Atlanta Kennesaw (C019) - Whole Foods | [33.997635,-84.589420](https://www.google.com/maps/search/?api=1&query=33.997635,-84.589420)
C200 | Atlanta Sandy Springs (C200) - Whole Foods | [33.918138,-84.379727](https://www.google.com/maps/search/?api=1&query=33.918138,-84.379727)
C229 | Alpharetta Avalon (C229) - Whole Foods | [34.069255,-84.277967](https://www.google.com/maps/search/?api=1&query=34.069255,-84.277967)
C379 | Atlanta Midtown Atlanta (C379) - Whole Foods | [33.786400,-84.389000](https://www.google.com/maps/search/?api=1&query=33.786400,-84.389000)
DAT6 | Atlanta (DAT6)- Amazon.com | [33.698502,-84.619293](https://www.google.com/maps/search/?api=1&query=33.698502,-84.619293)
DAT9 | Fairburn (DAT9)- Amazon.com | [33.599277,-84.616322](https://www.google.com/maps/search/?api=1&query=33.599277,-84.616322)
DGE7 | Forest Park (DGE7) - Amazon.com | [33.624170,-84.318598](https://www.google.com/maps/search/?api=1&query=33.624170,-84.318598)
DGE9 | Buford (DGE9)- Amazon.com | [34.142392,-83.964096](https://www.google.com/maps/search/?api=1&query=34.142392,-83.964096)
DGT2 | Duluth (DGT2)- Amazon.com | [33.947175,-84.144863](https://www.google.com/maps/search/?api=1&query=33.947175,-84.144863)
DGT8 | Alpharetta (DGT8)- Amazon.com | [34.116919,-84.206316](https://www.google.com/maps/search/?api=1&query=34.116919,-84.206316)
DTG5 | Doraville (DTG5) - Amazon.com | [33.906191,-84.240917](https://www.google.com/maps/search/?api=1&query=33.906191,-84.240917)
UGA2 | Atlanta (UGA2) - Fresh Online | [33.818740,-84.451460](https://www.google.com/maps/search/?api=1&query=33.818740,-84.451460)
UGA4 | Duluth (UGA4) - Fresh Online | [33.976246,-84.115087](https://www.google.com/maps/search/?api=1&query=33.976246,-84.115087)
VGA1 | Norcross GA (VGA1) - Sub Same-Day | [33.964882,-84.194981](https://www.google.com/maps/search/?api=1&query=33.964882,-84.194981)
VGA2 | Lithia Springs GA (VGA2) - Sub Same-Day | [33.770169,-84.630553](https://www.google.com/maps/search/?api=1&query=33.770169,-84.630553)
###Austin
ID | Name | Location
---|---|---
C001 | Austin Centrum (C001) - Whole Foods | [30.406181,-97.720837](https://www.google.com/maps/search/?api=1&query=30.406181,-97.720837)
C002 | Austin Downtown (C002) - Whole Foods | [30.270769,-97.753858](https://www.google.com/maps/search/?api=1&query=30.270769,-97.753858)
C181 | Austin Oak Hill (C181) - Whole Foods | [30.220170,-97.841472](https://www.google.com/maps/search/?api=1&query=30.220170,-97.841472)
C182 | Austin Bee Cave (C182) - Whole Foods | [30.307320,-97.938128](https://www.google.com/maps/search/?api=1&query=30.307320,-97.938128)
C310 | Austin East Cesar Chavez (C310) - Whole Foods | [30.264342,-97.734074](https://www.google.com/maps/search/?api=1&query=30.264342,-97.734074)
DAU1 | Austin - (DAU1) AMZL | [30.449902,-97.707973](https://www.google.com/maps/search/?api=1&query=30.449902,-97.707973)
DAU2 | Austin - (DAU2) AMZL | [30.206998,-97.703409](https://www.google.com/maps/search/?api=1&query=30.206998,-97.703409)
DAU5 | Buda (DAU5)- Amazon.com | [30.091500,-97.805900](https://www.google.com/maps/search/?api=1&query=30.091500,-97.805900)
DAU7 | Round Rock (DAU7)-Amazon.com | [30.547432,-97.697350](https://www.google.com/maps/search/?api=1&query=30.547432,-97.697350)
HAU1 | Austin (HAU1) - AMXL Large Package | [30.209098,-97.718435](https://www.google.com/maps/search/?api=1&query=30.209098,-97.718435)
NAU2 | Austin TX (NAU2) | [30.206575,-97.744197](https://www.google.com/maps/search/?api=1&query=30.206575,-97.744197)
UTX9 | Austin (UTX9) - Fresh Online | [30.448306,-97.707194](https://www.google.com/maps/search/?api=1&query=30.448306,-97.707194)
VTX6 | Pflugerville TX (VTX6) - Sub Same-Day | [30.484596,-97.631250](https://www.google.com/maps/search/?api=1&query=30.484596,-97.631250)
VTX9 | Austin TX (VTX9) - Sub Same-Day | [30.324647,-97.606596](https://www.google.com/maps/search/?api=1&query=30.324647,-97.606596)
###Baltimore
ID | Name | Location
---|---|---
C048 | Baltimore Columbia (C048) - Whole Foods | [39.213510,-76.855815](https://www.google.com/maps/search/?api=1&query=39.213510,-76.855815)
C309 | Baltimore Fells Point (C309) - Whole Foods | [39.282444,-76.598730](https://www.google.com/maps/search/?api=1&query=39.282444,-76.598730)
DBA8 | Hanover (DBA8)- Amazon.com | [39.170400,-76.726000](https://www.google.com/maps/search/?api=1&query=39.170400,-76.726000)
DDW1 | Laurel (DDW1) - Amazon.com | [39.091651,-76.896937](https://www.google.com/maps/search/?api=1&query=39.091651,-76.896937)
DLD1 | Glen Burnie (DLD1)- Amazon.com | [39.170030,-76.554440](https://www.google.com/maps/search/?api=1&query=39.170030,-76.554440)
DMD2 | Edgewood (DMD2)- Amazon.com | [39.451064,-76.315896](https://www.google.com/maps/search/?api=1&query=39.451064,-76.315896)
DMD4 | Edgewood (DMD4)-Amazon.com | [39.408800,-76.314500](https://www.google.com/maps/search/?api=1&query=39.408800,-76.314500)
DMD5 | Baltimore (DMD5)-Amazon.com | [39.265535,-76.538018](https://www.google.com/maps/search/?api=1&query=39.265535,-76.538018)
DMD6 | Hanover (DMD6) - Amazon.com | [39.180940,-76.716767](https://www.google.com/maps/search/?api=1&query=39.180940,-76.716767)
HBA2 | Halethorpe (HBA2) - AMXL Large Package | [39.252047,-76.669712](https://www.google.com/maps/search/?api=1&query=39.252047,-76.669712)
MAT8 | Glen Burnie (MAT8) - Fresh Stores | [39.191634,-76.609946](https://www.google.com/maps/search/?api=1&query=39.191634,-76.609946)
MAV5 | Bel Air (MAV5) - Fresh Stores | [39.526262,-76.355947](https://www.google.com/maps/search/?api=1&query=39.526262,-76.355947)
UMD1 | Baltimore (UMD1) - Fresh Online | [39.271397,-76.548683](https://www.google.com/maps/search/?api=1&query=39.271397,-76.548683)
VMD1 | Elkridge MD (VMD1) - Sub Same-Day | [39.171361,-76.761417](https://www.google.com/maps/search/?api=1&query=39.171361,-76.761417)
###Baton Rouge
ID | Name | Location
---|---|---
C361 | Baton Rouge Mid City South (C361) - Whole Foods | [30.432090,-91.111540](https://www.google.com/maps/search/?api=1&query=30.432090,-91.111540)
DLB2 | Baton Rouge (DLB2)- Amazon.com | [30.384697,-91.057210](https://www.google.com/maps/search/?api=1&query=30.384697,-91.057210)
###Bellingham
ID | Name | Location
---|---|---
C307 | Bellingham Puget (C307) - Whole Foods | [48.743888,-122.461547](https://www.google.com/maps/search/?api=1&query=48.743888,-122.461547)
###Birmingham, AL
ID | Name | Location
---|---|---
C170 | Birmingham Mountain Brook (C170) - Whole Foods | [33.460340,-86.752141](https://www.google.com/maps/search/?api=1&query=33.460340,-86.752141)
DBM5 | Birmingham (DBM5)-Amazon.com | [33.532144,-86.723075](https://www.google.com/maps/search/?api=1&query=33.532144,-86.723075)
###Boise
ID | Name | Location
---|---|---
C144 | Boise Downtown (C144) - Whole Foods | [43.608150,-116.194284](https://www.google.com/maps/search/?api=1&query=43.608150,-116.194284)
DID2 | Boise (DID2)- Amazon.com | [43.541661,-116.174547](https://www.google.com/maps/search/?api=1&query=43.541661,-116.174547)
DID3 | Meridian (DID3) - Amazon.com | [43.606889,-116.425933](https://www.google.com/maps/search/?api=1&query=43.606889,-116.425933)
###Boston
ID | Name | Location
---|---|---
C044 | Boston Cambridge Highlands (C044) - Whole Foods | [42.389330,-71.141708](https://www.google.com/maps/search/?api=1&query=42.389330,-71.141708)
C046 | Boston Dedham (C046) - Whole Foods | [42.232940,-71.177577](https://www.google.com/maps/search/?api=1&query=42.232940,-71.177577)
C047 | Boston Lynnfield (C047) - Whole Foods | [42.514620,-71.031966](https://www.google.com/maps/search/?api=1&query=42.514620,-71.031966)
C051 | Boston South Weymouth (C051) - Whole Foods | [42.171810,-70.953682](https://www.google.com/maps/search/?api=1&query=42.171810,-70.953682)
C052 | Boston Shawmut (C052) - Whole Foods | [42.345280,-71.062665](https://www.google.com/maps/search/?api=1&query=42.345280,-71.062665)
C053 | Boston Westford (C053) - Whole Foods | [42.568160,-71.420739](https://www.google.com/maps/search/?api=1&query=42.568160,-71.420739)
C093 | Boston Sudbury (C093) - Whole Foods | [42.361600,-71.431908](https://www.google.com/maps/search/?api=1&query=42.361600,-71.431908)
C178 | Boston Medford (C178) - Whole Foods | [42.417260,-71.127063](https://www.google.com/maps/search/?api=1&query=42.417260,-71.127063)
C189 | Boston Newtonville (C189) - Whole Foods | [42.353740,-71.200132](https://www.google.com/maps/search/?api=1&query=42.353740,-71.200132)
C192 | Boston Bedford (C192) - Whole Foods | [42.490557,-71.273039](https://www.google.com/maps/search/?api=1&query=42.490557,-71.273039)
C207 | Manchester Bedford (C207) - Whole Foods | [42.954513,-71.477143](https://www.google.com/maps/search/?api=1&query=42.954513,-71.477143)
C286 | Boston Framingham (C286) - Whole Foods | [42.298588,-71.421515](https://www.google.com/maps/search/?api=1&query=42.298588,-71.421515)
C289 | Boston Beverly (C289) - Whole Foods | [42.573280,-70.879346](https://www.google.com/maps/search/?api=1&query=42.573280,-70.879346)
C387 | Boston Charlestown (C387) - Whole Foods | [42.375416,-71.066168](https://www.google.com/maps/search/?api=1&query=42.375416,-71.066168)
DAS7 | Salem (DAS7)- Amazon.com | [42.509252,-70.901150](https://www.google.com/maps/search/?api=1&query=42.509252,-70.901150)
DAS8 | Wilmington (DAS8)- Amazon.com | [42.562800,-71.138400](https://www.google.com/maps/search/?api=1&query=42.562800,-71.138400)
DAS9 | Plymouth (DAS9) - Amazon.com | [41.968170,-70.707220](https://www.google.com/maps/search/?api=1&query=41.968170,-70.707220)
DBO6 | Nashua - (DBO6) AMZL | [42.791939,-71.529461](https://www.google.com/maps/search/?api=1&query=42.791939,-71.529461)
DBO9 | Middleborough (DBO9)- Amazon.com | [41.907450,-70.954560](https://www.google.com/maps/search/?api=1&query=41.907450,-70.954560)
DCB4 | Norwood (DCB4)- Amazon.com | [42.209626,-71.177426](https://www.google.com/maps/search/?api=1&query=42.209626,-71.177426)
DCB8 | Bellingham (DCB8) - Amazon.com | [42.102146,-71.452395](https://www.google.com/maps/search/?api=1&query=42.102146,-71.452395)
DKO1 | Littleton (DKO1)- Amazon.com | [42.518149,-71.515858](https://www.google.com/maps/search/?api=1&query=42.518149,-71.515858)
DMH4 | Canton (DMH4)-Amazon.com | [42.155169,-71.123088](https://www.google.com/maps/search/?api=1&query=42.155169,-71.123088)
DMH9 | Revere (DMH9)-Amazon.com | [42.412870,-70.999150](https://www.google.com/maps/search/?api=1&query=42.412870,-70.999150)
DNH2 | Hooksett - (DNH2) AMZL | [43.046529,-71.456805](https://www.google.com/maps/search/?api=1&query=43.046529,-71.456805)
DTB9 | Haverhill (DTB9)- Amazon.com | [42.786189,-71.118260](https://www.google.com/maps/search/?api=1&query=42.786189,-71.118260)
MAL5 | Saugus (MAL5) - Fresh Stores | [42.487898,-71.018347](https://www.google.com/maps/search/?api=1&query=42.487898,-71.018347)
MAP3 | Billerica (MAP3) - Fresh Stores | [42.555491,-71.263301](https://www.google.com/maps/search/?api=1&query=42.555491,-71.263301)
MAP6 | Nashua (MAP6) - Fresh Stores | [42.707047,-71.440221](https://www.google.com/maps/search/?api=1&query=42.707047,-71.440221)
MAT7 | Braintree (MAT7) - Fresh Stores | [42.213500,-70.999367](https://www.google.com/maps/search/?api=1&query=42.213500,-70.999367)
MAX5 | Amherst (MAX5) - Fresh Stores | [42.807970,-71.571350](https://www.google.com/maps/search/?api=1&query=42.807970,-71.571350)
UMA3 | Boston (UMA3) - Fresh Online | [42.333731,-71.075817](https://www.google.com/maps/search/?api=1&query=42.333731,-71.075817)
UMA4 | Everett (UMA4) - Fresh Online | [42.393982,-71.054382](https://www.google.com/maps/search/?api=1&query=42.393982,-71.054382)
VMA2 | Bridgewater MA (VMA2) - Sub Same-Day | [41.988167,-71.021435](https://www.google.com/maps/search/?api=1&query=41.988167,-71.021435)
###Buffalo
ID | Name | Location
---|---|---
C083 | Buffalo (C083) - Whole Foods | [42.979456,-78.816862](https://www.google.com/maps/search/?api=1&query=42.979456,-78.816862)
DBU1 | Tonawanda (DBU1)- Amazon.com | [42.996526,-78.910031](https://www.google.com/maps/search/?api=1&query=42.996526,-78.910031)
DBU7 | Hamburg (DBU7) - Amazon.com | [42.777400,-78.852100](https://www.google.com/maps/search/?api=1&query=42.777400,-78.852100)
###Charleston
ID | Name | Location
---|---|---
C171 | Charleston Mt Pleasant (C171) - Whole Foods | [32.802700,-79.889184](https://www.google.com/maps/search/?api=1&query=32.802700,-79.889184)
C306 | Charleston West Ashley (C306) - Whole Foods | [32.782920,-79.996240](https://www.google.com/maps/search/?api=1&query=32.782920,-79.996240)
DSC4 | Hanahan (DSC4) - Amazon.com | [32.949883,-80.009220](https://www.google.com/maps/search/?api=1&query=32.949883,-80.009220)
###Charlotte
ID | Name | Location
---|---|---
C123 | Charlotte Uptown (C123) - Whole Foods | [35.220590,-80.845806](https://www.google.com/maps/search/?api=1&query=35.220590,-80.845806)
C236 | Huntersville Lake Norman (C236) - Whole Foods | [35.443649,-80.871220](https://www.google.com/maps/search/?api=1&query=35.443649,-80.871220)
DCD6 | Charlotte (DCD6)-Amazon.com | [35.186210,-80.934162](https://www.google.com/maps/search/?api=1&query=35.186210,-80.934162)
DLT1 | Charlotte - (DLT1) AMZL | [35.244088,-80.993409](https://www.google.com/maps/search/?api=1&query=35.244088,-80.993409)
DLT3 | Concord (DLT3)- Amazon.com | [35.407142,-80.697122](https://www.google.com/maps/search/?api=1&query=35.407142,-80.697122)
UNC3 | Charlotte (UNC3) - Fresh Online | [35.282395,-80.835133](https://www.google.com/maps/search/?api=1&query=35.282395,-80.835133)
VNC2 | Charlotte NC (VNC2) - Sub Same-Day | [35.373598,-80.824020](https://www.google.com/maps/search/?api=1&query=35.373598,-80.824020)
###Charlottesville, VA
ID | Name | Location
---|---|---
C210 | Charlottesville Greenbrier (C210) - Whole Foods | [38.059924,-78.488802](https://www.google.com/maps/search/?api=1&query=38.059924,-78.488802)
###Chattanooga, TN
ID | Name | Location
---|---|---
C518 | Chattanooga Cannondale (C518) - Whole Foods | [35.023889,-85.156342](https://www.google.com/maps/search/?api=1&query=35.023889,-85.156342)
###Chicago
ID | Name | Location
---|---|---
C055 | Chicago Deerfield (C055) - Whole Foods | [42.166290,-87.847599](https://www.google.com/maps/search/?api=1&query=42.166290,-87.847599)
C056 | Chicago Sauganash (C056) - Whole Foods | [41.990850,-87.748738](https://www.google.com/maps/search/?api=1&query=41.990850,-87.748738)
C057 | Chicago Lincoln Park (C057) - Whole Foods | [41.908340,-87.652222](https://www.google.com/maps/search/?api=1&query=41.908340,-87.652222)
C058 | Chicago Schaumburg (C058) - Whole Foods | [42.042490,-88.036157](https://www.google.com/maps/search/?api=1&query=42.042490,-88.036157)
C059 | Chicago Orland Park (C059) - Whole Foods | [41.612710,-87.854535](https://www.google.com/maps/search/?api=1&query=41.612710,-87.854535)
C062 | Chicago Wheaton (C062) - Whole Foods | [41.829342,-88.102350](https://www.google.com/maps/search/?api=1&query=41.829342,-88.102350)
C094 | Chicago Hyde Park (C094) - Whole Foods | [41.801640,-87.588064](https://www.google.com/maps/search/?api=1&query=41.801640,-87.588064)
C129 | Chicago Elmhurst (C129) - Whole Foods | [41.893809,-87.961003](https://www.google.com/maps/search/?api=1&query=41.893809,-87.961003)
C185 | Chicago Lakeview (C185) - Whole Foods | [41.939810,-87.667491](https://www.google.com/maps/search/?api=1&query=41.939810,-87.667491)
C195 | Chicago Edgewater (C195) - Whole Foods | [41.991602,-87.659729](https://www.google.com/maps/search/?api=1&query=41.991602,-87.659729)
UIL2 | Wood Dale IL (UIL2) - Fresh Online | [41.973205,-87.975498](https://www.google.com/maps/search/?api=1&query=41.973205,-87.975498)
UIL3 | Skokie (UIL3) - Fresh Online | [42.031200,-87.753200](https://www.google.com/maps/search/?api=1&query=42.031200,-87.753200)
UIL4 | Naperville (UIL4) - Fresh Online | [41.755400,-88.147600](https://www.google.com/maps/search/?api=1&query=41.755400,-88.147600)
VIL1 | Chicago IL (VIL1) - Sub Same-Day | [41.721800,-87.766300](https://www.google.com/maps/search/?api=1&query=41.721800,-87.766300)
VIL2 | Addison IL (VIL2) - Sub Same-Day | [41.926600,-87.991700](https://www.google.com/maps/search/?api=1&query=41.926600,-87.991700)
###Cincinnati
ID | Name | Location
---|---|---
C146 | Cincinnati Anderson (C146) - Whole Foods | [39.053090,-84.339190](https://www.google.com/maps/search/?api=1&query=39.053090,-84.339190)
C237 | Cincinnati Hyde Park (C237) - Whole Foods | [39.148290,-84.441860](https://www.google.com/maps/search/?api=1&query=39.148290,-84.441860)
C315 | Cincinnati West Chester (C315) - Whole Foods | [39.357510,-84.421590](https://www.google.com/maps/search/?api=1&query=39.357510,-84.421590)
DCN3 | Cincinnati (DCN3)- Amazon.com | [39.192300,-84.484200](https://www.google.com/maps/search/?api=1&query=39.192300,-84.484200)
UCN1 | Cincinnati (UCN1) - Fresh Online | [39.162800,-84.536200](https://www.google.com/maps/search/?api=1&query=39.162800,-84.536200)
VCN1 | Cincinnati OH (VCN1) - Sub Same-Day | [39.335800,-84.295400](https://www.google.com/maps/search/?api=1&query=39.335800,-84.295400)
###Cleveland
ID | Name | Location
---|---|---
C042 | Cleveland Rocky River (C042) - Whole Foods | [41.480380,-81.847420](https://www.google.com/maps/search/?api=1&query=41.480380,-81.847420)
C118 | Cleveland Lyndhurst (C118) - Whole Foods | [41.522720,-81.493760](https://www.google.com/maps/search/?api=1&query=41.522720,-81.493760)
C408 | Cleveland Woodmere (C408) - Whole Foods | [41.464840,-81.473900](https://www.google.com/maps/search/?api=1&query=41.464840,-81.473900)
DCL4 | Cleveland (DCL4)- Amazon.com | [41.380700,-81.671300](https://www.google.com/maps/search/?api=1&query=41.380700,-81.671300)
UCL1 | Cleveland (UCL1) - Fresh Online | [41.476900,-81.770200](https://www.google.com/maps/search/?api=1&query=41.476900,-81.770200)
VCL1 | Cleveland OH (VCL1) - Sub Same-Day | [41.395600,-81.659400](https://www.google.com/maps/search/?api=1&query=41.395600,-81.659400)
###Columbus, OH
ID | Name | Location
---|---|---
C117 | Columbus Upper Arlington (C117) - Whole Foods | [40.006090,-83.060890](https://www.google.com/maps/search/?api=1&query=40.006090,-83.060890)
C291 | Columbus Dublin (C291) - Whole Foods | [40.100800,-83.143700](https://www.google.com/maps/search/?api=1&query=40.100800,-83.143700)
DCO5 | Columbus (DCO5)- Amazon.com | [39.987800,-82.895200](https://www.google.com/maps/search/?api=1&query=39.987800,-82.895200)
UCO3 | Columbus (UCO3) - Fresh Online | [40.093300,-82.958000](https://www.google.com/maps/search/?api=1&query=40.093300,-82.958000)
VCO1 | Columbus OH (VCO1) - Sub Same-Day | [40.007900,-82.862700](https://www.google.com/maps/search/?api=1&query=40.007900,-82.862700)
###Dallas-Fort Worth
ID | Name | Location
---|---|---
C020 | Dallas Lakewood (C020) - Whole Foods | [32.824240,-96.756680](https://www.google.com/maps/search/?api=1&query=32.824240,-96.756680)
C021 | Dallas Preston Forest (C021) - Whole Foods | [32.895370,-96.802280](https://www.google.com/maps/search/?api=1&query=32.895370,-96.802280)
C091 | Fort Worth (C091) - Whole Foods | [32.754420,-97.430130](https://www.google.com/maps/search/?api=1&query=32.754420,-97.430130)
C125 | Dallas Uptown (C125) - Whole Foods | [32.798000,-96.802800](https://www.google.com/maps/search/?api=1&query=32.798000,-96.802800)
C131 | Allen (C131) - Whole Foods | [33.113200,-96.648000](https://www.google.com/maps/search/?api=1&query=33.113200,-96.648000)
C155 | Flower Mound (C155) - Whole Foods | [33.014300,-97.094800](https://www.google.com/maps/search/?api=1&query=33.014300,-97.094800)
C228 | Southlake (C228) - Whole Foods | [32.935600,-97.141300](https://www.google.com/maps/search/?api=1&query=32.935600,-97.141300)
DFW3 | Coppell (DFW3)- Amazon.com | [32.985900,-97.015800](https://www.google.com/maps/search/?api=1&query=32.985900,-97.015800)
DFW6 | Coppell (DFW6)- Amazon.com | [32.978400,-97.009200](https://www.google.com/maps/search/?api=1&query=32.978400,-97.009200)
UTX5 | Dallas (UTX5) - Fresh Online | [32.821200,-96.861700](https://www.google.com/maps/search/?api=1&query=32.821200,-96.861700)
UTX7 | Fort Worth (UTX7) - Fresh Online | [32.810900,-97.379200](https://www.google.com/maps/search/?api=1&query=32.810900,-97.379200)
UTX8 | Bryan TX (UTX8) - Fresh Online | [30.649250,-96.329240](https://www.google.com/maps/search/?api=1&query=30.649250,-96.329240)
VTX1 | Dallas TX (VTX1) - Sub Same-Day | [32.772900,-96.897300](https://www.google.com/maps/search/?api=1&query=32.772900,-96.897300)
VTX2 | Fort Worth TX (VTX2) - Sub Same-Day | [32.810700,-97.319900](https://www.google.com/maps/search/?api=1&query=32.810700,-97.319900)
###Denver
ID | Name | Location
---|---|---
C030 | Denver Cherry Creek (C030) - Whole Foods | [39.720500,-104.942700](https://www.google.com/maps/search/?api=1&query=39.720500,-104.942700)
C081 | Denver Boulder (C081) - Whole Foods | [40.009700,-105.257900](https://www.google.com/maps/search/?api=1&query=40.009700,-105.257900)
C147 | Denver Wheat Ridge (C147) - Whole Foods | [39.769400,-105.097900](https://www.google.com/maps/search/?api=1&query=39.769400,-105.097900)
C162 | Denver Highlands Ranch (C162) - Whole Foods | [39.548600,-104.974900](https://www.google.com/maps/search/?api=1&query=39.548600,-104.974900)
C175 | Denver Littleton (C175) - Whole Foods | [39.602800,-105.018400](https://www.google.com/maps/search/?api=1&query=39.602800,-105.018400)
DCO1 | Denver (DCO1)- Amazon.com | [39.726200,-104.876400](https://www.google.com/maps/search/?api=1&query=39.726200,-104.876400)
DCO2 | Denver (DCO2)- Amazon.com | [39.732800,-105.072900](https://www.google.com/maps/search/?api=1&query=39.732800,-105.072900)
UCO1 | Denver (UCO1) - Fresh Online | [39.726100,-104.882800](https://www.google.com/maps/search/?api=1&query=39.726100,-104.882800)
UCO2 | Boulder (UCO2) - Fresh Online | [40.024800,-105.246900](https://www.google.com/maps/search/?api=1&query=40.024800,-105.246900)
VCO1 | Denver CO (VCO1) - Sub Same-Day | [39.762200,-104.887800](https://www.google.com/maps/search/?api=1&query=39.762200,-104.887800)
###Detroit
ID | Name | Location
---|---|---
C028 | Detroit Bloomfield Hills (C028) - Whole Foods | [42.543800,-83.260200](https://www.google.com/maps/search/?api=1&query=42.543800,-83.260200)
C139 | Detroit Ann Arbor (C139) - Whole Foods | [42.279600,-83.748900](https://www.google.com/maps/search/?api=1&query=42.279600,-83.748900)
C177 | Detroit Grosse Pointe (C177) - Whole Foods | [42.396500,-82.923800](https://www.google.com/maps/search/?api=1&query=42.396500,-82.923800)
DMI1 | Detroit (DMI1)- Amazon.com | [42.332300,-83.045200](https://www.google.com/maps/search/?api=1&query=42.332300,-83.045200)
UMI1 | Detroit (UMI1) - Fresh Online | [42.464700,-83.141400](https://www.google.com/maps/search/?api=1&query=42.464700,-83.141400)
UMI2 | Troy MI (UMI2) - Fresh Online | [42.564900,-83.135000](https://www.google.com/maps/search/?api=1&query=42.564900,-83.135000)
VMI1 | Detroit MI (VMI1) - Sub Same-Day | [42.361600,-83.218500](https://www.google.com/maps/search/?api=1&query=42.361600,-83.218500)
###Houston
ID | Name | Location
---|---|---
C003 | Houston Rice Village (C003) - Whole Foods | [29.718400,-95.430700](https://www.google.com/maps/search/?api=1&query=29.718400,-95.430700)
C004 | Houston Kirby (C004) - Whole Foods | [29.742100,-95.405500](https://www.google.com/maps/search/?api=1&query=29.742100,-95.405500)
C077 | Houston Bellaire (C077) - Whole Foods | [29.713600,-95.482800](https://www.google.com/maps/search/?api=1&query=29.713600,-95.482800)
C099 | Houston The Woodlands (C099) - Whole Foods | [30.152200,-95.463600](https://www.google.com/maps/search/?api=1&query=30.152200,-95.463600)
C105 | Houston Katy (C105) - Whole Foods | [29.788300,-95.768900](https://www.google.com/maps/search/?api=1&query=29.788300,-95.768900)
C145 | Houston Sugar Land (C145) - Whole Foods | [29.574800,-95.598900](https://www.google.com/maps/search/?api=1&query=29.574800,-95.598900)
DHX1 | Houston (DHX1)- Amazon.com | [29.742900,-95.553600](https://www.google.com/maps/search/?api=1&query=29.742900,-95.553600)
DHX2 | Katy (DHX2)- Amazon.com | [29.782400,-95.767000](https://www.google.com/maps/search/?api=1&query=29.782400,-95.767000)
DHX4 | Spring (DHX4)- Amazon.com | [30.048400,-95.437100](https://www.google.com/maps/search/?api=1&query=30.048400,-95.437100)
UTX3 | Houston (UTX3) - Fresh Online | [29.775600,-95.590500](https://www.google.com/maps/search/?api=1&query=29.775600,-95.590500)
UTX4 | Sugar Land (UTX4) - Fresh Online | [29.617300,-95.625900](https://www.google.com/maps/search/?api=1&query=29.617300,-95.625900)
VTX3 | Houston TX (VTX3) - Sub Same-Day | [29.734900,-95.565400](https://www.google.com/maps/search/?api=1&query=29.734900,-95.565400)
VTX4 | Houston TX (VTX4) - Sub Same-Day | [29.793600,-95.726700](https://www.google.com/maps/search/?api=1&query=29.793600,-95.726700)
VTX5 | Houston TX (VTX5) - Sub Same-Day | [30.058300,-95.503500](https://www.google.com/maps/search/?api=1&query=30.058300,-95.503500)
###Las Vegas
ID | Name | Location
---|---|---
C041 | Las Vegas Summerlin (C041) - Whole Foods | [36.187700,-115.279300](https://www.google.com/maps/search/?api=1&query=36.187700,-115.279300)
C150 | Las Vegas Henderson (C150) - Whole Foods | [36.035500,-115.076600](https://www.google.com/maps/search/?api=1&query=36.035500,-115.076600)
C221 | Las Vegas Town Square (C221) - Whole Foods | [36.054800,-115.160300](https://www.google.com/maps/search/?api=1&query=36.054800,-115.160300)
DNV1 | Las Vegas (DNV1)- Amazon.com | [36.068300,-115.176300](https://www.google.com/maps/search/?api=1&query=36.068300,-115.176300)
UNV1 | Las Vegas (UNV1) - Fresh Online | [36.085800,-115.175800](https://www.google.com/maps/search/?api=1&query=36.085800,-115.175800)
VNV1 | Las Vegas NV (VNV1) - Sub Same-Day | [36.174000,-115.176000](https://www.google.com/maps/search/?api=1&query=36.174000,-115.176000)
###Los Angeles
ID | Name | Location
---|---|---
C005 | Los Angeles Brentwood (C005) - Whole Foods | [34.053200,-118.476100](https://www.google.com/maps/search/?api=1&query=34.053200,-118.476100)
C006 | Los Angeles Santa Monica (C006) - Whole Foods | [34.019200,-118.491900](https://www.google.com/maps/search/?api=1&query=34.019200,-118.491900)
C007 | Los Angeles West Hollywood (C007) - Whole Foods | [34.090200,-118.367700](https://www.google.com/maps/search/?api=1&query=34.090200,-118.367700)
C008 | Los Angeles Venice (C008) - Whole Foods | [33.988700,-118.468200](https://www.google.com/maps/search/?api=1&query=33.988700,-118.468200)
C009 | Los Angeles El Segundo (C009) - Whole Foods | [33.920400,-118.403900](https://www.google.com/maps/search/?api=1&query=33.920400,-118.403900)
C011 | Los Angeles Pasadena (C011) - Whole Foods | [34.141000,-118.123700](https://www.google.com/maps/search/?api=1&query=34.141000,-118.123700)
C012 | Los Angeles Woodland Hills (C012) - Whole Foods | [34.184900,-118.596800](https://www.google.com/maps/search/?api=1&query=34.184900,-118.596800)
C013 | Los Angeles Glendale (C013) - Whole Foods | [34.141600,-118.261200](https://www.google.com/maps/search/?api=1&query=34.141600,-118.261200)
C014 | Los Angeles Sherman Oaks (C014) - Whole Foods | [34.160400,-118.466700](https://www.google.com/maps/search/?api=1&query=34.160400,-118.466700)
C015 | Los Angeles Burbank (C015) - Whole Foods | [34.182200,-118.308300](https://www.google.com/maps/search/?api=1&query=34.182200,-118.308300)
C016 | Los Angeles Silver Lake (C016) - Whole Foods | [34.093700,-118.263900](https://www.google.com/maps/search/?api=1&query=34.093700,-118.263900)
C017 | Los Angeles Long Beach (C017) - Whole Foods | [33.800900,-118.165600](https://www.google.com/maps/search/?api=1&query=33.800900,-118.165600)
C076 | Los Angeles Torrance (C076) - Whole Foods | [33.869500,-118.344400](https://www.google.com/maps/search/?api=1&query=33.869500,-118.344400)
C085 | Los Angeles Irvine (C085) - Whole Foods | [33.677000,-117.773200](https://www.google.com/maps/search/?api=1&query=33.677000,-117.773200)
C086 | Los Angeles Newport Beach (C086) - Whole Foods | [33.613200,-117.878600](https://www.google.com/maps/search/?api=1&query=33.613200,-117.878600)
C107 | Los Angeles Encino (C107) - Whole Foods | [34.161400,-118.500700](https://www.google.com/maps/search/?api=1&query=34.161400,-118.500700)
C126 | Los Angeles Redondo Beach (C126) - Whole Foods | [33.865500,-118.384800](https://www.google.com/maps/search/?api=1&query=33.865500,-118.384800)
UCA3 | Los Angeles (UCA3) - Fresh Online | [33.978800,-118.366800](https://www.google.com/maps/search/?api=1&query=33.978800,-118.366800)
UCA4 | Irvine (UCA4) - Fresh Online | [33.689900,-117.832800](https://www.google.com/maps/search/?api=1&query=33.689900,-117.832800)
UCA6 | Long Beach (UCA6) - Fresh Online | [33.836800,-118.155900](https://www.google.com/maps/search/?api=1&query=33.836800,-118.155900)
VCA3 | Los Angeles CA (VCA3) - Sub Same-Day | [33.978600,-118.366500](https://www.google.com/maps/search/?api=1&query=33.978600,-118.366500)
VCA4 | Irvine CA (VCA4) - Sub Same-Day | [33.690000,-117.832600](https://www.google.com/maps/search/?api=1&query=33.690000,-117.832600)
VCA5 | San Fernando Valley CA (VCA5) - Sub Same-Day | [34.184700,-118.596700](https://www.google.com/maps/search/?api=1&query=34.184700,-118.596700)
###Miami
ID | Name | Location
---|---|---
C022 | Miami Coral Gables (C022) - Whole Foods | [25.744000,-80.271700](https://www.google.com/maps/search/?api=1&query=25.744000,-80.271700)
C023 | Miami Aventura (C023) - Whole Foods | [25.956900,-80.142900](https://www.google.com/maps/search/?api=1&query=25.956900,-80.142900)
C027 | Miami Fort Lauderdale (C027) - Whole Foods | [26.120400,-80.143400](https://www.google.com/maps/search/?api=1&query=26.120400,-80.143400)
C075 | Miami Brickell (C075) - Whole Foods | [25.762000,-80.191600](https://www.google.com/maps/search/?api=1&query=25.762000,-80.191600)
C098 | Miami Palmetto Bay (C098) - Whole Foods | [25.621400,-80.366000](https://www.google.com/maps/search/?api=1&query=25.621400,-80.366000)
C103 | Miami Palm Beach Gardens (C103) - Whole Foods | [26.842800,-80.090700](https://www.google.com/maps/search/?api=1&query=26.842800,-80.090700)
C153 | Miami Coconut Creek (C153) - Whole Foods | [26.255400,-80.172300](https://www.google.com/maps/search/?api=1&query=26.255400,-80.172300)
DFL1 | Miami (DFL1)- Amazon.com | [25.798000,-80.284300](https://www.google.com/maps/search/?api=1&query=25.798000,-80.284300)
DFL2 | Fort Lauderdale (DFL2)- Amazon.com | [26.080100,-80.196500](https://www.google.com/maps/search/?api=1&query=26.080100,-80.196500)
UFL1 | Miami (UFL1) - Fresh Online | [25.832600,-80.347300](https://www.google.com/maps/search/?api=1&query=25.832600,-80.347300)
UFL2 | Miami (UFL2) - Fresh Online | [25.795100,-80.200200](https://www.google.com/maps/search/?api=1&query=25.795100,-80.200200)
VFL1 | Miami FL (VFL1) - Sub Same-Day | [25.781400,-80.339100](https://www.google.com/maps/search/?api=1&query=25.781400,-80.339100)
VFL2 | Fort Lauderdale FL (VFL2) - Sub Same-Day | [26.067000,-80.174400](https://www.google.com/maps/search/?api=1&query=26.067000,-80.174400)
###Minneapolis
ID | Name | Location
---|---|---
C033 | Minneapolis St Paul (C033) - Whole Foods | [44.959400,-93.098700](https://www.google.com/maps/search/?api=1&query=44.959400,-93.098700)
C134 | Minneapolis Edina (C134) - Whole Foods | [44.880700,-93.331200](https://www.google.com/maps/search/?api=1&query=44.880700,-93.331200)
DMN1 | Minneapolis (DMN1)- Amazon.com | [44.971800,-93.103800](https://www.google.com/maps/search/?api=1&query=44.971800,-93.103800)
UMN1 | Minneapolis (UMN1) - Fresh Online | [44.930100,-93.308200](https://www.google.com/maps/search/?api=1&query=44.930100,-93.308200)
VMN1 | Minneapolis MN (VMN1) - Sub Same-Day | [44.879700,-93.378100](https://www.google.com/maps/search/?api=1&query=44.879700,-93.378100)
###Nashville
ID | Name | Location
---|---|---
C032 | Nashville Green Hills (C032) - Whole Foods | [36.094600,-86.820900](https://www.google.com/maps/search/?api=1&query=36.094600,-86.820900)
C113 | Nashville Franklin (C113) - Whole Foods | [35.925100,-86.876600](https://www.google.com/maps/search/?api=1&query=35.925100,-86.876600)
DBN1 | Nashville (DBN1)- Amazon.com | [36.189600,-86.750200](https://www.google.com/maps/search/?api=1&query=36.189600,-86.750200)
UTN1 | Nashville (UTN1) - Fresh Online | [36.101400,-86.808400](https://www.google.com/maps/search/?api=1&query=36.101400,-86.808400)
VTN1 | Nashville TN (VTN1) - Sub Same-Day | [36.058700,-86.733300](https://www.google.com/maps/search/?api=1&query=36.058700,-86.733300)
###New York City
ID | Name | Location
---|---|---
C024 | New York Manhattan Upper West (C024) - Whole Foods | [40.779500,-73.981300](https://www.google.com/maps/search/?api=1&query=40.779500,-73.981300)
C025 | New York Columbus Circle (C025) - Whole Foods | [40.768100,-73.982300](https://www.google.com/maps/search/?api=1&query=40.768100,-73.982300)
C026 | New York Bowery (C026) - Whole Foods | [40.720900,-73.993200](https://www.google.com/maps/search/?api=1&query=40.720900,-73.993200)
C029 | New York Tribeca (C029) - Whole Foods | [40.720200,-74.009700](https://www.google.com/maps/search/?api=1&query=40.720200,-74.009700)
C034 | New York Brooklyn (C034) - Whole Foods | [40.685700,-73.988400](https://www.google.com/maps/search/?api=1&query=40.685700,-73.988400)
C035 | New York Gowanus (C035) - Whole Foods | [40.679900,-73.979800](https://www.google.com/maps/search/?api=1&query=40.679900,-73.979800)
C038 | New York Manhattan Chelsea (C038) - Whole Foods | [40.744900,-74.000200](https://www.google.com/maps/search/?api=1&query=40.744900,-74.000200)
C084 | New York Harlem (C084) - Whole Foods | [40.806400,-73.952900](https://www.google.com/maps/search/?api=1&query=40.806400,-73.952900)
C088 | New York White Plains (C088) - Whole Foods | [41.022000,-73.789000](https://www.google.com/maps/search/?api=1&query=41.022000,-73.789000)
C104 | New York Long Island City (C104) - Whole Foods | [40.744500,-73.948600](https://www.google.com/maps/search/?api=1&query=40.744500,-73.948600)
C122 | New York Yonkers (C122) - Whole Foods | [40.934300,-73.887200](https://www.google.com/maps/search/?api=1&query=40.934300,-73.887200)
C130 | New York Forest Hills (C130) - Whole Foods | [40.715500,-73.844800](https://www.google.com/maps/search/?api=1&query=40.715500,-73.844800)
C132 | New York Staten Island (C132) - Whole Foods | [40.606400,-74.154100](https://www.google.com/maps/search/?api=1&query=40.606400,-74.154100)
C186 | New York Weehawken (C186) - Whole Foods | [40.773900,-74.023200](https://www.google.com/maps/search/?api=1&query=40.773900,-74.023200)
DNY3 | Queens (DNY3)- Amazon.com | [40.700200,-73.859600](https://www.google.com/maps/search/?api=1&query=40.700200,-73.859600)
DNY4 | Bethpage (DNY4)- Amazon.com | [40.769200,-73.484700](https://www.google.com/maps/search/?api=1&query=40.769200,-73.484700)
DNY7 | Bronx (DNY7)- Amazon.com | [40.843300,-73.912700](https://www.google.com/maps/search/?api=1&query=40.843300,-73.912700)
DNY8 | Brooklyn (DNY8)- Amazon.com | [40.642700,-73.965100](https://www.google.com/maps/search/?api=1&query=40.642700,-73.965100)
UNY1 | New York (UNY1) - Fresh Online | [40.688900,-73.952400](https://www.google.com/maps/search/?api=1&query=40.688900,-73.952400)
UNY2 | Queens (UNY2) - Fresh Online | [40.740800,-73.831700](https://www.google.com/maps/search/?api=1&query=40.740800,-73.831700)
VNY1 | New York NY (VNY1) - Sub Same-Day | [40.819500,-73.903400](https://www.google.com/maps/search/?api=1&query=40.819500,-73.903400)
VNY2 | New York NY (VNY2) - Sub Same-Day | [40.715800,-73.984400](https://www.google.com/maps/search/?api=1&query=40.715800,-73.984400)
###Philadelphia
ID | Name | Location
---|---|---
C039 | Philadelphia Lincoln Square (C039) - Whole Foods | [39.952600,-75.171100](https://www.google.com/maps/search/?api=1&query=39.952600,-75.171100)
C040 | Philadelphia Jenkintown (C040) - Whole Foods | [40.093900,-75.125900](https://www.google.com/maps/search/?api=1&query=40.093900,-75.125900)
C080 | Philadelphia Devon (C080) - Whole Foods | [40.041900,-75.415300](https://www.google.com/maps/search/?api=1&query=40.041900,-75.415300)
C101 | Philadelphia Center City (C101) - Whole Foods | [39.952900,-75.153700](https://www.google.com/maps/search/?api=1&query=39.952900,-75.153700)
C115 | Philadelphia Cherry Hill (C115) - Whole Foods | [39.924800,-75.028900](https://www.google.com/maps/search/?api=1&query=39.924800,-75.028900)
DPH1 | Philadelphia (DPH1)- Amazon.com | [39.899600,-75.127500](https://www.google.com/maps/search/?api=1&query=39.899600,-75.127500)
DPH2 | Wilmington (DPH2)- Amazon.com | [39.703600,-75.547500](https://www.google.com/maps/search/?api=1&query=39.703600,-75.547500)
UPA1 | Philadelphia (UPA1) - Fresh Online | [39.904000,-75.151200](https://www.google.com/maps/search/?api=1&query=39.904000,-75.151200)
VPA1 | Philadelphia PA (VPA1) - Sub Same-Day | [39.900100,-75.143600](https://www.google.com/maps/search/?api=1&query=39.900100,-75.143600)
###Phoenix
ID | Name | Location
---|---|---
C031 | Phoenix Scottsdale (C031) - Whole Foods | [33.492600,-111.926900](https://www.google.com/maps/search/?api=1&query=33.492600,-111.926900)
C043 | Phoenix Chandler (C043) - Whole Foods | [33.361600,-111.882900](https://www.google.com/maps/search/?api=1&query=33.361600,-111.882900)
C095 | Phoenix Glendale (C095) - Whole Foods | [33.615100,-112.186700](https://www.google.com/maps/search/?api=1&query=33.615100,-112.186700)
C169 | Phoenix Mesa (C169) - Whole Foods | [33.432200,-111.840200](https://www.google.com/maps/search/?api=1&query=33.432200,-111.840200)
DAZ1 | Phoenix (DAZ1)- Amazon.com | [33.443300,-112.013500](https://www.google.com/maps/search/?api=1&query=33.443300,-112.013500)
DAZ2 | Tempe (DAZ2)- Amazon.com | [33.380000,-111.900700](https://www.google.com/maps/search/?api=1&query=33.380000,-111.900700)
UAZ1 | Phoenix (UAZ1) - Fresh Online | [33.479400,-111.958500](https://www.google.com/maps/search/?api=1&query=33.479400,-111.958500)
UAZ2 | Chandler (UAZ2) - Fresh Online | [33.326500,-111.889000](https://www.google.com/maps/search/?api=1&query=33.326500,-111.889000)
VAZ1 | Phoenix AZ (VAZ1) - Sub Same-Day | [33.432700,-111.975800](https://www.google.com/maps/search/?api=1&query=33.432700,-111.975800)
VAZ2 | Tucson AZ (VAZ2) - Sub Same-Day | [32.228700,-110.883200](https://www.google.com/maps/search/?api=1&query=32.228700,-110.883200)
###Pittsburgh
ID | Name | Location
---|---|---
C064 | Pittsburgh East Liberty (C064) - Whole Foods | [40.459100,-79.921800](https://www.google.com/maps/search/?api=1&query=40.459100,-79.921800)
C156 | Pittsburgh South Hills (C156) - Whole Foods | [40.343100,-80.049800](https://www.google.com/maps/search/?api=1&query=40.343100,-80.049800)
DPA1 | Pittsburgh (DPA1)- Amazon.com | [40.380100,-79.965200](https://www.google.com/maps/search/?api=1&query=40.380100,-79.965200)
UPA2 | Pittsburgh (UPA2) - Fresh Online | [40.447700,-79.948700](https://www.google.com/maps/search/?api=1&query=40.447700,-79.948700)
VPA2 | Pittsburgh PA (VPA2) - Sub Same-Day | [40.423900,-79.989300](https://www.google.com/maps/search/?api=1&query=40.423900,-79.989300)
###Portland, OR
ID | Name | Location
---|---|---
C063 | Portland Burnside (C063) - Whole Foods | [45.522200,-122.668300](https://www.google.com/maps/search/?api=1&query=45.522200,-122.668300)
C072 | Portland Lake Oswego (C072) - Whole Foods | [45.406400,-122.701000](https://www.google.com/maps/search/?api=1&query=45.406400,-122.701000)
C148 | Portland Pearl District (C148) - Whole Foods | [45.526900,-122.684300](https://www.google.com/maps/search/?api=1&query=45.526900,-122.684300)
C163 | Portland Happy Valley (C163) - Whole Foods | [45.437400,-122.517400](https://www.google.com/maps/search/?api=1&query=45.437400,-122.517400)
DPO1 | Portland (DPO1)- Amazon.com | [45.534500,-122.652300](https://www.google.com/maps/search/?api=1&query=45.534500,-122.652300)
UOR1 | Portland (UOR1) - Fresh Online | [45.536400,-122.650100](https://www.google.com/maps/search/?api=1&query=45.536400,-122.650100)
VOR1 | Portland OR (VOR1) - Sub Same-Day | [45.501400,-122.673500](https://www.google.com/maps/search/?api=1&query=45.501400,-122.673500)
###Raleigh-Durham
ID | Name | Location
---|---|---
C036 | Raleigh Durham (C036) - Whole Foods | [35.821000,-78.684400](https://www.google.com/maps/search/?api=1&query=35.821000,-78.684400)
C050 | Raleigh Cary (C050) - Whole Foods | [35.791800,-78.800400](https://www.google.com/maps/search/?api=1&query=35.791800,-78.800400)
C160 | Raleigh Durham Streets (C160) - Whole Foods | [35.997300,-78.912000](https://www.google.com/maps/search/?api=1&query=35.997300,-78.912000)
DNC1 | Raleigh (DNC1)- Amazon.com | [35.750100,-78.729900](https://www.google.com/maps/search/?api=1&query=35.750100,-78.729900)
DNC2 | Durham (DNC2)- Amazon.com | [35.963200,-78.846600](https://www.google.com/maps/search/?api=1&query=35.963200,-78.846600)
UNC1 | Raleigh (UNC1) - Fresh Online | [35.821600,-78.684200](https://www.google.com/maps/search/?api=1&query=35.821600,-78.684200)
UNC2 | Durham (UNC2) - Fresh Online | [35.996500,-78.917100](https://www.google.com/maps/search/?api=1&query=35.996500,-78.917100)
VNC1 | Raleigh NC (VNC1) - Sub Same-Day | [35.879300,-78.765900](https://www.google.com/maps/search/?api=1&query=35.879300,-78.765900)
###Sacramento
ID | Name | Location
---|---|---
C069 | Sacramento Roseville (C069) - Whole Foods | [38.740500,-121.305000](https://www.google.com/maps/search/?api=1&query=38.740500,-121.305000)
C074 | Sacramento Midtown (C074) - Whole Foods | [38.570300,-121.471700](https://www.google.com/maps/search/?api=1&query=38.570300,-121.471700)
DSC1 | Sacramento (DSC1)- Amazon.com | [38.491400,-121.476200](https://www.google.com/maps/search/?api=1&query=38.491400,-121.476200)
UCA1 | Sacramento (UCA1) - Fresh Online | [38.628700,-121.446200](https://www.google.com/maps/search/?api=1&query=38.628700,-121.446200)
VCA1 | Sacramento CA (VCA1) - Sub Same-Day | [38.579300,-121.411700](https://www.google.com/maps/search/?api=1&query=38.579300,-121.411700)
###San Diego
ID | Name | Location
---|---|---
C065 | San Diego La Jolla (C065) - Whole Foods | [32.847700,-117.261600](https://www.google.com/maps/search/?api=1&query=32.847700,-117.261600)
C119 | San Diego Hillcrest (C119) - Whole Foods | [32.745900,-117.155100](https://www.google.com/maps/search/?api=1&query=32.745900,-117.155100)
C165 | San Diego Encinitas (C165) - Whole Foods | [33.049700,-117.279000](https://www.google.com/maps/search/?api=1&query=33.049700,-117.279000)
DSD1 | San Diego (DSD1)- Amazon.com | [32.684400,-117.130200](https://www.google.com/maps/search/?api=1&query=32.684400,-117.130200)
UCA2 | San Diego (UCA2) - Fresh Online | [32.831700,-117.157300](https://www.google.com/maps/search/?api=1&query=32.831700,-117.157300)
VCA2 | San Diego CA (VCA2) - Sub Same-Day | [32.770800,-117.166500](https://www.google.com/maps/search/?api=1&query=32.770800,-117.166500)
###San Francisco Bay Area
ID | Name | Location
---|---|---
C066 | San Francisco Marina (C066) - Whole Foods | [37.798900,-122.436200](https://www.google.com/maps/search/?api=1&query=37.798900,-122.436200)
C067 | San Francisco Castro (C067) - Whole Foods | [37.762600,-122.435200](https://www.google.com/maps/search/?api=1&query=37.762600,-122.435200)
C068 | San Francisco Potrero (C068) - Whole Foods | [37.764800,-122.404900](https://www.google.com/maps/search/?api=1&query=37.764800,-122.404900)
C070 | San Jose Cupertino (C070) - Whole Foods | [37.323100,-122.038700](https://www.google.com/maps/search/?api=1&query=37.323100,-122.038700)
C071 | San Jose Los Gatos (C071) - Whole Foods | [37.249500,-121.980400](https://www.google.com/maps/search/?api=1&query=37.249500,-121.980400)
C073 | Oakland Temescal (C073) - Whole Foods | [37.838100,-122.259400](https://www.google.com/maps/search/?api=1&query=37.838100,-122.259400)
C079 | San Jose Almaden (C079) - Whole Foods | [37.237100,-121.870900](https://www.google.com/maps/search/?api=1&query=37.237100,-121.870900)
C087 | San Jose Santana Row (C087) - Whole Foods | [37.321100,-121.949100](https://www.google.com/maps/search/?api=1&query=37.321100,-121.949100)
C089 | Walnut Creek (C089) - Whole Foods | [37.898200,-122.064500](https://www.google.com/maps/search/?api=1&query=37.898200,-122.064500)
C090 | Danville (C090) - Whole Foods | [37.822100,-121.983700](https://www.google.com/maps/search/?api=1&query=37.822100,-121.983700)
C092 | San Ramon (C092) - Whole Foods | [37.762300,-121.970900](https://www.google.com/maps/search/?api=1&query=37.762300,-121.970900)
DSF1 | San Francisco (DSF1)- Amazon.com | [37.739100,-122.406600](https://www.google.com/maps/search/?api=1&query=37.739100,-122.406600)
DSF2 | San Jose (DSF2)- Amazon.com | [37.350700,-121.896600](https://www.google.com/maps/search/?api=1&query=37.350700,-121.896600)
DSF3 | Oakland (DSF3)- Amazon.com | [37.815900,-122.282500](https://www.google.com/maps/search/?api=1&query=37.815900,-122.282500)
UCA7 | San Francisco (UCA7) - Fresh Online | [37.766900,-122.402700](https://www.google.com/maps/search/?api=1&query=37.766900,-122.402700)
UCA8 | East Bay (UCA8) - Fresh Online | [37.799200,-122.278400](https://www.google.com/maps/search/?api=1&query=37.799200,-122.278400)
UCA9 | San Jose (UCA9) - Fresh Online | [37.385900,-121.972400](https://www.google.com/maps/search/?api=1&query=37.385900,-121.972400)
VCA6 | San Francisco CA (VCA6) - Sub Same-Day | [37.764800,-122.406900](https://www.google.com/maps/search/?api=1&query=37.764800,-122.406900)
VCA7 | San Jose CA (VCA7) - Sub Same-Day | [37.368900,-121.912800](https://www.google.com/maps/search/?api=1&query=37.368900,-121.912800)
VCA8 | East Bay CA (VCA8) - Sub Same-Day | [37.832600,-122.252700](https://www.google.com/maps/search/?api=1&query=37.832600,-122.252700)
###Seattle
ID | Name | Location
---|---|---
C037 | Seattle Capitol Hill (C037) - Whole Foods | [47.622300,-122.314900](https://www.google.com/maps/search/?api=1&query=47.622300,-122.314900)
C049 | Seattle Roosevelt (C049) - Whole Foods | [47.676500,-122.321300](https://www.google.com/maps/search/?api=1&query=47.676500,-122.321300)
C100 | Seattle West Seattle (C100) - Whole Foods | [47.561800,-122.384500](https://www.google.com/maps/search/?api=1&query=47.561800,-122.384500)
C106 | Seattle Bellevue (C106) - Whole Foods | [47.600700,-122.202300](https://www.google.com/maps/search/?api=1&query=47.600700,-122.202300)
C108 | Seattle Redmond (C108) - Whole Foods | [47.673500,-122.122300](https://www.google.com/maps/search/?api=1&query=47.673500,-122.122300)
C109 | Seattle Kirkland (C109) - Whole Foods | [47.683700,-122.194900](https://www.google.com/maps/search/?api=1&query=47.683700,-122.194900)
DWA1 | Seattle (DWA1)- Amazon.com | [47.553200,-122.302500](https://www.google.com/maps/search/?api=1&query=47.553200,-122.302500)
DWA2 | Renton (DWA2)- Amazon.com | [47.467200,-122.218800](https://www.google.com/maps/search/?api=1&query=47.467200,-122.218800)
UWA1 | Seattle (UWA1) - Fresh Online | [47.611000,-122.335000](https://www.google.com/maps/search/?api=1&query=47.611000,-122.335000)
UWA2 | Eastside (UWA2) - Fresh Online | [47.597100,-122.185400](https://www.google.com/maps/search/?api=1&query=47.597100,-122.185400)
VWA1 | Seattle WA (VWA1) - Sub Same-Day | [47.553200,-122.343500](https://www.google.com/maps/search/?api=1&query=47.553200,-122.343500)
VWA2 | Bellevue WA (VWA2) - Sub Same-Day | [47.600700,-122.201700](https://www.google.com/maps/search/?api=1&query=47.600700,-122.201700)
###St. Louis
ID | Name | Location
---|---|---
C097 | St Louis Clayton (C097) - Whole Foods | [38.645900,-90.329300](https://www.google.com/maps/search/?api=1&query=38.645900,-90.329300)
C133 | St Louis Brentwood (C133) - Whole Foods | [38.617500,-90.349900](https://www.google.com/maps/search/?api=1&query=38.617500,-90.349900)
DMO1 | St Louis (DMO1)- Amazon.com | [38.545200,-90.367700](https://www.google.com/maps/search/?api=1&query=38.545200,-90.367700)
UMO1 | St Louis (UMO1) - Fresh Online | [38.624400,-90.337600](https://www.google.com/maps/search/?api=1&query=38.624400,-90.337600)
VMO1 | St Louis MO (VMO1) - Sub Same-Day | [38.620500,-90.382600](https://www.google.com/maps/search/?api=1&query=38.620500,-90.382600)
###Tampa-St Petersburg
ID | Name | Location
---|---|---
C053 | Tampa Carrollwood (C053) - Whole Foods | [28.049600,-82.506700](https://www.google.com/maps/search/?api=1&query=28.049600,-82.506700)
C102 | Tampa South Tampa (C102) - Whole Foods | [27.925800,-82.493700](https://www.google.com/maps/search/?api=1&query=27.925800,-82.493700)
C120 | Tampa Wesley Chapel (C120) - Whole Foods | [28.196200,-82.334900](https://www.google.com/maps/search/?api=1&query=28.196200,-82.334900)
DTF1 | Tampa (DTF1)- Amazon.com | [27.908200,-82.417100](https://www.google.com/maps/search/?api=1&query=27.908200,-82.417100)
UFL4 | Tampa (UFL4) - Fresh Online | [27.979000,-82.509200](https://www.google.com/maps/search/?api=1&query=27.979000,-82.509200)
VFL3 | Tampa FL (VFL3) - Sub Same-Day | [27.944900,-82.496200](https://www.google.com/maps/search/?api=1&query=27.944900,-82.496200)
###Washington DC
ID | Name | Location
---|---|---
C045 | Washington DC Foggy Bottom (C045) - Whole Foods | [38.899200,-77.052300](https://www.google.com/maps/search/?api=1&query=38.899200,-77.052300)
C054 | Washington DC Tenleytown (C054) - Whole Foods | [38.947500,-77.079300](https://www.google.com/maps/search/?api=1&query=38.947500,-77.079300)
C060 | Washington DC Duke Street (C060) - Whole Foods | [38.816300,-77.083800](https://www.google.com/maps/search/?api=1&query=38.816300,-77.083800)
C061 | Virginia Fairfax (C061) - Whole Foods | [38.852000,-77.304400](https://www.google.com/maps/search/?api=1&query=38.852000,-77.304400)
C078 | Washington DC P Street (C078) - Whole Foods | [38.910300,-77.042000](https://www.google.com/maps/search/?api=1&query=38.910300,-77.042000)
C096 | Virginia Reston (C096) - Whole Foods | [38.959800,-77.358400](https://www.google.com/maps/search/?api=1&query=38.959800,-77.358400)
C116 | Virginia Clarendon (C116) - Whole Foods | [38.886100,-77.097800](https://www.google.com/maps/search/?api=1&query=38.886100,-77.097800)
C127 | Virginia Sterling (C127) - Whole Foods | [39.014900,-77.424400](https://www.google.com/maps/search/?api=1&query=39.014900,-77.424400)
C135 | Virginia Centreville (C135) - Whole Foods | [38.826400,-77.448700](https://www.google.com/maps/search/?api=1&query=38.826400,-77.448700)
C136 | Virginia Herndon (C136) - Whole Foods | [38.984900,-77.394600](https://www.google.com/maps/search/?api=1&query=38.984900,-77.394600)
C137 | Maryland Rockville (C137) - Whole Foods | [39.084700,-77.153700](https://www.google.com/maps/search/?api=1&query=39.084700,-77.153700)
C138 | Maryland Potomac (C138) - Whole Foods | [39.018100,-77.221300](https://www.google.com/maps/search/?api=1&query=39.018100,-77.221300)
C140 | Maryland Silver Spring (C140) - Whole Foods | [38.994700,-77.027800](https://www.google.com/maps/search/?api=1&query=38.994700,-77.027800)
C141 | Virginia Midlothian (C141) - Whole Foods | [37.493700,-77.664600](https://www.google.com/maps/search/?api=1&query=37.493700,-77.664600)
DDC1 | Washington DC (DDC1)- Amazon.com | [38.921900,-77.024900](https://www.google.com/maps/search/?api=1&query=38.921900,-77.024900)
DDC2 | Lorton (DDC2)- Amazon.com | [38.699700,-77.219100](https://www.google.com/maps/search/?api=1&query=38.699700,-77.219100)
DDC3 | Gaithersburg (DDC3)- Amazon.com | [39.113500,-77.239900](https://www.google.com/maps/search/?api=1&query=39.113500,-77.239900)
UDC1 | Washington DC (UDC1) - Fresh Online | [38.895500,-77.023600](https://www.google.com/maps/search/?api=1&query=38.895500,-77.023600)
UDC2 | Virginia (UDC2) - Fresh Online | [38.898400,-77.162000](https://www.google.com/maps/search/?api=1&query=38.898400,-77.162000)
UDC3 | Maryland (UDC3) - Fresh Online | [39.020300,-77.101900](https://www.google.com/maps/search/?api=1&query=39.020300,-77.101900)
VDC1 | Washington DC (VDC1) - Sub Same-Day | [38.895100,-77.082200](https://www.google.com/maps/search/?api=1&query=38.895100,-77.082200)
VDC2 | Northern Virginia (VDC2) - Sub Same-Day | [38.874700,-77.225300](https://www.google.com/maps/search/?api=1&query=38.874700,-77.225300)
VDC3 | Maryland (VDC3) - Sub Same-Day | [39.049700,-77.104900](https://www.google.com/maps/search/?api=1&query=39.049700,-77.104900)
###Orlando
ID | Name | Location
---|---|---
C110 | Orlando Dr Phillips (C110) - Whole Foods | [28.459700,-81.488200](https://www.google.com/maps/search/?api=1&query=28.459700,-81.488200)
C111 | Orlando Winter Park (C111) - Whole Foods | [28.596200,-81.371400](https://www.google.com/maps/search/?api=1&query=28.596200,-81.371400)
DOF1 | Orlando (DOF1)- Amazon.com | [28.516900,-81.323900](https://www.google.com/maps/search/?api=1&query=28.516900,-81.323900)
UFL5 | Orlando (UFL5) - Fresh Online | [28.476300,-81.460700](https://www.google.com/maps/search/?api=1&query=28.476300,-81.460700)
VFL4 | Orlando FL (VFL4) - Sub Same-Day | [28.440000,-81.394700](https://www.google.com/maps/search/?api=1&query=28.440000,-81.394700)
###San Antonio
ID | Name | Location
---|---|---
C112 | San Antonio Lincoln Heights (C112) - Whole Foods | [29.521600,-98.476000](https://www.google.com/maps/search/?api=1&query=29.521600,-98.476000)
DSA1 | San Antonio (DSA1)- Amazon.com | [29.472600,-98.523800](https://www.google.com/maps/search/?api=1&query=29.472600,-98.523800)
UTX1 | San Antonio (UTX1) - Fresh Online | [29.521400,-98.488300](https://www.google.com/maps/search/?api=1&query=29.521400,-98.488300)
VTX7 | San Antonio TX (VTX7) - Sub Same-Day | [29.465900,-98.556700](https://www.google.com/maps/search/?api=1&query=29.465900,-98.556700)
###Kansas City
ID | Name | Location
---|---|---
C158 | Kansas City Brookside (C158) - Whole Foods | [38.985100,-94.590600](https://www.google.com/maps/search/?api=1&query=38.985100,-94.590600)
DKC1 | Kansas City (DKC1)- Amazon.com | [39.049400,-94.573300](https://www.google.com/maps/search/?api=1&query=39.049400,-94.573300)
UMO2 | Kansas City (UMO2) - Fresh Online | [39.002700,-94.585400](https://www.google.com/maps/search/?api=1&query=39.002700,-94.585400)
VMO2 | Kansas City MO (VMO2) - Sub Same-Day | [38.999800,-94.672100](https://www.google.com/maps/search/?api=1&query=38.999800,-94.672100)
###Indianapolis
ID | Name | Location
---|---|---
C159 | Indianapolis Broad Ripple (C159) - Whole Foods | [39.870100,-86.130700](https://www.google.com/maps/search/?api=1&query=39.870100,-86.130700)
DIN1 | Indianapolis (DIN1)- Amazon.com | [39.764700,-86.280900](https://www.google.com/maps/search/?api=1&query=39.764700,-86.280900)
UIN1 | Indianapolis (UIN1) - Fresh Online | [39.815800,-86.122400](https://www.google.com/maps/search/?api=1&query=39.815800,-86.122400)
VIN1 | Indianapolis IN (VIN1) - Sub Same-Day | [39.817500,-86.133800](https://www.google.com/maps/search/?api=1&query=39.817500,-86.133800)
###Oklahoma City
ID | Name | Location
---|---|---
DOK1 | Oklahoma City (DOK1)- Amazon.com | [35.461600,-97.515600](https://www.google.com/maps/search/?api=1&query=35.461600,-97.515600)
VOK1 | Oklahoma City OK (VOK1) - Sub Same-Day | [35.437400,-97.519700](https://www.google.com/maps/search/?api=1&query=35.437400,-97.519700)
###Salt Lake City
ID | Name | Location
---|---|---
C149 | Salt Lake City Sugar House (C149) - Whole Foods | [40.715700,-111.862400](https://www.google.com/maps/search/?api=1&query=40.715700,-111.862400)
DUT1 | Salt Lake City (DUT1)- Amazon.com | [40.726600,-111.972300](https://www.google.com/maps/search/?api=1&query=40.726600,-111.972300)
UUT1 | Salt Lake City (UUT1) - Fresh Online | [40.714800,-111.899700](https://www.google.com/maps/search/?api=1&query=40.714800,-111.899700)
VUT1 | Salt Lake City UT (VUT1) - Sub Same-Day | [40.669200,-111.918100](https://www.google.com/maps/search/?api=1&query=40.669200,-111.918100)
`;

const wikiEntries = parseRedditWiki(redditMarkdown);
console.log(`Parsed ${wikiEntries.length} US facility entries from wiki`);

// Count by type
const typeCount = {};
for (const e of wikiEntries) {
  typeCount[e.type] = (typeCount[e.type] || 0) + 1;
}
console.log('Type breakdown:', typeCount);

// Insert into DB
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO locations 
    (retailer_id, address_raw, lat, lng, type, source_url, confidence_tier)
  VALUES 
    ('amazon_same_day', ?, ?, ?, ?, 'flex_drivers_wiki', 'inferred')
`);

const updateStmt = db.prepare(`
  UPDATE locations 
  SET lat = ?, lng = ?, type = ?, confidence_tier = 'inferred'
  WHERE retailer_id = 'amazon_same_day' AND address_raw = ? AND lat IS NULL
`);

let wikiInserted = 0;
let wikiUpdated = 0;

const insertWiki = db.transaction(() => {
  for (const entry of wikiEntries) {
    const result = insertStmt.run(entry.address_raw, entry.lat, entry.lng, entry.type);
    if (result.changes > 0) {
      wikiInserted++;
    } else {
      // Try updating existing with coordinates if missing
      const upd = updateStmt.run(entry.lat, entry.lng, entry.type, entry.address_raw);
      if (upd.changes > 0) wikiUpdated++;
    }
  }
});
insertWiki();
console.log(`Wiki: inserted ${wikiInserted}, updated ${wikiUpdated} existing records`);

// ── STEP 2: warehouse.ninja data ──────────────────────────────────────────────
console.log('\n=== STEP 2: warehouse.ninja Address Resolution ===');

const warehouseNinjaData = `[SUHB](https://warehouse.ninja/locations/amazon/SUHB/)4675 Appaloosa DrIrondaleAL35210
[MOB9](https://warehouse.ninja/locations/amazon/MOB9/)6735 Trippel Rd.TheodoreAL36582
[PHX5](https://warehouse.ninja/locations/amazon/PHX5/)16920 W Commerce DriveGoodyearAZ85338-3620
[PHX3](https://warehouse.ninja/locations/amazon/PHX3/)6835 West Buckeye RoadPhoenixAZ85043-4428
[PHX7](https://warehouse.ninja/locations/amazon/PHX7/)800 N 75th AvePhoenixAZ85043-2101
[PHX6](https://warehouse.ninja/locations/amazon/PHX6/)4750 West Mohave StPhoenixAZ85043-8305
[TFC1](https://warehouse.ninja/locations/amazon/TFC1/)5050 West Mohave StPhoenixAZ85043-8305
[AZA6](https://warehouse.ninja/locations/amazon/AZA6/)2150 East Riverview DrivePhoenixAZ85034
[TUS1](https://warehouse.ninja/locations/amazon/TUS1/)5333 W. Lower Buckeye RoadPhoenixAZ85043
[TAZ1](https://warehouse.ninja/locations/amazon/TAZ1/)500 S 48th StPhoenixAZ85034
[SUPR](https://warehouse.ninja/locations/amazon/SUPR/)9414 E San Salvador DrScottsdaleAZ85258
[SUBJ](https://warehouse.ninja/locations/amazon/SUBJ/)1104 W Geneva DrTempeAZ85281
[PHX9](https://warehouse.ninja/locations/amazon/PHX9/)777 S 79th AveTollesonAZ85353-3140
[OAK8](https://warehouse.ninja/locations/amazon/OAK8/)1 Middleton WayAmerican CanyonCA94503
[BEK1](https://warehouse.ninja/locations/amazon/BEK1/)2495 Bancroft Way Room 235BerkeleyCA94720
[SJC9](https://warehouse.ninja/locations/amazon/SJC9/)1455 valley driveBrisbaneCA94005
[VUKF](https://warehouse.ninja/locations/amazon/VUKF/)18120 Bishop AveCarsonCA90746-4032
[SUNC](https://warehouse.ninja/locations/amazon/SUNC/)1113 E 230th StreetCarsonCA90745
[XBC1](https://warehouse.ninja/locations/amazon/XBC1/)15750 Mountain AvenueChinoCA91708
[DAV1](https://warehouse.ninja/locations/amazon/DAV1/)1 Shields AveDavisCA95616-8662
[LGB3](https://warehouse.ninja/locations/amazon/LGB3/)4950 Goodman wayEastvaleCA92880
[SNA6](https://warehouse.ninja/locations/amazon/SNA6/)5250 Goodman RoadEastvaleCA92880
[VUBG](https://warehouse.ninja/locations/amazon/VUBG/)8365 Sultana AveFontanaCA92335
[VUPQ](https://warehouse.ninja/locations/amazon/VUPQ/)9211 Kaiser WayFontanaCA92335
[VUBH](https://warehouse.ninja/locations/amazon/VUBH/)9950 Calabash AveFontanaCA92335-5210
[XFI1](https://warehouse.ninja/locations/amazon/XFI1/)6351 Cameron BoulevardGilroyCA95020
[IRV1](https://warehouse.ninja/locations/amazon/IRV1/)4139 Campus DriveIrvineCA92612
[TCA4](https://warehouse.ninja/locations/amazon/TCA4/)2006 McGaw AvenueIrvineCA92614
[LGB1](https://warehouse.ninja/locations/amazon/LGB1/)2417 E. Carson, St.Long BeachCA90810
[LGB2](https://warehouse.ninja/locations/amazon/LGB2/)6049 E 7th StLong BeachCA90840
[HCA3](https://warehouse.ninja/locations/amazon/HCA3/)3334 N San Fernando Rd Bldg ELos AngelesCA90065-1417
[LAX6](https://warehouse.ninja/locations/amazon/LAX6/)5119 District BlvdLos AngelesCA90058
[UCA5](https://warehouse.ninja/locations/amazon/UCA5/)3334 N. San Fernando RoadLos AngelesCA90065
[ABE7](https://warehouse.ninja/locations/amazon/ABE7/)12510 Micro DrMira LomaCA91752
[VUGE](https://warehouse.ninja/locations/amazon/VUGE/)3450 Dulles DrMira LomaCA91752-3242
[ONT6](https://warehouse.ninja/locations/amazon/ONT6/)24208 San Michele RdMoreno ValleyCA92551
[ONT8](https://warehouse.ninja/locations/amazon/ONT8/)24300 Nandina AveMoreno ValleyCA92551
[VUPG](https://warehouse.ninja/locations/amazon/VUPG/)16110 Cosmos StreetMoreno ValleyCA92551
[OAK7](https://warehouse.ninja/locations/amazon/OAK7/)38811 Cherry StNewarkCA94560
[ONT9](https://warehouse.ninja/locations/amazon/ONT9/)2125 West San Bernardino AveRedlandsCA92374
[LGB4](https://warehouse.ninja/locations/amazon/LGB4/)27517 Pioneer AvenueRedlandsCA92374
[VUPX](https://warehouse.ninja/locations/amazon/VUPX/)2300 W San Bernardino AveRedlandsCA92374
[SNA4](https://warehouse.ninja/locations/amazon/SNA4/)2496 W Walnut AveRialtoCA92376-3009
[LGB8](https://warehouse.ninja/locations/amazon/LGB8/)1568 N Linden AveRialtoCA92376
[VUMD](https://warehouse.ninja/locations/amazon/VUMD/)548 W Merrill AveRialtoCA92376-9101
[LGB6](https://warehouse.ninja/locations/amazon/LGB6/)20901 Krameria AveRiversideCA92518
[SMF1](https://warehouse.ninja/locations/amazon/SMF1/)4900 W Elkhorn BlvdSacramentoCA95837
[SNA7](https://warehouse.ninja/locations/amazon/SNA7/)555 East Orange Show RdSan BernadinoCA92408
[ONT2](https://warehouse.ninja/locations/amazon/ONT2/)1910 E Central AveSan BernardinoCA92408-0123
[ONT7](https://warehouse.ninja/locations/amazon/ONT7/)2020 E Central AveSan BernardinoCA92408-2606
[VUBJ](https://warehouse.ninja/locations/amazon/VUBJ/)1456 Harry Shepard BlvdSan BernardinoCA92408
[TCA6](https://warehouse.ninja/locations/amazon/TCA6/)2727 Kurtz StSan DiegoCA92110
[TCA1](https://warehouse.ninja/locations/amazon/TCA1/)888 Tennessee StSan FranciscoCA94107
[TCA7](https://warehouse.ninja/locations/amazon/TCA7/)222 Commercial StSunnyvaleCA94085
[VUKJ](https://warehouse.ninja/locations/amazon/VUKJ/)19270 S. Western AvenueTorranceCA90501
[OAK6](https://warehouse.ninja/locations/amazon/OAK6/)1350 N. MacArthur DriveTracyCA95304-9370
[OAK4](https://warehouse.ninja/locations/amazon/OAK4/)1555 N. Chrisman RdTracyCA95304-9370
[SJC7](https://warehouse.ninja/locations/amazon/SJC7/)188 Mountain House ParkwayTracyCA95391
[VUBD](https://warehouse.ninja/locations/amazon/VUBD/)17182 Nevada AvenueVictorvilleCA92345
[VUWA](https://warehouse.ninja/locations/amazon/VUWA/)13243 Nutro WayVictorvilleCA92395
[DEN2](https://warehouse.ninja/locations/amazon/DEN2/)22205 East 19th AveAuroraCO80019
[UCO2](https://warehouse.ninja/locations/amazon/UCO2/)3434 47th StreetBoulderCO80301
[DEN6](https://warehouse.ninja/locations/amazon/DEN6/)480 E 55th AveDenverCO80216
[UCO1](https://warehouse.ninja/locations/amazon/UCO1/)480 E. 55th AvenueDenverCO80216
[TCO1](https://warehouse.ninja/locations/amazon/TCO1/)480 E 55th AvenueDenverCO80216
[DEN3](https://warehouse.ninja/locations/amazon/DEN3/)14601 Grant St.ThorntonCO80023
[CON1](https://warehouse.ninja/locations/amazon/CON1/)40 Wilbur Cross WayMansfieldCT6268
[BDL2](https://warehouse.ninja/locations/amazon/BDL2/)200 Old Iron Ore RdWindsorCT6095
[PHL7](https://warehouse.ninja/locations/amazon/PHL7/)560 Merrimac AveMiddletownDE19709-4652
[PHL1](https://warehouse.ninja/locations/amazon/PHL1/)1 Centerpoint Blvd.New CastleDE19720-4172
[PHL3](https://warehouse.ninja/locations/amazon/PHL3/)1600 Johnson WayNew CastleDE19720-8111
[PFL1](https://warehouse.ninja/locations/amazon/PFL1/)1001 13th Avenue EastBradentonFL34208-2656
[JAX2](https://warehouse.ninja/locations/amazon/JAX2/)12900 Pecan Park RoadJacksonvilleFL32218
[JAX3](https://warehouse.ninja/locations/amazon/JAX3/)13333 103rd StreetJacksonvilleFL32221
[TPA2](https://warehouse.ninja/locations/amazon/TPA2/)1760 County Line Rd.LakelandFL33811
[MIA6](https://warehouse.ninja/locations/amazon/MIA6/)3200 NW 67th AvenueMiamiFL33122
[TFL2](https://warehouse.ninja/locations/amazon/TFL2/)101 NE 23rd StreetMiamiFL33137
[UFL2](https://warehouse.ninja/locations/amazon/UFL2/)101 NE 23rd StreetMiamiFL33137
[MIA7](https://warehouse.ninja/locations/amazon/MIA7/)1900 NW 132nd PlaceMiamiFL33182
[MIA1](https://warehouse.ninja/locations/amazon/MIA1/)14000 NW 37th AvenueOpa-LockaFL33054
[CFL1](https://warehouse.ninja/locations/amazon/CFL1/)4225 East Plaza DriveOrlandoFL32816
[TPA1](https://warehouse.ninja/locations/amazon/TPA1/)3350 Laurel Ridge AveRuskinFL33570
[UFL3](https://warehouse.ninja/locations/amazon/UFL3/)4430 East AdamoTampaFL33605
[TFL3](https://warehouse.ninja/locations/amazon/TFL3/)4430 E ADAMO DRTampaFL33605
[GAT1](https://warehouse.ninja/locations/amazon/GAT1/)86 5th St NWAtlantaGA30308
[PGA1](https://warehouse.ninja/locations/amazon/PGA1/)429 Toy Wright RdJeffersonGA30549-1614
[MGE1](https://warehouse.ninja/locations/amazon/MGE1/)650 Broadway AvenueBraseltonGA30517
[ATL9](https://warehouse.ninja/locations/amazon/ATL9/)2232 Northmont ParkwayDuluthGA30096
[VUKG](https://warehouse.ninja/locations/amazon/VUKG/)3201 Centre ParkwayEast PointGA30344
[UGA3](https://warehouse.ninja/locations/amazon/UGA3/)2160 Breckinridge Blvd Bldg 100LawrencevilleGA30043
[ATL8](https://warehouse.ninja/locations/amazon/ATL8/)2201 Thornton RoadLithia SpringsGA30122-3895
[VUOJ](https://warehouse.ninja/locations/amazon/VUOJ/)250 Declaration AvenueMcDonoughGA30253
[VUPN](https://warehouse.ninja/locations/amazon/VUPN/)340 Westridge ParkwayMcDonoughGA30253
[VUTE](https://warehouse.ninja/locations/amazon/VUTE/)1020 SH Morgan PkwyPoolerGA31322
[ATL7](https://warehouse.ninja/locations/amazon/ATL7/)6855 Shannon PkwyUnion CityGA30291-2091
[VUAT](https://warehouse.ninja/locations/amazon/VUAT/)6855 Shannon PkwyUnion CityGA30291
[VUPK](https://warehouse.ninja/locations/amazon/VUPK/)6720 Oakley Industrial BlvdUnion CityGA30291
[HGA3](https://warehouse.ninja/locations/amazon/HGA3/)2160 Breckenridge BlvdLawrencevilleGA30043
[MDW9](https://warehouse.ninja/locations/amazon/MDW9/)2865 Duke parkwayAuroraIL60563
[STL4](https://warehouse.ninja/locations/amazon/STL4/)3050 Gateway Commerce Center DR SEdwardsvilleIL62025-2815
[STL6](https://warehouse.ninja/locations/amazon/STL6/)3931 Lakeview Corporate DriveEdwardsvilleIL62025
[VUPS](https://warehouse.ninja/locations/amazon/VUPS/)3049 Westway DriveEdwardsvilleIL62025
[VUOK](https://warehouse.ninja/locations/amazon/VUOK/)21837 W. Mississippi AveElwoodIL60421
[KIL1](https://warehouse.ninja/locations/amazon/KIL1/)3900 S Brandon RdElwoodIL60421
[MDW2](https://warehouse.ninja/locations/amazon/MDW2/)250 Emerald DriveJolietIL60433
[MDW7](https://warehouse.ninja/locations/amazon/MDW7/)6605 Monee Manhattan RoadMoneeIL60449
[MDW6](https://warehouse.ninja/locations/amazon/MDW6/)1125 W REMINGTON BLVDROMEOVILLEIL60446-6529
[MDW8](https://warehouse.ninja/locations/amazon/MDW8/)1750 Bridge DriveWaukeganIL60085
[ORD6](https://warehouse.ninja/locations/amazon/ORD6/)1250 N Mittel BlvdWood DaleIL60191
[UIL2](https://warehouse.ninja/locations/amazon/UIL2/)1250 N Mittel BlvdWood DaleIL60191
[IND7](https://warehouse.ninja/locations/amazon/IND7/)9101 Orly DriveIndianapolisIN46241-9605
[IND4](https://warehouse.ninja/locations/amazon/IND4/)710 S. Girls School RdIndianapolisIN46231-1132
[SDF8](https://warehouse.ninja/locations/amazon/SDF8/)900 Patrol RdJeffersonvilleIN47130-7716
[IND2](https://warehouse.ninja/locations/amazon/IND2/)715 Airtech PkwyPlainfieldIN46168-7442
[IND5](https://warehouse.ninja/locations/amazon/IND5/)800 Perry RoadPlainfieldIN46168-7637
[IND1](https://warehouse.ninja/locations/amazon/IND1/)4255 Anson BlvdWhitestownIN46075-4412
[MKC4](https://warehouse.ninja/locations/amazon/MKC4/)19645 Waverly RdEdgertonKS66021-9588
[MKC6](https://warehouse.ninja/locations/amazon/MKC6/)6925 Riverview AvenueKansas CityKS66102
[SDF1](https://warehouse.ninja/locations/amazon/SDF1/)1050 South ColumbiaCampbellsvilleKY42718-2454
[CVG8](https://warehouse.ninja/locations/amazon/