"""
Consent Scanner - Flask app.

Stateless by design: the UI drives batches by calling POST /scan once per
URL, so the server needs no job queue or session storage, and progress
renders naturally in the browser. CSV export is built client-side.
"""

import os

from flask import Flask, jsonify, render_template, request

from scanner import scan_site

app = Flask(__name__)

BUILD = open(os.path.join(os.path.dirname(__file__), "VERSION")).read().strip() \
    if os.path.exists(os.path.join(os.path.dirname(__file__), "VERSION")) else "dev"


@app.get("/")
def index():
    return render_template("index.html", build=BUILD)


@app.post("/scan")
def scan():
    data = request.get_json(silent=True) or {}
    url = data.get("url", "")
    prefer_full = bool(data.get("full", True))
    result = scan_site(url, prefer_full=prefer_full)
    return jsonify(result)


@app.get("/health")
def health():
    return {"status": "ok", "build": BUILD}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
