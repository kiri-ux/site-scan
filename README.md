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
