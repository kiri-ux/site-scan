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
            SELECT result, to_char(scanned_at AT TIME ZONE 'UTC',
                                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            FROM scans ORDER BY scanned_at DESC LIMIT %s""", (limit,))
        out = []
        for result, iso in cur.fetchall():
            r = result if isinstance(result, dict) else json.loads(result)
            r["scanned_at_iso"] = iso
            out.append(r)
        return out


def list_sites():
    if not enabled():
        return []
    with _conn() as cn, cn.cursor() as cur:
        cur.execute(
            "SELECT url, frequency, products FROM schedule ORDER BY url")
        return [{"url": u, "frequency": f,
                 "products": [p for p in (pr or "").split(",") if p]}
                for u, f, pr in cur.fetchall()]


def upsert_site(url, frequency, products=""):
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("""
            INSERT INTO schedule (url, frequency, products)
            VALUES (%s, %s, %s)
            ON CONFLICT (url) DO UPDATE
                SET frequency = EXCLUDED.frequency,
                    products = EXCLUDED.products
        """, (url, frequency, products))


def delete_site(url):
    with _conn() as cn, cn.cursor() as cur:
        cur.execute("DELETE FROM schedule WHERE url = %s", (url,))
