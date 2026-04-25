#!/usr/bin/env python3
"""
rebuild_csv.py — Rebuild docs/amazon-fresh-coverage-by-zip.csv from merged probe data.

Sources merged (in priority order — later sources override earlier for the same ZIP):
  1. Phase 1 — msa_probe_v2_results.json (ZIP-level results inside each MSA record)
  2. Phase 2 — dallas_zip_results.json (313 ZIPs in DFW MSA)
  3. Phase 3 — full_msa_zip_results.json (3,500+ ZIPs breadth-first sweep, ground truth)
"""

import csv
import json
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
DOCS_DIR = os.path.join(PROJECT_ROOT, 'docs')
OUT_CSV = os.path.join(DOCS_DIR, 'amazon-fresh-coverage-by-zip.csv')

PHASE1_PATH = os.path.join(DATA_DIR, 'msa_probe_v2_results.json')
PHASE2_PATH = os.path.join(DATA_DIR, 'dallas_zip_results.json')
PHASE3_PATH = os.path.join(DATA_DIR, 'full_msa_zip_results.json')

# zip -> { zip, city, state, population, msa_id, msa_name, coverage_status, source }
rows = {}


def infer_offer_type(offers):
    """Infer offer type string from offer list (handles both dicts and plain strings)."""
    if not offers:
        return ''
    for o in offers:
        if isinstance(o, str):
            # Phase 3 format: plain strings like 'WholeFoods', 'SSD_Prime', 'AmazonFresh'
            ol = o.lower()
            if 'whole' in ol:
                return 'Whole_Foods'
            if 'amazonfresh' in ol or 'amazon_fresh' in ol:
                return 'AmazonFresh'
            if 'ssd' in ol or 'prime' in ol:
                return 'SSD_Prime'
            return o
        else:
            # Phase 1/2 format: dict with ships_from key
            sf = (o.get('ships_from') or '').lower()
            if 'whole foods' in sf:
                return 'Whole_Foods'
            if 'amazonfresh' in sf or 'amazon fresh' in sf:
                return 'AmazonFresh'
            if 'amazon' in sf:
                return 'SSD_Prime'
    return 'Other'


# ── Phase 1: MSA probe ZIP-level results ──────────────────────────────────────
if os.path.exists(PHASE1_PATH):
    with open(PHASE1_PATH) as f:
        p1 = json.load(f)
    for msa_id, msa_data in p1.items():
        msa_name = msa_data.get('msa_name', '')
        zip_results = msa_data.get('zip_results') or {}
        for zip_code, zd in zip_results.items():
            offers = []
            for prod in ('bananas', 'strawberries'):
                prod_data = zd.get(prod) or {}
                offers.extend(prod_data.get('offers') or [])
            rows[zip_code] = {
                'zip': zip_code,
                'city': zd.get('city', ''),
                'state': zd.get('state', ''),
                'population': zd.get('pop', ''),
                'msa_id': msa_id,
                'msa_name': msa_name,
                'coverage_status': zd.get('status', 'none'),
                'inferred_offer_type': infer_offer_type(offers),
                'source': 'phase1_msa_probe',
            }
    print(f"[rebuild_csv] Phase 1: {len(rows)} ZIPs loaded")

phase1_count = len(rows)

# ── Phase 2: Dallas ZIP probe ─────────────────────────────────────────────────
if os.path.exists(PHASE2_PATH):
    with open(PHASE2_PATH) as f:
        p2 = json.load(f)
    p2_added = 0
    for zip_code, zd in p2.items():
        offers = []
        for prod in ('bananas', 'strawberries'):
            prod_data = zd.get(prod) or {}
            offers.extend(prod_data.get('offers') or [])
        rows[zip_code] = {
            'zip': zip_code,
            'city': zd.get('city', ''),
            'state': zd.get('state', ''),
            'population': zd.get('pop', ''),
            'msa_id': '19100',
            'msa_name': 'Dallas-Fort Worth-Arlington, TX',
            'coverage_status': zd.get('status', 'none'),
            'inferred_offer_type': infer_offer_type(offers),
            'source': 'phase2_dallas_probe',
        }
        p2_added += 1
    print(f"[rebuild_csv] Phase 2: {p2_added} Dallas ZIPs loaded (overrides Phase 1 for same ZIPs)")

# ── Phase 3: Full MSA ZIP sweep (ground truth) ────────────────────────────────
if os.path.exists(PHASE3_PATH):
    with open(PHASE3_PATH) as f:
        p3 = json.load(f)
    p3_added = 0
    for zip_code, zd in p3.items():
        offers = list(zd.get('offers') or [])
        rows[zip_code] = {
            'zip': zip_code,
            'city': zd.get('city', ''),
            'state': zd.get('state', ''),
            'population': zd.get('pop', ''),
            'msa_id': zd.get('msa_id', ''),
            'msa_name': zd.get('msa_name', ''),
            'coverage_status': zd.get('status', 'none'),
            'inferred_offer_type': infer_offer_type(offers),
            'source': 'phase3_full_zip_probe',
        }
        p3_added += 1
    print(f"[rebuild_csv] Phase 3: {p3_added} ZIPs loaded (ground truth, overrides earlier phases)")

# ── Write CSV ─────────────────────────────────────────────────────────────────
os.makedirs(DOCS_DIR, exist_ok=True)

fieldnames = ['zip', 'city', 'state', 'population', 'msa_id', 'msa_name',
              'coverage_status', 'inferred_offer_type', 'source']

sorted_rows = sorted(rows.values(), key=lambda r: (r['msa_id'], r['zip']))

confirmed_count = sum(1 for r in sorted_rows if r['coverage_status'] in ('full_fresh', 'ambient_fresh'))
none_count = sum(1 for r in sorted_rows if r['coverage_status'] == 'none')

with open(OUT_CSV, 'w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(sorted_rows)

print(f"[rebuild_csv] Wrote {len(sorted_rows)} rows to {OUT_CSV}")
print(f"[rebuild_csv]   confirmed: {confirmed_count}  |  none: {none_count}  |  other: {len(sorted_rows)-confirmed_count-none_count}")
