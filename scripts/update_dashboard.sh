#!/bin/bash
# update_dashboard.sh — Regenerate and push the coverage dashboard
set -e

cd /Users/warrenmatthews/.openclaw/workspace/projects/fresh-coverage

echo "[update_dashboard] Regenerating report..."
node src/report.js

echo "[update_dashboard] Copying to docs/..."
cp reports/index.html docs/index.html

# Also copy the MSA GeoJSON if needed by GitHub Pages
cp data/us_msas.geojson docs/us_msas.geojson 2>/dev/null || true
cp data/dallas_zip_probe.geojson docs/dallas_zip_probe.geojson 2>/dev/null || true

# Regenerate the ZIP CSV
echo "[update_dashboard] Rebuilding ZIP CSV..."
python3 scripts/rebuild_csv.py 2>/dev/null || true

echo "[update_dashboard] Committing and pushing..."
git add -A
git diff --cached --quiet || git commit -m "Dashboard auto-update: $(date '+%Y-%m-%d %H:%M')"
git push origin main

echo "[update_dashboard] Done."
