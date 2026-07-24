# Consent Scanner

Scans client sites to answer four questions per site:
1. Which CMP is installed (or none)
2. Is the consent banner actually visible
3. Are Google Consent Mode defaults set
4. Which ad/analytics pixels fire BEFORE any consent interaction

Output includes the GTM custom-event trigger name for the detected CMP,
so results plug directly into the consent update procedure.

## Run locally (basic mode, no browser needed)
    pip install -r requirements.txt
    python app.py
Basic mode fetches raw HTML only - it detects most CMPs but cannot check
banner visibility, Consent Mode, or pre-consent fires.

## Enable full scans (headless Chromium)
    playwright install --with-deps chromium

## Deploy on Render
- New Web Service from this repo
- Build command:
    pip install -r requirements.txt && playwright install --with-deps chromium
- Start command:
    gunicorn app:app --timeout 180 --workers 1 --threads 4
- Instance: Standard (2 GB) - Chromium is memory-hungry; Starter will OOM.
- No env vars or database required. The app is stateless.

## Notes / known limits
- Scans only the submitted page (usually the homepage). A CMP or pixel
  present only on inner pages will be missed - scan a landing page URL
  directly when in doubt.
- Some CMPs geo-gate the banner. Scans run from Render's US region, which
  is the right vantage point for US state-law checks.
- Google endpoints seen pre-consent are classified as informational when
  they carry a denied-state Consent Mode gcs= parameter (expected
  cookieless pings), and as "verify" when Consent Mode defaults exist.
- Custom-built banners with no known signature return "No CMP" - treat
  those as manual review, not gospel.
- Batches run sequentially from the browser (one request per site), so
  the server stays stateless. For adtini, dev should move this to an
  async job queue.

## v0.2.0 - consent simulation + DSP pixel verification
- After the pre-consent capture, the scanner clicks the CMP's Accept
  button (known selectors for all 14 CMPs + a generic text fallback) and
  watches a second window of network traffic.
- DSP pixels (BARCK+/Beeswax, The Trade Desk, Yahoo DSP, CM360/DV360
  Floodlight) are reported vendor-level: fired pre-consent, post-consent,
  or both. "Post only" = gated and working. "Pre only" = working but not
  consent-gated. Edit DSP_ENDPOINTS in signatures.py to add vendors.
- Trackers that fire ONLY after Accept are listed as gated-correctly -
  this is the "is the pixel working" verification.
- Caveat: DSP conversion/segment pixels often live on inner pages or fire
  on events (form submit, purchase) rather than page load - scan the page
  where the pixel is actually placed, and treat "none seen" as "not on
  this page," not "not on this site."

## v0.3.0 - persistence, timestamps, scheduled scans
- Scan results persist in the browser (localStorage, last 200) and
  survive refresh. "Clear results" wipes them. Note: per-browser - a
  different machine/profile starts empty.
- Each result card shows its scan date + time (viewer's local time).
- batch_scan.py runs the same scans headlessly for a Render Cron Job:
  New > Cron Job on the same repo (Docker runtime, Standard instance),
  Docker command "python batch_scan.py", schedule e.g. "0 11 * * *"
  (daily 7am ET during EDT / 11:00 UTC).
  Sites: SITES env var (comma/newline separated) or sites.txt in repo.
  Email: set SES_FROM, SES_TO, AWS_REGION, AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY to receive the CSV report. ALERT_ONLY=1 emails
  only when a site is flagged (no CMP, pre-consent fires, ungated DSP
  pixels, or scan errors) - silence means all clean.

## v0.4.0 - Postgres history, in-UI schedule, sturdier accept-click
- Accept-click now waits up to 6s for the banner, searches EVERY frame
  (iframe banners like TrustArc/Quantcast), then falls back to loose
  button-text matching and finally strictly-labeled links.
- With DATABASE_URL set (Render Postgres, Internal URL, on BOTH the web
  service and the cron job): scan history is stored server-side and
  loads for everyone on every machine; the Recurring Scans panel appears
  in the UI to add/remove sites and set frequency (daily / weekly /
  off). Weekly sites run Mondays. The cron job reads this schedule;
  without a DB it falls back to SITES env or sites.txt.
- Without DATABASE_URL everything still works; results persist per
  browser via localStorage and the schedule panel stays hidden.
- Cron setup unchanged: New > Cron Job, same repo/Dockerfile, Docker
  command "python batch_scan.py", schedule "0 11 * * *".

## v0.5.0 - product-based pixel verification
- New scan inputs: client website, optional conversion URLs (each page
  is scanned with the same settings), and a Products multiselect
  (Amazon, BARCK+, LinkedIn, Meta, Mobile, PPC, Performance Max,
  TikTok, WVID).
- Selecting a product means "this client bought it" - its pixels are
  expected, and 0 firing is flagged as MISSING in the verdict and the
  daily alert email. With nothing selected, all products are checked
  and only those seen are reported.
- Multi-pixel products report completeness: BARCK+ = Beeswax conversion
  + Beeswax segment + Yahoo + Floodlight + Trade Desk, shown as e.g.
  2/5 with per-pixel status. Each sub-pixel is marked post-consent
  (gated + working), pre-consent only (working, not gated), or not
  firing.
- Recurring sites save their product selection; the cron job verifies
  those products on every run and ALERT_ONLY flags missing products.
- Endpoint map lives in PRODUCT_PIXELS in signatures.py - one dict
  entry to add a product or sub-pixel.

## v0.6.0 - collapsed history, scheduled conversion URLs
- Restored results load collapsed (newest first); only a lone fresh scan
  auto-expands. New scans appear at the top.
- Adding a recurring site now saves the conversion URLs from the scan
  form along with the products. Recurring runs scan the main site plus
  its conversion URLs by default; the per-site "N conv URLs" checkbox
  turns that off without deleting the list.

## v0.7.0 - client runs, deletion, collapsed products, macro warnings
- Client name input; saved on every scan and on scheduled sites.
- A scan run (client site + conversion URLs) renders as ONE panel named
  for the client, with per-page results inside and a worst-case status
  badge. Panels load collapsed; only the run just scanned auto-expands.
- Delete button per run removes it from server history (or local
  storage when no DB).
- Product pixel sections are collapsed by default - the header shows
  x/y firing plus a missing/partial/firing badge; expand for per-pixel
  detail.
- Pixel URLs containing unreplaced trafficking macros like [ORDER] or
  {orderid} get an "unfilled macros" warning - the tag fires but sends
  blank conversion data. ${GDPR}-style consent macros are expected and
  not flagged.

## v0.8.0 - tabs, tooltips, recurring management
- Two tabs: Scan (form + results) and Recurring scans (schedule list).
  The Recurring tab hides entirely when no database is connected.
- "Add to recurring" button in the scan form saves the whole client
  (name, site, conversion URLs, products) with the chosen frequency;
  quick-add moved out of the schedule panel.
- Edit on a schedule row loads the client back into the scan form;
  pressing Add to recurring re-saves (upsert by site URL).
- Hover tooltips on every consent-chain cell explain what the check
  means and how to read its states.

## v0.8.1 - deploy fix + speed pass
- FIX: v0.7.x deploy crash (ZoneInfoNotFoundError) - the Playwright
  image lacks the system tz database. Added the tzdata pip package and
  a UTC fallback so the deploy stamp can never break boot.
- Speed: networkidle waits capped (4s pre-consent / 3s post), settle
  trimmed to 2s, and images/media/fonts are no longer downloaded
  (requests are still recorded at initiation, so pixel detection is
  unaffected). Typical full scans drop from 15-40s to roughly 7-15s.
- UI batches now run 2 scans in flight (4 in basic mode); the cron job
  scans SCAN_CONCURRENCY sites in parallel (default 2, max 4). On the
  2GB instance, 2 concurrent Chromiums is the safe ceiling.

## v0.8.2
- Conversion URLs that duplicate the client website (or each other,
  ignoring http/https, www, and trailing slashes) are skipped in scans,
  when saving to recurring, and in cron runs of previously saved sites.
