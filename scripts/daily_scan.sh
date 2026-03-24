#!/bin/bash
# daily_scan.sh — Deterministic daily scan for fresh-coverage
# Called by cron. Exits non-zero on failure, logs to logs/daily_scan.log
# Usage: bash scripts/daily_scan.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/logs/daily_scan.log"
DATE=$(date '+%Y-%m-%d')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$ROOT/logs"

log() {
  echo "[$TIMESTAMP] $1" | tee -a "$LOG"
}

log "=== Daily scan starting: $DATE ==="

cd "$ROOT"

# Load env
[ -f .env ] && export $(grep -v '^#' .env | xargs)

# Step 1: City probe (Brave web search for new coverage)
log "Step 1: city_probe"
if node src/city_probe.js >> "$LOG" 2>&1; then
  log "city_probe OK"
else
  log "ERROR: city_probe failed (exit $?)"
  exit 1
fi

# Step 2: DMA probe (prioritized queue)
log "Step 2: dma_probe --max 30"
if node src/dma_probe.js --retailer amazon_same_day --max 30 >> "$LOG" 2>&1; then
  log "dma_probe OK"
else
  log "ERROR: dma_probe failed (exit $?)"
  exit 1
fi

# Step 3: Snapshot
log "Step 3: snapshot"
if node src/snapshot.js >> "$LOG" 2>&1; then
  log "snapshot OK"
else
  log "ERROR: snapshot failed (exit $?)"
  exit 1
fi

# Step 4: Report
log "Step 4: report"
if node src/report.js >> "$LOG" 2>&1; then
  log "report OK"
else
  log "ERROR: report failed (exit $?)"
  exit 1
fi

# Step 5: Sync to GitHub Pages
log "Step 5: GitHub Pages sync"
cp reports/index.html docs/index.html
if git add docs/index.html && git commit -m "Daily update $DATE" && git push >> "$LOG" 2>&1; then
  log "GitHub Pages sync OK"
else
  log "WARNING: GitHub Pages sync failed — report generated locally but not published"
fi

# Step 6: Health check
log "Step 6: health check"
CONFIRMED=$(node -e "
import Database from 'better-sqlite3';
const db = new Database('data/coverage.db');
const r = db.prepare(\"SELECT total_cities_confirmed FROM snapshot_totals WHERE retailer_id='amazon_same_day' ORDER BY snapshot_date DESC LIMIT 1\").get();
console.log(r?.total_cities_confirmed || 0);
" --input-type=module 2>/dev/null)

PREV=$(node -e "
import Database from 'better-sqlite3';
const db = new Database('data/coverage.db');
const r = db.prepare(\"SELECT total_cities_confirmed FROM snapshot_totals WHERE retailer_id='amazon_same_day' ORDER BY snapshot_date DESC LIMIT 1 OFFSET 1\").get();
console.log(r?.total_cities_confirmed || 0);
" --input-type=module 2>/dev/null)

log "Health: confirmed cities today=$CONFIRMED, yesterday=$PREV"

if [ "$CONFIRMED" -lt "$PREV" ]; then
  log "ALERT: confirmed city count dropped ($PREV -> $CONFIRMED) — possible data issue"
  # Still exit 0 — don't fail the scan, just flag it
fi

QUEUE=$(node -e "
import Database from 'better-sqlite3';
const db = new Database('data/coverage.db');
const r = db.prepare(\"SELECT COUNT(*) as n FROM probe_queue WHERE status='pending'\").get();
console.log(r.n);
" --input-type=module 2>/dev/null)

if [ "$QUEUE" -lt 10 ]; then
  log "ALERT: probe queue nearly empty ($QUEUE pending) — consider rebuilding"
fi

log "=== Daily scan complete: $DATE | confirmed=$CONFIRMED | queue=$QUEUE ==="
