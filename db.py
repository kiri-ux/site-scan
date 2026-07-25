"""
Postgres persistence - scan history + recurring-scan schedule.

Everything degrades gracefully: with no DATABASE_URL set, enabled() is
False and the app falls back to browser localStorage with no schedule UI.
Render Postgres: create a database, then add its Internal Database URL as
DATABASE_URL on BOTH the web service and the cron job.
"""

import json
import os

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def enabled():
    return bool(DATABASE_URL)


def _conn():
    import psycopg2
    return psycopg2.connect(DATABASE_URL)


def init_db():
    if not enabled():
        return
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS scans (
                id SERIAL PRIMARY KEY,
                url TEXT NOT NULL,
                scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                result JSONB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS scans_url_time
                ON scans (url, scanned_at DESC);
            CREATE TABLE IF NOT EXISTS schedule (
                url TEXT PRIMARY KEY,
                frequency TEXT NOT NULL DEFAULT 'daily'
                    CHECK (frequency IN ('daily', 'weekly', 'off')),
                products TEXT NOT NULL DEFAULT '',
                added_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            ALTER TABLE schedule
                ADD COLUMN IF NOT EXISTS products TEXT NOT NULL DEFAULT '';
            ALTER TABLE schedule
                ADD COLUMN IF NOT EXISTS conversion_urls TEXT
                    NOT NULL DEFAULT '';
            ALTER TABLE schedule
                ADD COLUMN IF NOT EXISTS include_conversions BOOLEAN
                    NOT NULL DEFAULT TRUE;
            ALTER TABLE schedule
                ADD COLUMN IF NOT EXISTS client_name TEXT NOT NULL DEFAULT '';
            ALTER TABLE schedule
                ADD COLUMN IF NOT EXISTS states TEXT NOT NULL DEFAULT '';
            ALTER TABLE schedule
                ADD COLUMN IF NOT EXISTS partner TEXT NOT NULL DEFAULT '';
            ALTER TABLE schedule
                ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
        """)


def save_scan(result):
    if not enabled():
        return
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("INSERT INTO scans (url, result) VALUES (%s, %s)",
                    (result.get("url", ""), json.dumps(result)))


def recent_scans(limit=200):
    if not enabled():
        return []
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("""
            SELECT id, result, to_char(scanned_at AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            FROM scans ORDER BY scanned_at DESC LIMIT %s""", (limit,))
        out = []
        for sid, result, iso in cur.fetchall():
            r = result if isinstance(result, dict) else json.loads(result)
            r["_id"] = sid
            r["scanned_at_iso"] = iso
            out.append(r)
        return out


def delete_all_scans():
    if not enabled():
        return
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("DELETE FROM scans")


def scans_for_run(run_id):
    if not enabled():
        return []
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("""
            SELECT id, result, to_char(scanned_at AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            FROM scans WHERE result->>'run_id' = %s
            ORDER BY scanned_at ASC""", (run_id,))
        out = []
        for sid, result, iso in cur.fetchall():
            r = result if isinstance(result, dict) else json.loads(result)
            r["_id"] = sid
            r["scanned_at_iso"] = iso
            out.append(r)
        return out


def delete_scans(ids):
    ids = [int(i) for i in ids]
    if not ids:
        return
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("DELETE FROM scans WHERE id = ANY(%s)", (ids,))


def list_sites():
    if not enabled():
        return []
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("""SELECT url, frequency, products, conversion_urls,
                              include_conversions, client_name, states,
                              partner, category
                       FROM schedule ORDER BY client_name, url""")
        return [{"url": u, "frequency": f,
                 "products": [p for p in (pr or "").split(",") if p],
                 "conversion_urls": [c for c in (cv or "").splitlines() if c.strip()],
                 "include_conversions": bool(inc),
                 "client_name": name or "",
                 "states": [s for s in (st or "").split(",") if s],
                 "partner_name": pt or "",
                 "category": cat or ""}
                for u, f, pr, cv, inc, name, st, pt, cat in cur.fetchall()]


def upsert_site(url, frequency, products="", conversion_urls="",
                include_conversions=True, client_name="", states="",
                partner="", category=""):
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("""
            INSERT INTO schedule (url, frequency, products,
                                  conversion_urls, include_conversions,
                                  client_name, states, partner, category)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (url) DO UPDATE
                SET frequency = EXCLUDED.frequency,
                    products = EXCLUDED.products,
                    conversion_urls = EXCLUDED.conversion_urls,
                    include_conversions = EXCLUDED.include_conversions,
                    client_name = EXCLUDED.client_name,
                    states = EXCLUDED.states,
                    partner = EXCLUDED.partner,
                    category = EXCLUDED.category
        """, (url, frequency, products, conversion_urls,
              bool(include_conversions), client_name[:200], states,
              partner[:200], category[:60]))


def delete_site(url):
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("DELETE FROM schedule WHERE url = %s", (url,))
