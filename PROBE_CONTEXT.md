# Amazon Fresh Probe — Operational Context

## What Works vs What Doesn't

### Browser Automation (Playwright)

**✅ WORKS: Foreground, long-running, single page reused**
- The original successful Dallas probe (313 ZIPs, ~5.5 hours) used `headless: false`, a single browser instance, and a SINGLE PAGE reused across all ZIPs
- Run as an attached foreground process — not nohup, not background
- The exec tool with a long `yieldMs` keeps it attached
- Example: `node scripts/dallas_zip_probe.js` in a PTY session

**❌ DOES NOT WORK: headless: true in background**
- `nohup node ... &` loses the display connection
- Browser crashes after the first ZIP with "Target page, context or browser has been closed"
- Even with `--no-sandbox --disable-dev-shm-usage` flags

**❌ DOES NOT WORK: browser.newContext() per ZIP**
- Creating a new browser context for each ZIP causes crashes after the first successful one
- The browser process dies and subsequent newContext() calls fail
- Use a single page, change ZIP in place, reload for each product check

**✅ WORKS: PTY exec with long yieldMs**
- `exec(command, { pty: true, yieldMs: 21600000 })` (6 hours)
- Keeps the session attached and visible browser alive
- Results saved incrementally so resume is possible with `--resume` flag

---

### ZIP Code Strategy

**Key lesson:** The first ASIN returned by Amazon search may be unavailable for a given ZIP even when other ASINs for the same product are available. Always try multiple ASINs before returning `none`.

**Fixed approach (in dallas_zip_probe_v2.js):**
1. Try known-good ASINs first (hardcoded list of reliable fresh produce ASINs)
2. Then try up to 8 candidates from natural language search
3. Only return `none` if ALL candidates are unavailable

**Known-good ASINs:**
- Strawberries: `B08911ZP3Y` (2 Lb), `B000P6J0SM` (1 Lb), `B002B8Z98W` (Organic 1 Lb)
- Bananas: `B07ZLF9WQ5`, `B07ZLFPXHC`

**Search term:** Use `"fresh strawberries"` not just `"strawberries"` to get produce results first.

---

### Offer Type Parsing

**The problem:** Searching for "AmazonFresh", "Whole Foods", "Ships from" anywhere in the page body returns false positives. These strings appear in navigation, recommendations, and related product listings even when they're not the actual delivery offer.

**✅ WORKS: Parse from specific DOM elements only**
- Buybox: `#buybox, #rightCol` → look for "Shipper / Seller: X" text nodes
- Other sellers panel: `#aod-container` after clicking "Other sellers" button → look for "Ships from: X" within offer blocks

**❌ DOES NOT WORK: Full body text scan**
- `body.includes('amazonfresh')` returns true for every page in Dallas because WholeFoods and AmazonFresh appear in nav/recommendations
- This caused all 200 confirmed ZIPs to show all 3 offer types simultaneously — meaningless

**The correct signal:**
- Primary offer: "Shipper / Seller: Amazon.com" in buybox = SSD or Fresh dark store
- Panel offer: "Ships from: Whole Foods Market" = Whole Foods fulfillment
- Panel offer: "Ships from: AmazonFresh" = Amazon Fresh dark store (U-prefix)

---

### Session Stability

**Login:** Amazon does NOT require login to see fresh grocery offers in confirmed markets. Tested manually in Frisco 75033 without login — strawberries available.

**Bot detection:** The probe has been running without CAPTCHA or blocks for hundreds of ZIPs. Amazon appears to be tolerating automated browsing as long as:
- Real user agent is set
- `navigator.webdriver = false` init script is applied  
- Delays between requests (1.5-2 seconds minimum)
- Visible browser (headless: false)

---

### Resuming Probes

All probe scripts save incrementally after each ZIP. To resume:
- Results are keyed by ZIP code in the JSON file
- Script skips already-probed ZIPs on startup
- Safe to kill and restart at any time

---

### Validated Findings (Dallas MSA, April 2026)

- **313 ZIPs probed** across Dallas-Fort Worth MSA
- **~200 ZIPs confirmed** (bananas available = SSD-fulfilled fresh delivery)
- **~113 ZIPs none** — outer ring of the metro, edges of service area
- **Effective service radius:** ~25 miles from SSD facility (not 50 miles as Amazon publicly states)
- **Full cold-chain (strawberries)** likely much higher than the 2 originally found — original probe used single ASIN that was out of stock; multi-ASIN fix needed to re-run
- **Service area pattern:** None ZIPs form a ring around the outer metro edges (south: Waxahachie, Midlothian; west: Granbury, Springtown; east: Terrell, Kaufman; north: Denison)
- **Spillover confirmed:** Sherman TX (just north of DFW MSA) gets fresh delivery from Dallas SSD network

---

### Recommended Run Process for Full MSA Probe

```bash
# 1. Start a PTY session with long timeout
# 2. Run from project directory
cd /Users/warrenmatthews/.openclaw/workspace/projects/fresh-coverage

# 3. Remove old results if starting fresh
rm -f data/dallas_zip_results.json

# 4. Run foreground (NOT nohup, NOT &)
node scripts/dallas_zip_probe_v2.js

# 5. Let it run 5-6 hours
# 6. Results save incrementally to data/dallas_zip_results.json
# 7. If interrupted, just re-run — it will skip already-probed ZIPs
```
