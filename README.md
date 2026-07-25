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

## v0.8.3
- Page rows: badges only for real problems (pre-consent fires, pixels
  missing, scan error). No CMP shows no badge; the empty CMP column in
  the chain still tells the story. Full-mode chip removed as noise.
- Product status inline on each row: name + check/X (green check all
  firing, amber partial, red X missing). Counts (#/#) shown only for
  multi-pixel products i.e. BARCK+.
- Removed the unfilled-macros summary chip; the per-pixel explanation
  remains inside the expanded product detail.

## v0.9.0 - browser pool, group summary, UI trims
- Persistent Chromium pool: BROWSER_POOL worker threads (default 2)
  each keep a browser alive across scans, removing the 2-3s launch per
  scan and hard-capping concurrent browsers server-side. Crashed
  browsers relaunch automatically and the scan retries once. Warm full
  scans now typically run 4-10s.
- Each client panel opens with a summary consent chain for the main
  site (shortest URL in the run), so the client-level verdict reads
  without expanding page rows.
- Clear results button removed - per-run Delete covers removal, and
  refresh reloads server history anyway.
- Accept-button wait trimmed 6s -> 4s.

## v0.9.1
- Edit button on each completed run loads its client name, main site,
  conversion URLs, and product selection back into the scan form for
  adjusting and re-running (the re-run is saved as a new run; the
  original stays in history until deleted).

## v0.9.2
- Verdict box renders as separate rows (finding / product pixels /
  missing list) instead of one paragraph.
- Pages with NO CMP no longer stamp each tracker as a VIOLATION -
  trackers list as neutral "ungated" inventory, and the red flag stays
  on the site-level missing-CMP verdict. VIOLATION is reserved for a
  present-but-bypassed consent setup.

## v0.9.3 - reject-path testing, conversion URL pills
- Reject-path test: when a CMP with a visible banner is found, a second
  fresh page load clicks Reject/Decline (direct-reject selectors for 11
  CMPs + strictly-anchored text fallback that never guesses) and checks
  nothing fires afterward. Trackers firing post-Reject are flagged
  "fires after reject" (row badge, chain cell "Reject honored", verdict
  line, CSV column, and daily alert). "No reject option" is reported
  neutrally - common and lawful on US opt-out banners. Adds ~6-9s per
  CMP page.
- Conversion URLs input converted to pills: type or paste (multi-line
  paste splits automatically), Enter to add, x or Backspace to remove.
  Duplicates of the main site or each other are rejected at entry.

## v0.9.4 - shareable scan links
- Share button on each run copies a read-only link (/run/<run_id>)
  showing only that client's scan: no tabs, inputs, schedule, or other
  clients' data. Includes an automated-scan scope footnote per the
  liability discussion. Rendering code moved to static/render.js,
  shared by both pages.
- Links are unauthenticated (like the app itself) - treat them as
  "anyone with the link" until a password gate is added.

## v0.10.0 - state targeting, GPC test, opt-out link check
- State targets chip row (20 tracked states). Selections save with runs
  and recurring sites, restore on Edit, export to CSV.
- GPC pass: when a targeted state requires universal opt-out signals, a
  third page load carries Sec-GPC: 1 + navigator.globalPrivacyControl
  and records ad trackers contacted anyway. Adds ~5-8s.
- Opt-out link detection: recognizable opt-out phrases searched in the
  rendered page.
- Per-state check results (pass/fail with check-based language, never
  legal conclusions) render as a chain cell, detail section, row badge,
  verdict line, CSV columns, and daily-alert trigger.
- Check map lives in state_checks.py with citations, LAST_REVIEWED
  date, and a 120-day staleness window; a formatted copy for counsel
  review ships as state-law-check-map.docx. Twelve states currently
  require GPC honoring (verified against current reporting at build
  time); NJ/MD/MN dates flagged for counsel verification.
- /favicon.ico now redirects to the SVG favicon for stubborn browsers.

## v0.10.1
- Conversion URL pills strip trailing annotations like "(view-through)"
  and reject non-URL text outright.
- Scan requests carry a 150s client timeout and treat non-200 responses
  as failures, so a mid-scan deploy or dead connection errors that page
  and the batch continues instead of freezing.
- gunicorn now writes access + error logs, so scan requests are visible
  in Render Logs.

## v0.10.2
- URL cleaning now applies on every path pills can be populated:
  typing/pasting, Edit from a run, Edit from a schedule row, and a
  final sweep at scan time. The server cleans conversion lists on
  schedule save, and the cron skips non-URL lines in legacy rows.

## v0.10.3
- Favicon links carry a cache-busting version query - Chrome keeps
  favicons in a separate cache that ignores hard refreshes, and a new
  URL is the reliable way to evict a stale (missing) icon entry.

## v0.10.4
- Pasted text yields EVERY URL it contains, not just the first - a line
  like "url1 + notes: url2" becomes two pills. Same on schedule save.
  TLD required, so prose and "e.g." never become pills.

## v0.10.5 - heavy-site stall fixes
- Page-load cap trimmed 30s -> 20s and every context now carries a 15s
  default CDP timeout, so a wedged call can never wait silently.
- Accept attempt skipped when no CMP and no banner exist (saves 4s on
  every no-CMP page).
- Stale-job handling: if the caller has given up (120s), pool workers
  skip the job and skip the relaunch-retry instead of grinding through
  abandoned work and starving the queue - this was the stall cascade
  on heavy ad-laden sites.
- Browsers recycle after RECYCLE_AFTER scans (default 8): long-lived
  Chromium on ad-heavy pages accumulates memory until CDP calls wedge.
- Every scan logs "[scan] start/done url [verdict] Xs" to stdout, so
  Render Logs show live per-page progress and timings.

## v0.10.6 - site-level checks run once per client
- Reject-path and GPC passes (and their state checks) now run only on
  the MAIN site; conversion pages get the light pass (pre-consent,
  accept, product pixels) since CMP/GPC behavior is site-wide while
  pixels vary per page. Roughly halves total loads on state-targeted
  clients. Conversion rows show "See main site" in the Reject cell.
  Cron applies the same split. Override per request with site_checks.
- State target chips ordered alphabetically.

## v0.10.7
- Scanner prints "[scanner] rev X loaded" at boot so Render logs prove
  which scanner.py is actually deployed (catches partial uploads).

## v0.10.8 - request-storm wedge fix (the /secret stall)
- All settle waits now use page.wait_for_timeout, which services route
  callbacks while waiting; time.sleep blocked the thread that answers
  intercepted requests, so a request-storm page (continuous ad pixel
  fires) piled up unanswered intercepts and context.close() hung
  forever draining them - wedging the pool worker on that page every
  run. Pages also unroute before close as a second guard.

## v0.10.9 - loud fallback + always-full scans
- When full_scan fails and the scanner silently falls back to basic
  mode, the exception and traceback now print to the logs ("[scan]
  FULL SCAN FAILED ..."). Silent fallback made the pool look broken
  with no evidence; diagnosis was impossible.
- Full-scan checkbox removed; every UI scan is a full scan. Basic mode
  remains as the server-side resilience fallback only.

## v0.10.10 - the hardening that was supposed to be in 0.10.5
- Discovered the v0.10.5 pool hardening (per-scan [scan] start/done
  logging, stale-job skipping, guarded retry, browser recycling) never
  actually persisted into scanner.py - a later patch clobbered it while
  version notes claimed otherwise. Restored all of it, verified this
  time by asserting the log output itself, not the patch result.
- Also fixes a real bug the archaeology surfaced: the crash-retry path
  dropped site_checks, so a retried main-site scan lost its state/GPC
  passes.
- Verdict prints show ok/error class; recycling logs itself.

## v0.10.11 - THE 4/11 stall: renderSite crash (client-side)
- Root cause of every 4/11 stall since build 0.9.4: the share-page
  refactor cut renderSite's `meta` definition while the verdict box
  still used meta.cls, so EVERY render threw ReferenceError. Each scan
  worker inserted a success (+1), render threw, the catch inserted an
  error card (+1), render threw again inside the catch, and the worker
  died - two workers, exactly 4/11, label frozen on the last-started
  URL, requests 3+ never sent. The server was never at fault.
- Fixed the definition, hardened cmp-evidence rendering, and armored
  the scan loop: render/save failures now log to the browser console
  and can never kill a worker.
- All render paths (full, error, CMP with and without evidence) are
  executed in CI-style checks now, not just template-string-checked.

## v0.11.0 - delete all, summary-level state checks, tooltip fix
- Delete all button next to Download CSV: confirm, then wipes every
  scan from server history (POST /scans/delete_all) and local view.
- State checks moved to the client summary (the main-site strip at the
  top of each run panel, and the top of share pages) - they're
  client-level facts, so per-page rows no longer repeat them.
- Chain hover tooltips fixed: a tip containing double quotes broke the
  title attribute mid-string, killing hovers from that cell onward.
  Tips are escaped now; hover any chain cell for its explanation.

## v0.11.1 - other pixels section
- "Requests before consent" renamed "Other pixels", moved below the
  Product pixels section, and rendered as an expander - collapsed by
  default, auto-expanded (with a red count badge) when it contains
  pre-consent violations on a CMP page.
- Pixels already reported under a product (e.g. Floodlight inside
  BARCK+) no longer repeat in the general list on no-CMP pages - the
  product section carries their consent state. CMP-bypass violations
  still list in both places deliberately: the bypass is the finding.

## v0.11.2 - opt-out mechanism check, header tags, less repetition
- New synthesized state check "Opt-out mechanism": fails when a state-
  targeted page has no CMP, no opt-out link, AND (where required) ad
  trackers fire despite GPC - i.e. no way for residents to opt out at
  all, the pattern enforcement actually targets. A banner alone is
  never flagged as legally required (US state laws are opt-out
  regimes), keeping the check-based language honest.
- Run headers show product marks (BARCK+ 5/5 with check/x) and state
  target tags from the main site.
- Page rows no longer repeat the chain and verdict - the client
  summary owns them. Error/basic pages keep their message box.

## v0.11.3
- New gold "Build vs market" tab inside the app: the full capability
  matrix vs Code-Cube / Lokker / ObservePoint / ConsentPixel / CMPs,
  the price ladder, proposed pricing cards, rationale, and open
  decisions - the internal one-pager, always one click away.

## v0.11.4 - partner name, flat pixel sections
- Partner name field beside Client name: saved with runs and recurring
  sites, shown on the run header ("via Larsen Media Group"), restored
  by Edit, exported in CSV, carried through cron scans.
- Product pixels render as flat cards (header row + always-visible
  pixel rows) and Other pixels is its own headed section - no more
  expand/collapse hiding the detail.

## v0.11.5
- Consent setup pricing copy rewritten to cover both client paths:
  CMP sites get the GTM procedure applied and verified; no-CMP sites
  get a documented findings package for the banner conversation. The
  fee is justified by the onboarding audit every client receives.

## v0.12.0 - password gate
- Set SCANNER_PASSWORD in the environment to require sign-in. Sessions
  last 30 days. Share pages (/run/...), their API, static assets, and
  /health stay open - share links are for clients and don't include
  the Build-vs-market tab. /logout ends the session. Optionally set
  SECRET_KEY to keep sessions valid across password changes.
- No password set = no gate (unchanged behavior).

## v0.12.1
- Build-vs-market: removed the BARCK+ rationale bullet, added a link
  to the state-law check map Google Doc under the legal-gate decision,
  and added "free for all clients" as a bundle option.

## v0.12.2
- Save client button: persists the full client setup (name, partner,
  conversion URLs, products, states) without scanning. Keeps the
  existing schedule frequency for saved clients; new clients save with
  the schedule off. Add to recurring continues to save with the chosen
  frequency.

## v0.12.3
- Legal safeguards section on the Build-vs-market tab and one-pager:
  check-based language, no compliance claims, scope disclosure,
  counsel-reviewed ToS with liability cap, E&%O confirmation, alert
  SOP, check-map review cadence, internal-first sequencing.

## v0.12.3
- Build-vs-market gains a "Legal posture" section: check-based
  language, scope disclaimers, ToS/E&O gates, alert-handling SOP, and
  the quarterly state-map review, condensed from the liability
  discussion. Also on the one-pager.
- Run headers fall back to the saved client record for the partner
  name, so runs scanned before the partner field existed show it too.

## v0.12.4
- Legal posture section collapses by default on the Build-vs-market
  tab (and the one-pager, where it auto-expands for printing).

## v0.12.5
- Hover tooltips on the "pre-consent only" and "ungated" badges
  explaining what each means and how they differ.
- Run headers show the partner name plain (no "via").

## v0.12.6
- Run-header Share / Edit / Delete are compact icon buttons (tooltips
  and aria-labels preserved; Share flashes a checkmark when the link
  copies).

## v0.12.7
- Open decisions gains a launch-promo idea: free for the rest of 2026
  as the pilot, converting to paid Jan 1 - with the note that ToS and
  disclaimers still apply from day one.

## v0.12.8
- YouTube product added: checks Google Ads conversion/remarketing
  (googleadservices, googleads.g.doubleclick.net) and GA4 pixels,
  matching how YouTube campaigns actually track.

## v0.12.9
- ComplyAuto added as the 15th CMP signature (automotive-dealership
  CMP, seen on gohansel.com): domain, JS globals, banner selectors,
  and their "Deny targeting cookies" button in the reject fallback.
  GTM trigger event not yet mapped - noted in the CMP notes.

## v0.12.10
- SEO product added: checks Google Analytics (GA4 g/collect plus
  legacy UA collect endpoints). Pairs with the SEO quote tool line -
  monitoring proves the analytics client reporting depends on is
  actually firing and consent-gated.

## v0.12.11
- Unknown CMPs are now flagged: when no signature matches, a
  conservative heuristic (anchored element with consent text plus an
  accept/reject button, or IAB __tcfapi/__uspapi/__gpp APIs) reports
  "Unrecognized consent banner" with evidence, so a mechanism is never
  reported as "None found" just because the vendor is new to us.
- Run-header timestamp is a clock icon; the full "most recent pull"
  timestamp shows on hover. Header icons sit tighter.

## v0.12.12
- Banner visibility falls back to the generic banner probe when a
  known CMPs selectors miss its actual DOM (the Hansel/ComplyAuto
  case: vendor identified, banner clearly on screen, selectors blind).
- Starting a new scan no longer hides previous runs - history stays
  on screen and the new run inserts at the top.

## v0.12.13
- Vici-styled tooltips replace the browser-native ones everywhere:
  instant, branded (atlas panel, gold rule), positioned and clamped.
  Definitions added for every badge type (not seen, pre-consent only,
  pre+post, post-consent, firing/partial/missing, ungated, violation,
  after-reject, and the head badges), plus explainers on the Consent
  Mode Defaults line and CMP identification evidence. "not firing"
  renamed "not seen" - the check-based accurate claim.

## v0.12.14
- Consent Mode defaults line now carries a verdict note: green when
  every storage type starts denied (the target setup - no consent work
  needed), amber naming the granted keys when defaults leak, and amber
  when GTM + a CMP are present but no defaults exist at all.

## v0.12.15
- Native browser tooltips suppressed everywhere: any title attribute
  is migrated into the styled tip on first hover and removed, so only
  the Vici tooltip appears - including on elements added later.

## v0.12.16
- Loud Consent Mode stamp beside the Defaults line: green CORRECT
  SETUP when everything starts denied, red INCORRECT SETUP naming-free
  when defaults leak (the note below names keys), red NOT CONFIGURED
  when GTM + CMP exist with no defaults at all.

## v0.13.0 - configured-but-silent + client grouping
- "Not seen" pixels now split three ways by checking the page source
  AND the public GTM container JS (gtm.js?id=...) for the tag's code
  fingerprints: "configured, not firing" (code present, no request -
  a firing problem: trigger, consent block, or error), "not found"
  (no trace anywhere - likely never installed), and "not seen" when
  the code check couldn't run. CODE_HINTS per pixel in signatures.py.
- History groups by client: one row per client with a version picker
  inside the expand (pill per run, green/red status dot, newest first;
  Share/Edit/Delete act on the selected version). "N runs" count in
  the header.

## v0.13.1
- Product-pixel vocabulary unified with site posture: on no-CMP pages
  a fired-but-ungated product pixel is labeled "ungated" (matching
  Other pixels) with a banner-installation note; "pre-consent only"
  now appears ONLY on pages where a banner exists to be jumped.

## v0.13.2
- No-CMP chains hide the cells that only mean something with a banner
  present (Banner visible, Consent Mode default, Reject honored) - the
  red CMP cell owns that story. Consent Mode stays when its defaults
  are actually set (real signal even without a recognized CMP), and
  error pages keep the full chain.

## v0.13.3
- Open decisions: added the partner-seeding idea - free first to the
  highest-spend partners (Wheeler, LMSD) and partners with recent
  tracking/consent issues, turning them into the case-study base.

## v0.13.4
- YouTube checks Google Ads only. Google Analytics belongs to the SEO
  product; without SEO selected, GA surfaces in Other pixels.

## v0.13.5
- Macro-detection row removed from the capability matrix (macros are
  Vici-side trafficking hygiene, not a client-facing capability).
- Hardcoded-pixel remediation note: when a CMP page has pre-consent or
  after-reject violations, the report names the bypassing vendors and
  lays out the three fix paths (migrate to GTM + consent procedure,
  native consent APIs with gtag/fbq specifics, CMP script-blocking),
  ending with re-scan verification.

## v0.13.6
- "US tracking laws" slide-out panel: the every-site baseline (FTC
  deception, opt-out regime, honor-the-no, GPC, COPPA, wiretap risk),
  what the scanner checks against it, and a per-state expander
  generated live from state_checks.py - so the panel can never drift
  from what the scanner enforces. Review date + not-legal-advice
  footer built in.

## v0.13.7
- Universal privacy-policy check on every main-site full scan: a "US"
  row in the state checks passing when a privacy policy/notice link
  (or /privacy href) is present, failing when a tracking site has none
  - the FTC \xc2\xa75 baseline. Presence-only; content accuracy flagged for
  human review in the detail text.
