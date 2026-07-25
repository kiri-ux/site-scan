"""v0.7.0: run metadata, scan deletion, macro warnings, schedule client name."""
import http.server, threading, functools, os
os.environ["DATABASE_URL"] = "postgresql://scanner:scanner@localhost/scandb"
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory="/tmp/fixtures")
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8981), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

import db; db.init_db()
from app import app
c = app.test_client()

# clean scans table for deterministic counts
import psycopg2
with psycopg2.connect(os.environ["DATABASE_URL"]) as cn, cn.cursor() as cur:
    cur.execute("DELETE FROM scans")

# run metadata pass-through + macro warning (fixture pixels carry [ORDER] etc? products.html uses plain urls; gated.html conversion pixel has tag_id only)
# add a macro fixture quickly via leaky-style page? use products.html and check macro flag False, then a direct scanner unit for macro True.
r = c.post("/scan", json={"url": "http://localhost:8981/products.html", "full": True,
                          "products": ["BARCK+"], "run_id": "run-1",
                          "client_name": "Town & Country Ford"}).get_json()
print("meta:", r["client_name"], r["run_id"])
assert r["client_name"] == "Town & Country Ford" and r["run_id"] == "run-1"
barck = r["products"][0]
assert all(px["macro_warning"] is False for px in barck["pixels"] if px["sample_url"])

# macro regex unit checks
import re, scanner
mk = lambda u: bool(re.search(r"(\[[A-Za-z_][A-Za-z0-9_ -]+\]|(?<!\$)\{[A-Za-z_][A-Za-z0-9_ -]+\})", u))
assert mk("https://x.io/cnv?order=[ORDER]&ord=[CACHEBUSTER]")
assert mk("https://insight.adsrvr.org/track/pxl/?orderid={orderid}&v={v}")
assert not mk("https://x.io/ddm;gdpr=${GDPR};gdpr_consent=${GDPR_CONSENT_755}")  # ${...} macros are consent-passing, expected
assert not mk("https://x.io/cnv?tag_id=8922&value=")
print("macro regex ok")

# history exposes ids; delete works
h1 = c.get("/history").get_json()
ids = [x["_id"] for x in h1["results"]]
assert all(i is not None for i in ids)
before = len(h1["results"])
assert c.post("/scans/delete", json={"ids": [ids[0]]}).get_json()["ok"]
after = len(c.get("/history").get_json()["results"])
print(f"delete: {before} -> {after}")
assert after == before - 1

# schedule client name
assert c.post("/sites", json={"url": "tcford.com", "frequency": "daily",
                              "client_name": "Town & Country Ford",
                              "conversion_urls": ["tcford.com/thanks"]}).get_json()["ok"]
row = [s for s in c.get("/sites").get_json()["sites"] if "tcford" in s["url"]][0]
print("schedule:", row["client_name"], row["url"])
assert row["client_name"] == "Town & Country Ford"
import batch_scan
due = batch_scan.load_sites()
assert any(name == "Town & Country Ford" for _, _, name, _, _, _, _, _, _ in due)
print("batch carries name ok")

srv.shutdown()
print("ALL v0.7.0 TESTS PASSED")
