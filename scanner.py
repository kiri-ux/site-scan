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

from signatures import CMP_SIGNATURES, TRACKER_ENDPOINTS

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

GTM_ID_RE = re.compile(r"GTM-[A-Z0-9]{4,}")
REQUEST_TIMEOUT = 15
PAGE_TIMEOUT_MS = 30000
SETTLE_SECONDS = 3.0


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

def full_scan(url):
    from playwright.sync_api import sync_playwright  # noqa: deferred import

    result = _empty_result(url)
    result["mode"] = "full"
    requests_seen = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(user_agent=UA, locale="en-US",
                                      viewport={"width": 1366, "height": 900})
        page = context.new_page()
        page.on("request", lambda req: requests_seen.append(req.url))

        try:
            page.goto(url, wait_until="domcontentloaded",
                      timeout=PAGE_TIMEOUT_MS)
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass  # busy sites never go idle; the settle sleep covers us
            time.sleep(SETTLE_SECONDS)  # let late tags + banner render
        except Exception as e:
            browser.close()
            result["error"] = f"Page load failed: {e.__class__.__name__}"
            return result

        result["ok"] = True
        html = page.content()

        # --- CMP detection: domains in rendered DOM + network + globals + cookies
        evidence_by_cmp = {}

        for name, matched in _match_domains(html).items():
            evidence_by_cmp.setdefault(name, []).extend(
                f"script/domain: {m}" for m in matched)

        net_corpus = "\n".join(requests_seen)
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

        browser.close()

    # --- pre-consent tracker classification (no banner interaction happened,
    #     so every hit below fired before any consent was given)
    seen_vendors = set()
    for req_url in requests_seen:
        tracker = _classify_tracker(req_url)
        if not tracker:
            continue
        key = (tracker["vendor"],)
        if key in seen_vendors:
            continue
        seen_vendors.add(key)

        if tracker["google"] and _gcs_denied(req_url):
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
        key=lambda h: {"violation": 0, "warn": 1, "info": 2}[h["severity"]])
    return result


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
    return r


# ---------------------------------------------------------------- entry

def scan_site(raw_url, prefer_full=True):
    url = normalize_url(raw_url)
    if not url:
        r = _empty_result(raw_url or "")
        r["error"] = "Not a valid URL."
        return _apply_verdict(r)

    if prefer_full:
        try:
            return _apply_verdict(full_scan(url))
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
