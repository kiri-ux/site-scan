"""
Consent Scanner - Flask app.

Stateless scan endpoint; optional Postgres (DATABASE_URL) adds shared
scan history and the recurring-scan schedule endpoints.
"""

import os
from datetime import datetime
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, render_template, request

import db
from scanner import scan_site, normalize_url
from signatures import PRODUCT_NAMES

app = Flask(__name__)

BUILD = open(os.path.join(os.path.dirname(__file__), "VERSION")).read().strip() \
    if os.path.exists(os.path.join(os.path.dirname(__file__), "VERSION")) else "dev"
DEPLOYED = datetime.now(ZoneInfo("America/New_York")).strftime(
    "%Y-%m-%d %I:%M %p ET")

try:
    db.init_db()
except Exception as e:  # DB down shouldn't kill the app - fall back to local
    print(f"DB init failed, running without persistence: {e}")


@app.get("/")
def index():
    return render_template("index.html", build=BUILD, deployed=DEPLOYED)


@app.post("/scan")
def scan():
    data = request.get_json(silent=True) or {}
    products = [p for p in (data.get("products") or [])
                if p in PRODUCT_NAMES]
    result = scan_site(data.get("url", ""),
                       prefer_full=bool(data.get("full", True)),
                       products=products or None)
    result["client_name"] = str(data.get("client_name", ""))[:200]
    result["run_id"] = str(data.get("run_id", ""))[:64]
    if result["ok"]:
        try:
            db.save_scan(result)
        except Exception as e:
            print(f"save_scan failed: {e}")
    return jsonify(result)


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
    conversion_urls = "\n".join(c.strip() for c in conv if c.strip())[:8000]
    include_conversions = bool(data.get("include_conversions", True))
    client_name = str(data.get("client_name", ""))
    try:
        db.upsert_site(url, freq, products, conversion_urls,
                       include_conversions, client_name)
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


@app.get("/health")
def health():
    return {"status": "ok", "build": BUILD, "db": db.enabled()}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
