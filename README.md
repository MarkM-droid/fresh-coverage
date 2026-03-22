# fresh-coverage

Grocery delivery coverage tracker for competitive research. Tracks which US zip codes are served by Amazon Fresh and Kroger same-day delivery. Schema is extensible to add more retailers.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and add your BRAVE_API_KEY
```

### 3. Initialize the database

```bash
npm run setup
```

This will:
- Create `data/coverage.db` with the full SQLite schema
- Download US zip code data (~40k zips) and seed the `zip_master` table
- Seed the `retailers` table with Amazon Fresh and Kroger

To force a re-seed of zip codes: `node src/setup_db.js --reseed`

---

## Running the probes

### Brave Search probe (primary)

Uses the Brave Search API to find evidence of grocery delivery availability by geography.

```bash
# Probe all retailers, all states
npm run probe:search

# Probe a specific retailer
npm run probe:search -- --retailer amazon_fresh
npm run probe:search -- --retailer kroger

# Probe a single state
npm run probe:search -- --retailer all --state TX
npm run probe:search -- --retailer amazon_fresh --state CA
```

Requires `BRAVE_API_KEY` in `.env`. Rate-limited to 1 request/second. Saves a dated JSON snapshot to `data/snapshots/` after each run.

### Direct HTTP probe (secondary, Amazon Fresh only)

Directly probes Amazon's availability endpoints. Very conservative to avoid detection.

```bash
# Probe default batch (unprobed or stale zips, ordered by population)
npm run probe:direct

# Probe a specific zip
npm run probe:direct -- --zip 10001

# Probe a specific state (up to 100 zips)
npm run probe:direct -- --state TX
```

**Limits:** max 100 zips/run, 3–8 second random delays between requests. Stops immediately on 429 or CAPTCHA detection.

---

## Diffing runs

Compare the last two probe runs to identify expansion/contraction:

```bash
npm run diff

# Filter by retailer
npm run diff -- --retailer amazon_fresh

# Compare two snapshot files directly
npm run diff -- --file data/snapshots/2024-01-15_search_amazon_fresh.json data/snapshots/2024-01-22_search_amazon_fresh.json
```

Outputs a summary to console (new zips, lost zips, by state) and saves `logs/diff_YYYY-MM-DD.json`.

---

## Generating the HTML report

```bash
npm run report
```

Generates `reports/index.html` — a self-contained HTML page (no external dependencies) with:
- Retailer summary table (total zips, states, last updated)
- "New this week" section
- Full sortable/filterable coverage table

Open `reports/index.html` in any browser.

---

## Cron job setup

To run probes automatically, add entries to your crontab:

```cron
# Run Brave search probe daily at 2am (all retailers)
0 2 * * * cd /path/to/fresh-coverage && node src/search_probe.js >> logs/cron.log 2>&1

# Run direct probe daily at 3am (Amazon Fresh only)
0 3 * * * cd /path/to/fresh-coverage && node src/direct_probe.js >> logs/cron.log 2>&1

# Generate report daily at 4am
0 4 * * * cd /path/to/fresh-coverage && node src/report.js >> logs/cron.log 2>&1

# Diff weekly on Mondays at 5am
0 5 * * 1 cd /path/to/fresh-coverage && node src/diff.js >> logs/cron.log 2>&1
```

---

## Adding a new retailer

1. Insert the retailer into the database:
   ```sql
   INSERT INTO retailers (id, name, website) VALUES ('target', 'Target', 'https://www.target.com');
   ```

2. Add search query logic in `src/search_probe.js` inside the `buildQueries()` function:
   ```js
   } else if (retailerName === 'Target') {
     return [
       `"Target" "same day delivery" "${loc}" grocery`,
     ];
   }
   ```

3. Run the probe:
   ```bash
   node src/search_probe.js --retailer target
   ```

The `zip_coverage` table uses a `(retailer_id, zip)` primary key, so all existing queries and reports automatically include new retailers.

---

## Project structure

```
fresh-coverage/
  data/
    coverage.db          # SQLite database (gitignored)
    snapshots/           # Dated JSON snapshots (gitignored)
  src/
    setup_db.js          # DB schema creation and zip seed
    search_probe.js      # Brave Search-based prober
    direct_probe.js      # Direct HTTP prober (Amazon Fresh)
    diff.js              # Snapshot/run diffing
    report.js            # HTML report generator
  reports/
    index.html           # Generated report
  logs/                  # Run logs and diff outputs (gitignored)
  .env.example
  package.json
  README.md
```

---

## Database schema overview

| Table          | Purpose |
|----------------|---------|
| `retailers`    | Retailer registry (id, name, website) |
| `zip_master`   | US zip code reference data (city, state, lat/lng, population) |
| `zip_coverage` | Coverage status per (retailer, zip) with source/confidence tracking |
| `runs`         | Audit log of each probe run |

Coverage `available` values: `1` = confirmed available, `0` = confirmed unavailable, `2` = unknown/unconfirmed.
