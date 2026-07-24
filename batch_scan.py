"""
Scheduled batch scan - designed to run as a Render Cron Job.

Site list comes from (first match wins):
  1. SITES env var - comma- or newline-separated URLs
  2. sites.txt in the repo root - one URL per line, # comments allowed

Output:
  - CSV written to stdout (captured in Render cron logs) and /tmp/scan.csv
  - If SES env vars are set, the CSV is emailed as an attachment:
        SES_FROM, SES_TO (comma-separated), AWS_REGION (default us-east-1)
        plus AWS credentials via the usual AWS_ACCESS_KEY_ID /
        AWS_SECRET_ACCESS_KEY env vars
  - ALERT_ONLY=1 -> only send the email when at least one site has a
    pre-consent violation or a no-CMP verdict (daily silence = all good)

Render Cron Job setup (same repo, same Dockerfile):
  - New > Cron Job, runtime Docker
  - Docker command:  python batch_scan.py
  - Schedule (daily 7am ET during EDT): 0 11 * * *
  - Instance: Standard (Chromium memory)
"""

import csv
import io
import os
import sys
from datetime import datetime, timezone

import db
from scanner import scan_site


def load_sites():
    # Prefer the UI-managed schedule when a database is connected.
    if db.enabled():
        try:
            monday = datetime.now(timezone.utc).weekday() == 0
            due = [s["url"] for s in db.list_sites()
                   if s["frequency"] == "daily"
                   or (s["frequency"] == "weekly" and monday)]
            if due:
                return due
            print("Schedule table has no sites due today.")
        except Exception as e:
            print(f"Could not read schedule from DB ({e}); "
                  f"falling back to SITES/sites.txt.")
    raw = os.environ.get("SITES", "").strip()
    if not raw and os.path.exists("sites.txt"):
        raw = open("sites.txt").read()
    sites = []
    for chunk in raw.replace(",", "\n").splitlines():
        s = chunk.strip()
        if s and not s.startswith("#"):
            sites.append(s)
    return sites


def to_rows(results):
    head = ["url", "verdict", "cmp", "banner_visible", "consent_mode_default",
            "pre_consent_violations", "dsp_pixels_fired",
            "dsp_fired_pre_consent_only", "accept_clicked", "detail",
            "scanned_at"]
    rows = [head]
    for r in results:
        rows.append([
            r["url"], r["verdict"],
            "; ".join(c["name"] for c in r["cmps"]),
            str(r["banner_visible"]), str(r["consent_mode_default"]),
            "; ".join(h["vendor"] for h in r["pre_consent"]
                      if h["severity"] == "violation"),
            "; ".join(d["vendor"] for d in r.get("dsp_pixels", [])),
            "; ".join(d["vendor"] for d in r.get("dsp_pixels", [])
                      if d["fired_pre"] and not d["fired_post"]),
            str(r.get("accept_clicked", False)),
            r["verdict_detail"] or r["error"] or "",
            r["scanned_at"],
        ])
    return rows


def needs_alert(results):
    for r in results:
        if r["verdict"] in ("no_cmp", "misconfigured", "error"):
            return True
        if any(d["fired_pre"] and not d["fired_post"]
               for d in r.get("dsp_pixels", [])):
            return True
    return False


def send_email(csv_text, results):
    import boto3  # only needed when SES is configured
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.mime.application import MIMEApplication

    flagged = [r for r in results
               if r["verdict"] in ("no_cmp", "misconfigured", "error")]
    subject = (f"Consent Scan: {len(flagged)} of {len(results)} sites flagged"
               if flagged else
               f"Consent Scan: all {len(results)} sites clean")

    body_lines = []
    for r in results:
        body_lines.append(f"[{r['verdict']}] {r['url']}")
        if r["verdict_detail"]:
            body_lines.append(f"    {r['verdict_detail']}")
    body = "\n".join(body_lines)

    msg = MIMEMultipart()
    msg["Subject"] = subject
    msg["From"] = os.environ["SES_FROM"]
    msg["To"] = os.environ["SES_TO"]
    msg.attach(MIMEText(body, "plain"))
    att = MIMEApplication(csv_text.encode(), _subtype="csv")
    att.add_header("Content-Disposition", "attachment",
                   filename="consent-scan.csv")
    msg.attach(att)

    ses = boto3.client("ses",
                       region_name=os.environ.get("AWS_REGION", "us-east-1"))
    ses.send_raw_email(
        Source=os.environ["SES_FROM"],
        Destinations=[a.strip() for a in os.environ["SES_TO"].split(",")],
        RawMessage={"Data": msg.as_string()})
    print(f"Emailed report to {os.environ['SES_TO']}: {subject}")


def main():
    sites = load_sites()
    if not sites:
        print("No sites configured. Set SITES env var or add sites.txt.")
        sys.exit(1)

    print(f"Scanning {len(sites)} sites...")
    results = []
    for s in sites:
        r = scan_site(s, prefer_full=True)
        results.append(r)
        if r["ok"]:
            try:
                db.save_scan(r)
            except Exception as e:
                print(f"  (could not save to history: {e})")
        print(f"  [{r['verdict']}] {r['url']}")

    buf = io.StringIO()
    csv.writer(buf).writerows(to_rows(results))
    csv_text = buf.getvalue()
    with open("/tmp/scan.csv", "w") as f:
        f.write(csv_text)
    print("\n" + csv_text)

    if os.environ.get("SES_FROM") and os.environ.get("SES_TO"):
        if os.environ.get("ALERT_ONLY") == "1" and not needs_alert(results):
            print("ALERT_ONLY set and nothing flagged - no email sent.")
        else:
            send_email(csv_text, results)

    sys.exit(0)


if __name__ == "__main__":
    main()
