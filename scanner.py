"""
Consent Scanner core.

Two tiers:
  basic  - plain HTTP fetch + signature matching on the raw HTML.
           Fast, no browser. Catches CMPs loaded via a direct <script> tag.
  full   - headless Chromium via Playwright. Adds: JS-global + cookie
           detection (catches CMPs injected by GTM/plugins), banner
           visibility, Google Consent Mode default detection, and
           pre-consent tracker network capture.

scan_site() attempts full mode and degrades to basic if Playwright or
Chromium is unavailable, so the app runs anywhere.
"""

import re
import time
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

from signatures import (CMP_SIGNATURES, TRACKER_ENDPOINTS, PRODUCT_PIXELS,
                        ACCEPT_SELECTORS, GENERIC_ACCEPT_TEXT,
                        STRICT_ACCEPT_TEXT)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

GTM_ID_RE = re.compile(r"GTM-[A-Z0-9]{4,}")
REQUEST_TIMEOUT = 15
PAGE_TIMEOUT_MS = 30000
SETTLE_SECONDS = 2.0
NETIDLE_PRE_MS = 4000
NETIDLE_POST_MS = 3000


# ---------------------------------------------------------------- helpers

def normalize_url(raw):
    url = (raw or "").strip()
    if not url:
        return None
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if not host or ("." not in host and host != "localhost"):
        return None
    return url


def _match_domains(haystack):
    """Return {cmp_name: [matched fingerprint strings]} found in text."""
    hits = {}
    low = haystack.lower()
    for cmp in CMP_SIGNATURES:
        matched = [d for d in cmp["domains"] if d.lower() in low]
        if matched:
            hits[cmp["name"]] = matched
    return hits


def _cmp_by_name(name):
    return next((c for c in CMP_SIGNATURES if c["name"] == name), None)


def _classify_tracker(url):
    for t in TRACKER_ENDPOINTS:
        if any(p in url for p in t["patterns"]):
            return t
    return None


def _try_accept(page, cmp_names, wait_seconds=4):
    """Click the consent banner's Accept control. Returns the click
    timestamp, or None if nothing clickable was found.

    Strategy, in order:
      1. CMP-specific selectors, retried for up to `wait_seconds` across
         EVERY frame (banners often render late, and TrustArc/Quantcast
         and others render inside an iframe).
      2. Any visible <button> whose text loosely matches accept language.
      3. Links / [role=button] with STRICTLY anchored accept text - last
         because clicking a look-alike link can navigate away.
    Playwright selectors pierce open shadow DOM (Usercentrics) natively.
    """
    selectors = [sel for name in cmp_names
                 for sel in ACCEPT_SELECTORS.get(name, [])]

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        for frame in page.frames:
            for sel in selectors:
                try:
                    el = frame.query_selector(sel)
                    if el and el.is_visible():
                        t = time.time()
                        el.click(timeout=2000)
                        return t
                except Exception:
                    pass
        time.sleep(0.5)

    loose = re.compile(GENERIC_ACCEPT_TEXT, re.I)
    strict = re.compile(STRICT_ACCEPT_TEXT, re.I)
    for pattern, css in ((loose, "button"),
                         (strict, "a, [role='button'], input[type='button'], "
                                  "input[type='submit']")):
        for frame in page.frames:
            try:
                loc = frame.locator(css).filter(has_text=pattern)
                for i in range(min(loc.count(), 8)):
                    item = loc.nth(i)
                    try:
                        txt = (item.inner_text(timeout=500) or "").strip()
                        if len(txt) > 40 or not item.is_visible():
                            continue
                        if pattern is strict and not strict.search(txt):
                            continue
                        t = time.time()
                        item.click(timeout=2000)
                        return t
                    except Exception:
                        continue
            except Exception:
                continue
    return None


def _gcs_denied(url):
    """True if a Google request carries a Consent Mode gcs= param in a
    denied/partial state (i.e. it's a cookieless modeling ping)."""
    try:
        qs = parse_qs(urlparse(url).query)
        gcs = (qs.get("gcs") or [""])[0]
        return bool(gcs) and gcs != "G111"
    except Exception:
        return False


def _empty_result(url):
    return {
        "url": url,
        "scanned_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "mode": "basic",
        "ok": False,
        "error": None,
        "cmps": [],                 # [{name, evidence[], gtm_event, notes}]
        "gtm": {"found": False, "container_ids": []},
        "banner_visible": "unknown",       # true / false / "unknown"
        "consent_mode_default": "unknown", # true / false / "unknown"
        "consent_defaults": {},            # e.g. {"ad_storage": "denied"}
        "pre_consent": [],          # [{vendor, url, severity, note}]
        "accept_clicked": False,    # did the scan simulate clicking Accept
        "post_consent": [],         # tracker vendors that fired only after accept
        "products": [],             # [{product, expected, fired, pixels:[...]}]
        "verdict": None,
        "verdict_detail": None,
    }


# ---------------------------------------------------------------- tier 1

def basic_scan(url, result=None):
    result = result or _empty_result(url)
    try:
        resp = requests.get(url, headers={"User-Agent": UA},
                            timeout=REQUEST_TIMEOUT, allow_redirects=True)
        html = resp.text or ""
    except requests.RequestException as e:
        result["error"] = f"Could not fetch site: {e.__class__.__name__}"
        return result

    result["ok"] = True
    soup = BeautifulSoup(html, "html.parser")

    # Collect script srcs + link hrefs + inline script text, then the raw
    # HTML as a catch-all (covers CMS plugin asset paths).
    corpus_parts = []
    for tag in soup.find_all(["script", "link", "iframe"]):
        for attr in ("src", "href"):
            if tag.get(attr):
                corpus_parts.append(tag[attr])
        if tag.name == "script" and tag.string:
            corpus_parts.append(tag.string[:5000])
    corpus = "\n".join(corpus_parts) + "\n" + html[:200000]

    for name, evidence in _match_domains(corpus).items():
        sig = _cmp_by_name(name)
        result["cmps"].append({
            "name": name,
            "evidence": [f"script/domain: {e}" for e in evidence],
            "gtm_event": sig["gtm_event"],
            "notes": sig["notes"],
        })

    gtm_ids = sorted(set(GTM_ID_RE.findall(html)))
    result["gtm"] = {"found": bool(gtm_ids) or "googletagmanager.com" in html,
                     "container_ids": gtm_ids}
    return result


# ---------------------------------------------------------------- tier 2

def _full_scan_impl(browser, url, products=None):
    result = _empty_result(url)
    result["mode"] = "full"
    requests_seen = []  # (timestamp, url)

    if True:  # preserve indentation of the original with-block
        context = browser.new_context(user_agent=UA, locale="en-US",
                                      viewport={"width": 1366, "height": 900})
        page = context.new_page()
        page.on("request",
                lambda req: requests_seen.append((time.time(), req.url)))

        def _route(route):
            # Skip downloading heavy assets for speed. Scripts, XHR, and
            # stylesheets still load (CMPs and tags need them); aborted
            # requests are already captured by the request listener above.
            if route.request.resource_type in ("image", "media", "font"):
                route.abort()
            else:
                route.continue_()
        page.route("**/*", _route)

        try:
            page.goto(url, wait_until="domcontentloaded",
                      timeout=PAGE_TIMEOUT_MS)
            try:
                page.wait_for_load_state("networkidle",
                                         timeout=NETIDLE_PRE_MS)
            except Exception:
                pass  # busy sites never go idle; the settle sleep covers us
            time.sleep(SETTLE_SECONDS)  # let late tags + banner render
        except Exception as e:
            context.close()
            result["error"] = f"Page load failed: {e.__class__.__name__}"
            return result

        result["ok"] = True
        html = page.content()

        # --- CMP detection: domains in rendered DOM + network + globals + cookies
        evidence_by_cmp = {}

        for name, matched in _match_domains(html).items():
            evidence_by_cmp.setdefault(name, []).extend(
                f"script/domain: {m}" for m in matched)

        net_corpus = "\n".join(u for _, u in requests_seen)
        for name, matched in _match_domains(net_corpus).items():
            evidence_by_cmp.setdefault(name, []).extend(
                f"network: {m}" for m in matched)

        for cmp in CMP_SIGNATURES:
            for g in cmp["js_globals"]:
                try:
                    if page.evaluate(f"typeof window['{g}'] !== 'undefined'"):
                        evidence_by_cmp.setdefault(cmp["name"], []).append(
                            f"js global: window.{g}")
                except Exception:
                    pass

        try:
            cookie_names = [c["name"] for c in context.cookies()]
        except Exception:
            cookie_names = []
        for cmp in CMP_SIGNATURES:
            hit = [cn for cn in cookie_names
                   if any(cn.startswith(pref) for pref in cmp["cookies"])]
            if hit:
                evidence_by_cmp.setdefault(cmp["name"], []).append(
                    f"cookie: {', '.join(sorted(set(hit))[:3])}")

        for name, evidence in evidence_by_cmp.items():
            sig = _cmp_by_name(name)
            result["cmps"].append({
                "name": name,
                "evidence": sorted(set(evidence)),
                "gtm_event": sig["gtm_event"],
                "notes": sig["notes"],
            })

        # --- banner visibility (only meaningful if a CMP was found)
        if result["cmps"]:
            visible = False
            for c in result["cmps"]:
                sig = _cmp_by_name(c["name"])
                for sel in sig["banner_selectors"]:
                    try:
                        el = page.query_selector(sel)
                        if el and (el.bounding_box() or
                                   sel.startswith("#usercentrics")):
                            visible = True
                    except Exception:
                        pass
            result["banner_visible"] = visible
        # else stays "unknown" - nothing to look for

        # --- GTM presence
        gtm_ids = sorted(set(GTM_ID_RE.findall(html + "\n" + net_corpus)))
        result["gtm"] = {
            "found": bool(gtm_ids) or "googletagmanager.com" in net_corpus,
            "container_ids": gtm_ids,
        }

        # --- Google Consent Mode default state
        try:
            cm = page.evaluate("""() => {
                const out = {found: false, entries: {}};
                try {
                    const dl = window.dataLayer || [];
                    for (const e of dl) {
                        if (e && e[0] === 'consent' && e[1] === 'default') {
                            out.found = true;
                            const cfg = e[2] || {};
                            for (const k of Object.keys(cfg)) out.entries[k] = cfg[k];
                        }
                    }
                } catch (err) {}
                try {
                    const ics = window.google_tag_data && window.google_tag_data.ics;
                    if (ics && ics.entries) {
                        for (const k of Object.keys(ics.entries)) {
                            const v = ics.entries[k];
                            if (v && typeof v.default !== 'undefined') {
                                out.found = true;
                                if (!(k in out.entries))
                                    out.entries[k] = v.default ? 'granted' : 'denied';
                            }
                        }
                    }
                } catch (err) {}
                return out;
            }""")
            result["consent_mode_default"] = bool(cm.get("found"))
            result["consent_defaults"] = {
                k: str(v) for k, v in (cm.get("entries") or {}).items()}
        except Exception:
            result["consent_mode_default"] = "unknown"

        # --- simulate clicking Accept, then watch what fires
        click_time = None
        if result["cmps"]:
            click_time = _try_accept(page, [c["name"] for c in result["cmps"]])
            result["accept_clicked"] = click_time is not None
        if result["accept_clicked"]:
            try:
                page.wait_for_load_state("networkidle",
                                         timeout=NETIDLE_POST_MS)
            except Exception:
                pass
            time.sleep(SETTLE_SECONDS)  # let consent-gated tags fire

        context.close()

    # --- phase split: everything before the Accept click is pre-consent;
    #     everything after is post-consent. No click => all pre-consent.
    pre_urls = [u for t, u in requests_seen
                if click_time is None or t < click_time]
    post_urls = [u for t, u in requests_seen
                 if click_time is not None and t >= click_time]

    # pre-consent tracker classification
    seen_vendors = set()
    for req_url in pre_urls:
        tracker = _classify_tracker(req_url)
        if not tracker or tracker["vendor"] in seen_vendors:
            continue
        seen_vendors.add(tracker["vendor"])

        if not result["cmps"]:
            severity, note = "ungated", ("No consent mechanism on this page, "
                                         "so this tag runs ungated. The "
                                         "finding is the missing CMP, not "
                                         "this individual tag.")
        elif tracker["google"] and _gcs_denied(req_url):
            severity, note = "info", ("Consent Mode cookieless ping in a "
                                      "denied state - expected behavior.")
        elif tracker["google"] and result["consent_mode_default"] is True:
            severity, note = "warn", ("Google request pre-consent; Consent "
                                      "Mode defaults exist - verify state in "
                                      "GTM Preview.")
        else:
            severity, note = "violation", "Fired before any consent interaction."

        result["pre_consent"].append({
            "vendor": tracker["vendor"],
            "url": req_url[:220],
            "severity": severity,
            "note": note,
        })

    result["pre_consent"].sort(
        key=lambda h: {"violation": 0, "warn": 1, "ungated": 2,
                       "info": 3}[h["severity"]])

    # trackers that fired ONLY after Accept = correctly gated + working
    post_vendors = {}
    for req_url in post_urls:
        tracker = _classify_tracker(req_url)
        if tracker and tracker["vendor"] not in post_vendors:
            post_vendors[tracker["vendor"]] = req_url
    result["post_consent"] = [
        {"vendor": v, "url": u[:220]}
        for v, u in sorted(post_vendors.items()) if v not in seen_vendors]

    # Product pixels: per selected product (or ALL products in detect-any
    # mode), which expected sub-pixels fired, pre vs post consent.
    selected = products if products else list(PRODUCT_PIXELS.keys())
    detect_any = not products
    for prod in selected:
        pixels = []
        for px in PRODUCT_PIXELS.get(prod, []):
            pre_hit = next((u for u in pre_urls
                            if any(p in u for p in px["patterns"])), None)
            post_hit = next((u for u in post_urls
                             if any(p in u for p in px["patterns"])), None)
            hit_url = (post_hit or pre_hit) or ""
            pixels.append({
                "name": px["name"],
                "fired_pre": bool(pre_hit),
                "fired_post": bool(post_hit),
                "sample_url": hit_url[:220],
                # Unreplaced trafficking macros like [ORDER] or {orderid}
                # mean the template was pasted without filling values.
                "macro_warning": bool(re.search(
                    r"(\[[A-Za-z_][A-Za-z0-9_ -]+\]|"
                    r"(?<!\$)\{[A-Za-z_][A-Za-z0-9_ -]+\})", hit_url)),
            })
        fired = sum(1 for p in pixels if p["fired_pre"] or p["fired_post"])
        if detect_any and fired == 0:
            continue  # unselected + nothing fired = not this client's product
        result["products"].append({
            "product": prod,
            "expected": len(pixels),
            "fired": fired,
            "pixels": pixels,
        })
    return result


# ------------------------------------------------------- browser pool
# Launching Chromium costs 2-3s. Dedicated worker threads each own a
# persistent Playwright instance + browser (sync API is thread-affine),
# serving scans from a queue. This both removes launch overhead and
# hard-caps concurrent browsers at BROWSER_POOL (default 2).

import os as _os
import queue as _queue
import threading as _threading


class _ScanJob:
    def __init__(self, url, products):
        self.url, self.products = url, products
        self.done = _threading.Event()
        self.result, self.error = None, None


class _BrowserWorker(_threading.Thread):
    def __init__(self, jobs):
        super().__init__(daemon=True)
        self.jobs = jobs
        self.pw = None
        self.browser = None

    def _launch(self):
        from playwright.sync_api import sync_playwright
        if self.pw is None:
            self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(
            args=["--no-sandbox", "--disable-dev-shm-usage"])

    def run(self):
        while True:
            job = self.jobs.get()
            try:
                if self.browser is None or not self.browser.is_connected():
                    self._launch()
                job.result = _full_scan_impl(self.browser, job.url,
                                             job.products)
            except Exception as first_err:
                # browser may have died - relaunch once and retry
                try:
                    try:
                        if self.browser:
                            self.browser.close()
                    except Exception:
                        pass
                    self.browser = None
                    self._launch()
                    job.result = _full_scan_impl(self.browser, job.url,
                                                 job.products)
                except Exception:
                    job.error = first_err
            finally:
                job.done.set()


class _BrowserPool:
    def __init__(self):
        self.jobs = _queue.Queue()
        self.workers = []
        self.lock = _threading.Lock()
        self.init_error = None

    def _ensure(self):
        with self.lock:
            if self.workers or self.init_error:
                return
            try:
                import playwright.sync_api  # noqa: verify availability here
            except ImportError as e:
                self.init_error = e
                return
            n = max(1, min(int(_os.environ.get("BROWSER_POOL", "2")), 4))
            for _ in range(n):
                w = _BrowserWorker(self.jobs)
                w.start()
                self.workers.append(w)

    def run(self, url, products):
        self._ensure()
        if self.init_error:
            raise ImportError(str(self.init_error))
        job = _ScanJob(url, products)
        self.jobs.put(job)
        if not job.done.wait(timeout=120):
            raise TimeoutError("Scan timed out in browser pool")
        if job.error:
            raise job.error
        return job.result


_pool = _BrowserPool()


def full_scan(url, products=None):
    return _pool.run(url, products)


# ---------------------------------------------------------------- verdict

def _apply_verdict(r):
    if not r["ok"]:
        r["verdict"], r["verdict_detail"] = "error", r["error"]
        return r

    violations = [h for h in r["pre_consent"] if h["severity"] == "violation"]

    if not r["cmps"]:
        r["verdict"] = "no_cmp"
        r["verdict_detail"] = ("No CMP detected. Do not apply the GTM consent "
                               "update - flag this client for a consent "
                               "banner conversation first.")
    elif violations:
        r["verdict"] = "misconfigured"
        names = ", ".join(sorted({v["vendor"] for v in violations}))
        r["verdict_detail"] = (f"CMP present but trackers fire pre-consent: "
                               f"{names}. Apply the GTM consent procedure.")
    elif r["mode"] == "basic":
        r["verdict"] = "cmp_found_basic"
        r["verdict_detail"] = ("CMP detected (basic scan). Run a full scan to "
                               "verify banner, Consent Mode, and pre-consent "
                               "behavior.")
    else:
        r["verdict"] = "ok"
        r["verdict_detail"] = ("CMP detected and no non-Google trackers fired "
                               "pre-consent on this page.")

    if r["cmps"]:
        ev = next((c["gtm_event"] for c in r["cmps"] if c["gtm_event"]), None)
        if ev:
            r["verdict_detail"] += f" GTM trigger event: {ev}"
    lines = [r["verdict_detail"]] if r["verdict_detail"] else []
    prods = r.get("products") or []
    if prods:
        bits = [f"{p['product']} {p['fired']}/{p['expected']}"
                if p["expected"] > 1 else p["product"] +
                (" \u2713" if p["fired"] else " \u2717")
                for p in prods]
        lines.append("Product pixels: " + ", ".join(bits) + ".")
        missing = [p["product"] for p in prods if p["fired"] == 0]
        if missing:
            lines.append("MISSING (expected but no pixels seen): "
                         + ", ".join(missing) + ".")
    r["verdict_lines"] = lines
    r["verdict_detail"] = " ".join(lines)
    return r


# ---------------------------------------------------------------- entry

def scan_site(raw_url, prefer_full=True, products=None):
    url = normalize_url(raw_url)
    if not url:
        r = _empty_result(raw_url or "")
        r["error"] = "Not a valid URL."
        return _apply_verdict(r)

    if prefer_full:
        try:
            return _apply_verdict(full_scan(url, products=products))
        except ImportError:
            pass  # Playwright not installed - fall through to basic
        except Exception as e:
            # Chromium missing/crashed etc. Fall back rather than fail.
            if "Executable doesn't exist" not in str(e) and \
               "playwright install" not in str(e).lower():
                r = _empty_result(url)
                r["error"] = f"Full scan failed: {e.__class__.__name__}"
                # still try basic below so the buyer gets *something*
    r = basic_scan(url)
    return _apply_verdict(r)
