"""
Consent Scanner - Flask app.

Stateless scan endpoint; optional Postgres (DATABASE_URL) adds shared
scan history and the recurring-scan schedule endpoints.
"""

import os
from datetime import datetime
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, render_template, request, session

import hashlib
import hmac
import re
from datetime import timedelta

import db
import gtm_api
from scanner import scan_site, normalize_url


_CONV_URL_RE = re.compile(
    r"(https?://[^\s,]+"
    r"|(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z]{2,})+(?:/[^\s,]*)?)",
    re.I)


def _extract_conv_urls(chunk):
    """Harvest every URL-looking token from a line; drop annotations."""
    out = []
    for m in _CONV_URL_RE.finditer(chunk):
        u = re.sub(r"[)\"'\]>,;.:]+$", "", m.group(0))
        host = re.sub(r"^https?://", "", u, flags=re.I).split("/")[0]
        if "." in host:
            out.append(u)
    return out
from signatures import PRODUCT_NAMES
from state_checks import STATE_CODES, STATE_CHECKS, LAST_REVIEWED
from industries import INDUSTRIES, derive_contexts, SENSITIVE_RULES

app = Flask(__name__)

# ---- password gate (set SCANNER_PASSWORD in the environment to enable).
# Share pages, their API, static assets, and health stay open: share
# links are for clients, and the sensitive Build-vs-market tab lives
# only on the main app.
SCANNER_PASSWORD = os.environ.get("SCANNER_PASSWORD", "")
app.secret_key = (os.environ.get("SECRET_KEY")
                  or hashlib.sha256(
                      ("consent-scanner:" + SCANNER_PASSWORD).encode()
                  ).hexdigest())
app.permanent_session_lifetime = timedelta(days=30)

_OPEN_PREFIXES = ("/run/", "/api/run/", "/static/", "/gtm/audit/")
_OPEN_PATHS = {"/health", "/favicon.ico", "/login"}


@app.before_request
def _gate():
    if not SCANNER_PASSWORD:
        return None
    p = request.path
    if p in _OPEN_PATHS or any(p.startswith(x) for x in _OPEN_PREFIXES):
        return None
    if session.get("authed"):
        return None
    return app.redirect("/login", code=302)


@app.get("/login")
def login_form():
    if not SCANNER_PASSWORD or session.get("authed"):
        return app.redirect("/", code=302)
    return render_template("login.html", error=None)


@app.post("/login")
def login_submit():
    supplied = str(request.form.get("password", ""))
    if SCANNER_PASSWORD and hmac.compare_digest(supplied, SCANNER_PASSWORD):
        session.permanent = True
        session["authed"] = True
        return app.redirect("/", code=302)
    return render_template("login.html",
                           error="That password isn't right - try again."), 401


@app.get("/logout")
def logout():
    session.clear()
    return app.redirect("/login", code=302)

BUILD = open(os.path.join(os.path.dirname(__file__), "VERSION")).read().strip() \
    if os.path.exists(os.path.join(os.path.dirname(__file__), "VERSION")) else "dev"
try:
    DEPLOYED = datetime.now(ZoneInfo("America/New_York")).strftime(
        "%Y-%m-%d %I:%M %p ET")
except Exception:  # tz database unavailable - never let this kill boot
    DEPLOYED = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

try:
    db.init_db()
except Exception as e:  # DB down shouldn't kill the app - fall back to local
    print(f"DB init failed, running without persistence: {e}")


@app.get("/")
def index():
    import json as _json
    return render_template("index.html", build=BUILD, deployed=DEPLOYED,
                           states_json=_json.dumps(STATE_CHECKS),
                           industries_json=_json.dumps(INDUSTRIES),
                           industry_rules_json=_json.dumps(SENSITIVE_RULES),
                           states_reviewed=LAST_REVIEWED)


@app.post("/scan")
def scan():
    data = request.get_json(silent=True) or {}
    products = [p for p in (data.get("products") or [])
                if p in PRODUCT_NAMES]
    states = [s for s in (data.get("states") or []) if s in STATE_CODES]
    category = str(data.get("category", ""))[:60] or None
    industries = [i for i in (data.get("industries") or [])
                  if i in set(INDUSTRIES)][:12]
    result = scan_site(data.get("url", ""),
                       prefer_full=bool(data.get("full", True)),
                       products=products or None,
                       states=states or None,
                       site_checks=bool(data.get("site_checks", True)),
                       category=category, industries=industries)
    result["client_name"] = str(data.get("client_name", ""))[:200]
    result["partner_name"] = str(data.get("partner_name", ""))[:200]
    result["category"] = str(data.get("category", ""))[:60]
    result["implementation"] = str(data.get("implementation", ""))[:40]
    result["industries"] = [i for i in (data.get("industries") or [])
                            if i in set(INDUSTRIES)][:12]
    result["run_id"] = str(data.get("run_id", ""))[:64]
    if result["ok"]:
        try:
            db.save_scan(result)
        except Exception as e:
            print(f"save_scan failed: {e}")
        try:
            # Queue container audits in the background. Never inline:
            # the API quota would put a scan behind every other scan.
            ids = list((result.get("gtm") or {}).get("container_ids") or [])
            gtm_api.refresh_async(ids, db.get_audit, db.save_audit)
        except Exception as e:
            print(f"gtm refresh failed: {e}")

    # A blocked or failed scan never sees the container ID, so fall back
    # to matching the domain against container names. Nothing else about
    # the site is readable - the configuration still is.
    if not result.get("ok") or result.get("inconclusive"):
        try:
            pid = gtm_api.find_by_domain(result.get("url", ""))
            if pid:
                result["gtm_by_domain"] = pid
                gtm_api.refresh_async([pid], db.get_audit, db.save_audit)
        except Exception as e:
            print(f"gtm domain lookup failed: {e}")
    return jsonify(result)


@app.get("/gtm/audit/<public_id>")
def gtm_audit(public_id):
    """Cached container configuration. Returns null rather than an
    error when there is nothing cached - no audit is the normal case
    for a client-owned container, and the report falls back to
    fingerprint attribution there."""
    try:
        return jsonify({"audit": db.get_audit(public_id)})
    except Exception as e:
        print(f"gtm_audit failed: {e}")
        return jsonify({"audit": None})


@app.get("/gtm/coverage")
def gtm_coverage():
    try:
        cov = db.audit_coverage()
        cov["api_configured"] = gtm_api.enabled()
        return jsonify(cov)
    except Exception as e:
        print(f"gtm_coverage failed: {e}")
        return jsonify({"enabled": False, "api_configured": False})


@app.get("/history")
def history():
    try:
        return jsonify({"enabled": db.enabled(),
                        "results": db.recent_scans(200)})
    except Exception as e:
        print(f"history failed: {e}")
        return jsonify({"enabled": False, "results": []})


@app.get("/sites")
def sites():
    try:
        return jsonify({"enabled": db.enabled(), "sites": db.list_sites()})
    except Exception as e:
        print(f"list_sites failed: {e}")
        return jsonify({"enabled": False, "sites": []})


@app.post("/sites")
def upsert_site():
    data = request.get_json(silent=True) or {}
    url = normalize_url(data.get("url", ""))
    freq = data.get("frequency", "daily")
    if not url:
        return jsonify({"ok": False, "error": "Not a valid URL."}), 400
    if freq not in ("daily", "weekly", "off"):
        return jsonify({"ok": False, "error": "Bad frequency."}), 400
    products = ",".join(p for p in (data.get("products") or [])
                        if p in PRODUCT_NAMES)
    conv = data.get("conversion_urls") or []
    if isinstance(conv, str):
        conv = conv.splitlines()
    conversion_urls = "\n".join(
        u for x in conv for u in _extract_conv_urls(str(x)))[:8000]
    include_conversions = bool(data.get("include_conversions", True))
    client_name = str(data.get("client_name", ""))
    states = ",".join(s for s in (data.get("states") or [])
                      if s in STATE_CODES)
    try:
        db.upsert_site(url, freq, products, conversion_urls,
                       include_conversions, client_name, states,
                       str(data.get("partner_name", ""))[:200],
                       str(data.get("category", ""))[:60],
                       _json_dumps_industries(data),
                       str(data.get("implementation", ""))[:40])
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/scans/delete")
def delete_scans():
    data = request.get_json(silent=True) or {}
    try:
        db.delete_scans(data.get("ids") or [])
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/sites/delete")
def remove_site():
    data = request.get_json(silent=True) or {}
    try:
        db.delete_site(data.get("url", ""))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/scans/delete_all")
def delete_all():
    try:
        db.delete_all_scans()
        return jsonify({"ok": True})
    except Exception as e:
        print(f"delete_all failed: {e}")
        return jsonify({"ok": False}), 500


@app.get("/run/<run_id>")
def share_run(run_id):
    return render_template("share.html", run_id=run_id)


@app.get("/api/run/<run_id>")
def api_run(run_id):
    # Returns the whole client's scan history so the share page can
    # offer the same run pills as the dashboard. run_id comes back so
    # the page knows which run the link was actually created for and
    # can select it rather than defaulting to the newest.
    try:
        return jsonify({"results": db.scans_for_run_client(run_id),
                        "run_id": run_id})
    except Exception as e:
        print(f"api_run client history failed: {e}")
    try:  # never let a share link 404 - fall back to the single run
        return jsonify({"results": db.scans_for_run(run_id),
                        "run_id": run_id})
    except Exception as e:
        print(f"api_run failed: {e}")
        return jsonify({"results": [], "run_id": run_id})


@app.get("/favicon.ico")
def favicon_ico():
    # Some browsers request /favicon.ico regardless of the link tag.
    return app.redirect("/static/favicon.svg?v=2", code=302)


def _json_dumps_industries(data):
    import json as _j
    inds = [i for i in (data.get("industries") or [])
            if i in set(INDUSTRIES)][:12]
    return _j.dumps(inds)


@app.get("/health")
def health():
    return {"status": "ok", "build": BUILD, "db": db.enabled()}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
