"""Dev test harness - endpoints via Flask test client, fixture server in-thread."""
import http.server
import json
import threading
import functools

FIXDIR = "/tmp/fixtures"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=FIXDIR)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8941), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

from app import app  # noqa: E402

c = app.test_client()

r = c.get("/health")
print("health:", r.get_json())

r = c.get("/")
assert b"Consent Scanner" in r.data and b"consent chain" in r.data.lower()
print("index: renders ok,", len(r.data), "bytes")

r = c.post("/scan", json={"url": "http://localhost:8941/onetrust.html", "full": True})
d = r.get_json()
print("scan full:", d["verdict"], d["mode"], [x["name"] for x in d["cmps"]],
      "gtm:", d["gtm"]["container_ids"])

r = c.post("/scan", json={"url": "http://localhost:8941/cookiebot.html", "full": False})
d = r.get_json()
print("scan basic:", d["verdict"], d["mode"], [x["name"] for x in d["cmps"]])

r = c.post("/scan", json={"url": "???"})
d = r.get_json()
print("bad url:", d["verdict"], "-", d["error"])

r = c.post("/scan", json={"url": "http://localhost:8941/nocmp.html", "full": True})
d = r.get_json()
viol = [h["vendor"] for h in d["pre_consent"] if h["severity"] == "violation"]
ung = [h["vendor"] for h in d["pre_consent"] if h["severity"] == "ungated"]
print("nocmp:", d["verdict"], "violations:", viol, "ungated:", ung)
assert not viol and "Meta Pixel" in ung

srv.shutdown()
print("ALL ENDPOINT TESTS PASSED")
