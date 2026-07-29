"""
Google Tag Manager API - read side.

Access model: OAuth as Vici's own Google logins, NOT a service account.

A service account has to be invited to every GTM account individually.
With hundreds of partner-named accounts and new ones appearing regularly,
that is a permanent chore with a guaranteed failure mode - the invite
nobody remembers to do. An OAuth token issued for a Vici login inherits
exactly the access that login already has, including accounts created
tomorrow, with no per-account setup at all.

Google caps how many GTM accounts one login can join, which is why
Vici's are spread across several logins. Each is authorized separately
and gets its own refresh token; the index below merges what they can
collectively see and records which login reaches which container -
needed now for reads, and needed later to pick an identity for a write.

The OAuth consent screen is Internal on the Workspace org, so none of
this needs Google app verification.

Environment:
  GTM_OAUTH_CLIENT  OAuth client JSON (the whole file, or a path to it)
  GTM_TOKENS        JSON: {"label": "refresh_token", ...}

Run `python gtm_api.py authorize <label>` once per login to mint each
refresh token.
"""

import json
import os
import threading
import time

SCOPES = ["https://www.googleapis.com/auth/tagmanager.readonly"]

# 0.25 QPS is per PROJECT, not per user - extra logins buy no extra
# throughput, so pacing stays global across every identity.
MIN_CALL_INTERVAL = 4.2
INDEX_TTL = 3600

_lock = threading.Lock()
_build_lock = threading.Lock()
_last_call = 0.0
_index = None
_index_built = 0.0
_index_errors = {}
_services = {}


def enabled():
    return bool(os.environ.get("GTM_TOKENS")
                and os.environ.get("GTM_OAUTH_CLIENT"))


def _load(var):
    raw = os.environ.get(var, "")
    return json.loads(raw) if raw.strip().startswith("{") else json.load(open(raw))


def _client_config():
    cfg = _load("GTM_OAUTH_CLIENT")
    return cfg.get("installed") or cfg.get("web") or cfg


def _tokens():
    return _load("GTM_TOKENS")


def _service(label):
    if label in _services:
        return _services[label]
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    cfg = _client_config()
    creds = Credentials(
        token=None,
        refresh_token=_tokens()[label],
        client_id=cfg["client_id"],
        client_secret=cfg["client_secret"],
        token_uri=cfg.get("token_uri", "https://oauth2.googleapis.com/token"),
        scopes=SCOPES)
    _services[label] = build("tagmanager", "v2", credentials=creds,
                             cache_discovery=False)
    return _services[label]


def _throttle():
    global _last_call
    with _lock:
        wait = MIN_CALL_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()


def _call(request):
    """One paced call. Retries once if the quota window pushes back."""
    from googleapiclient.errors import HttpError
    for attempt in range(2):
        _throttle()
        try:
            return request.execute()
        except HttpError as e:
            if getattr(e, "resp", None) and e.resp.status in (403, 429) \
                    and attempt == 0:
                time.sleep(30)
                continue
            raise


def build_index(force=False):
    """publicId -> container, merged across every authorized login.

    Logins overlap: the same GTM account is often visible to more than
    one. First wins; the others are recorded so a later write can fall
    back if one login loses access.
    """
    global _index, _index_built
    if _index is not None and not force and time.time() - _index_built < INDEX_TTL:
        return _index
    # One builder at a time. Every call costs one paced request per
    # account, so two concurrent builds double the wall time for both.
    with _build_lock:
        if _index is not None and not force \
                and time.time() - _index_built < INDEX_TTL:
            return _index
        return _build_index_locked()


def _build_index_locked():
    global _index, _index_built
    idx, errors = {}, {}
    for label in _tokens():
        try:
            svc = _service(label)
            for acct in _call(svc.accounts().list()).get("account", []):
                for c in _call(svc.accounts().containers().list(
                        parent=acct["path"])).get("container", []):
                    pid = (c.get("publicId") or "").upper()
                    if not pid:
                        continue
                    if pid in idx:
                        idx[pid]["also_visible_to"].append(label)
                        continue
                    idx[pid] = {
                        "identity": label,
                        "also_visible_to": [],
                        "account_id": acct.get("accountId"),
                        "account_name": acct.get("name", ""),
                        "container_id": c.get("containerId"),
                        "container_name": c.get("name", ""),
                        "path": c.get("path"),
                    }
        except Exception as e:
            # one broken login must not blank the whole index
            errors[label] = f"{e.__class__.__name__}: {e}"
    _index, _index_built = idx, time.time()
    _index_errors.clear()
    _index_errors.update(errors)
    return idx


# Tag types that name their vendor outright. Everything else - above
# all Custom HTML, which is common and can contain anything - has to be
# identified from the tag's own content.
TYPE_VENDORS = {
    "gaawc": "Google Analytics 4", "gaawe": "Google Analytics 4",
    "ua": "Google Analytics", "googtag": "Google tag",
    "sp": "Google Ads", "awct": "Google Ads", "gclidw": "Google Ads",
    "flc": "Floodlight", "fls": "Floodlight",
}


def _tag_content(tag):
    """Every string value the tag carries - the HTML of a Custom HTML
    tag, the URL of an image tag, template fields. This is what makes a
    Custom HTML tag identifiable: the pixel code is right there."""
    out = []

    def walk(params):
        for p in params or []:
            v = p.get("value")
            if isinstance(v, str):
                out.append(v)
            walk(p.get("list"))
            walk(p.get("map"))

    walk(tag.get("parameter"))
    return "\n".join(out)


def _identify(tag, content):
    """Vendor for a tag: by type where the type says so, otherwise by
    fingerprinting its content with the scanner's own signature lists.
    Same matching used against page source - deliberately not a second
    implementation."""
    t = (tag.get("type") or "").lower()
    if t in TYPE_VENDORS:
        return TYPE_VENDORS[t], "type"
    low = content.lower()
    if not low:
        return None, None
    try:
        from signatures import TRACKER_ENDPOINTS, CODE_HINTS, PRODUCT_PIXELS
    except Exception:
        return None, None
    for entry in TRACKER_ENDPOINTS:
        if any(p.lower() in low for p in entry.get("patterns") or []):
            return entry["vendor"], "content"
    for prod in PRODUCT_PIXELS.values():
        for px in prod:
            if any(p.lower() in low for p in px.get("patterns") or []):
                return px["name"], "content"
    for vendor, hints in CODE_HINTS.items():
        if any(h.lower() in low for h in hints):
            return vendor, "content"
    return None, None


def _trigger_filters(trig):
    """A trigger's conditions, flattened. GTM expresses a condition as an
    operator plus arg0 (the variable) and arg1 (the value); negation
    rides along as a parameter rather than a separate operator."""
    out = []
    for group in ("filter", "autoEventFilter", "customEventFilter"):
        for f in (trig.get(group) or []):
            params = {p.get("key"): p.get("value")
                      for p in (f.get("parameter") or [])}
            out.append({
                "op": f.get("type", ""),
                "var": params.get("arg0", ""),
                "value": params.get("arg1", ""),
                "negate": str(params.get("negate", "")).lower() == "true"
                          or bool(f.get("negate")),
            })
    return out


def _summarize(version):
    """The parts of a live container version worth reporting."""
    triggers = {t.get("triggerId"): t.get("name", "")
                for t in version.get("trigger", [])}
    # Full definitions, not just names: the type says whether a tag can
    # fire on a page load at all, and the filters say on which pages.
    trig_detail = {t.get("triggerId"): {
        "name": t.get("name", ""),
        "type": (t.get("type") or "").upper(),
        "filters": _trigger_filters(t),
    } for t in version.get("trigger", [])}
    tags = []
    for t in version.get("tag", []):
        consent = t.get("consentSettings") or {}
        content = _tag_content(t)
        vendor, how = _identify(t, content)
        tags.append({
            "name": t.get("name", ""),
            "type": t.get("type", ""),
            "vendor": vendor,
            "vendor_from": how,
            "paused": bool(t.get("paused")),
            # NEEDED = this tag waits for consent. NOT_SET = it does not.
            "consent_status": consent.get("consentStatus", "NOT_SET"),
            "consent_types": [p.get("value") for p in
                              (consent.get("consentType", {}) or {}).get("list", [])
                              if p.get("value")],
            "firing_triggers": [triggers.get(i, i)
                                for i in (t.get("firingTriggerId") or [])],
            "trigger_detail": [trig_detail[i] for i in
                               (t.get("firingTriggerId") or []) if i in trig_detail],
            "blocking_triggers": [triggers.get(i, i)
                                  for i in (t.get("blockingTriggerId") or [])],
        })
    return {
        "version_id": version.get("containerVersionId"),
        "version_name": version.get("name", ""),
        "tags": tags,
        "trigger_count": len(version.get("trigger", [])),
        "variable_count": len(version.get("variable", [])),
    }


def _host_tokens(text):
    """Domain-ish tokens in a string, minus the noise words that appear
    in every container name."""
    import re as _re
    out = set()
    for m in _re.finditer(r"([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)", (text or "").lower()):
        h = m.group(1)
        if h.startswith("www."):
            h = h[4:]
        if "." in h and not h.endswith((".js", ".html", ".php")):
            out.add(h)
    return out


def find_by_domain(url):
    """Resolve a scanned URL to a container by matching its host against
    container NAMES.

    Vici names containers after the client and site - "365 Fitness -
    my365fit.com" - so a site the scanner could not load (bot block,
    outage) can still be looked up. Depends on naming discipline, so it
    returns nothing rather than guessing when the match is not exact.
    """
    if not enabled():
        return None
    host = ""
    for h in _host_tokens(url):
        host = h
        break
    if not host:
        return None
    root = ".".join(host.split(".")[-2:]) if host.count(".") >= 1 else host
    hits = []
    for pid, info in build_index().items():
        names = _host_tokens(info.get("container_name", ""))
        if host in names or root in names:
            hits.append(pid)
    # two containers claiming the same domain is not something to guess at
    return hits[0] if len(hits) == 1 else None


def audit(public_id):
    """Read a container's PUBLISHED configuration.

    Live version, not the default workspace: a workspace can hold
    unpublished edits, so it does not describe what the site serves -
    and what the site serves is what the scanner observes.

    status:
      ok           - read it
      disabled     - no OAuth tokens configured
      not_indexed  - no authorized login can see this container, almost
                     always a client-owned GTM account. Fall back to
                     fingerprint attribution rather than reporting a
                     failure.
      error        - the API refused; detail carries the reason
    """
    pid = (public_id or "").strip().upper()
    if not enabled():
        return {"status": "disabled", "public_id": pid}
    try:
        hit = build_index().get(pid)
        if not hit:
            # a container created since the last build looks identical
            # to one we cannot see - rebuild once before saying so
            hit = build_index(force=True).get(pid)
        if not hit:
            return {"status": "not_indexed", "public_id": pid,
                    "logins_failing": dict(_index_errors),
                    "detail": ("No authorized Vici login can see this "
                               "container - most likely a client-owned "
                               "GTM account.")}
        version = _call(_service(hit["identity"]).accounts().containers()
                        .versions().live(parent=hit["path"]))
        out = {"status": "ok", "public_id": pid}
        out.update(hit)
        out.update(_summarize(version))
        return out
    except Exception as e:
        return {"status": "error", "public_id": pid,
                "detail": f"{e.__class__.__name__}: {e}"}


def accessible_containers():
    """Every container the authorized logins can read."""
    if not enabled():
        return []
    idx = build_index()
    return sorted(({"public_id": k, **v} for k, v in idx.items()),
                  key=lambda c: (c["account_name"], c["container_name"]))


def coverage():
    """How much of the estate is reachable, and which logins are broken.

    Reports every authorized login, including ones that reach nothing -
    a silent login is indistinguishable from one you forgot to set up.
    'sees' counts containers a login can read whether or not it was the
    first to claim them; 'owns' is how the index routed them.
    """
    rows = accessible_containers()
    per_login = {label: {"owns": 0, "sees": 0} for label in _tokens()}
    for c in rows:
        for label in [c["identity"]] + c["also_visible_to"]:
            per_login.setdefault(label, {"owns": 0, "sees": 0})
            per_login[label]["sees"] += 1
        per_login[c["identity"]]["owns"] += 1
    return {"containers": len(rows),
            "accounts": len({c["account_id"] for c in rows}),
            "per_login": per_login,
            "logins_failing": dict(_index_errors)}


def _authorize(label):
    """Mint a refresh token for one login. Run locally - it opens a
    browser and you sign in as that Google account."""
    from google_auth_oauthlib.flow import InstalledAppFlow
    flow = InstalledAppFlow.from_client_config(_load("GTM_OAUTH_CLIENT"), SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent",
                                  access_type="offline")
    print("\nSign-in complete. Add this entry to GTM_TOKENS:\n")
    print(f'  "{label}": "{creds.refresh_token}"\n')
    print("Store it as a secret - it is a durable credential for that "
          "login's entire GTM estate.")


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]

    if args and args[0] == "authorize":
        if len(args) < 2:
            print("usage: python gtm_api.py authorize <label>")
            raise SystemExit(1)
        _authorize(args[1])
        raise SystemExit(0)

    if not enabled():
        print("GTM_OAUTH_CLIENT and GTM_TOKENS must both be set.")
        print("Run: python gtm_api.py authorize <label>   (once per login)")
        raise SystemExit(1)

    if not args:
        cov = coverage()
        print(f"{cov['containers']} containers across "
              f"{cov['accounts']} GTM accounts\n")
        for label, n in sorted(cov["per_login"].items()):
            note = "" if n["owns"] == n["sees"] else \
                   f"  ({n['sees']} reachable, already covered by another login)"
            print(f"  {label:16} {n['owns']} containers{note}")
        if not cov["containers"]:
            print("\n  No containers at all - check each login has accepted "
                  "its GTM invitation and is added at ACCOUNT level.")
        if cov["logins_failing"]:
            print("\nLogins that failed - their containers are missing above:")
            for label, err in cov["logins_failing"].items():
                print(f"  {label:16} {err}")
        raise SystemExit(0)

    r = audit(args[0])
    print(f"status: {r['status']}")
    if r["status"] != "ok":
        print(r.get("detail", ""))
        raise SystemExit(0)
    print(f"container: {r['container_name']}  (account: {r['account_name']}, "
          f"via {r['identity']})")
    print(f"live version {r['version_id']} - {len(r['tags'])} tags, "
          f"{r['trigger_count']} triggers, {r['variable_count']} variables\n")
    for t in r["tags"]:
        flags = []
        if t["paused"]:
            flags.append("PAUSED")
        flags.append("consent: " + (", ".join(t["consent_types"])
                                    if t["consent_status"] == "NEEDED"
                                    else "not configured"))
        if not t["firing_triggers"]:
            flags.append("NO FIRING TRIGGER")
        vend = t["vendor"] or "unidentified"
        if t["vendor_from"] == "content":
            vend += " *"
        print(f"  {t['name'][:32]:34} {vend[:26]:28} {' | '.join(flags)}")
    unknown = sum(1 for t in r["tags"] if not t["vendor"])
    print(f"\n  * identified from the tag's own code, not its type")
    if unknown:
        print(f"  {unknown} tag(s) could not be matched to a known vendor")


# --- background refresh ---------------------------------------------
# Audits never run inline. The quota is 0.25 QPS per PROJECT, so a read
# in front of a scan would queue behind every other scan in flight. A
# failed refresh must be invisible to the scan that triggered it.

# How stale a cached audit may be before it is refetched, in days.
# not_indexed is a client-owned container - that will not change today,
# so re-asking every scan only burns quota.
STALE_DAYS = {"ok": 7, "not_indexed": 30, "error": 1}

_inflight = set()
_inflight_lock = threading.Lock()


def needs_refresh(cached):
    if cached is None:
        return True
    return (cached.get("_age_days", 0)
            >= STALE_DAYS.get(cached.get("_status"), 7))


def refresh_async(public_ids, get_cached, store):
    """Queue audits for any container whose cache is missing or stale.

    get_cached(public_id) -> cached dict or None
    store(public_id, status, result)
    """
    if not enabled():
        return []
    queued = []
    for pid in {(p or "").strip().upper() for p in public_ids if p}:
        try:
            if not needs_refresh(get_cached(pid)):
                continue
        except Exception:
            continue          # cache unreadable - do not stampede the API
        with _inflight_lock:
            if pid in _inflight:
                continue
            _inflight.add(pid)
        queued.append(pid)

    if not queued:
        return []

    def worker():
        for pid in queued:
            try:
                r = audit(pid)
                store(pid, r.get("status", "error"), r)
            except Exception as e:
                print(f"[gtm] audit {pid} failed: {e}")
            finally:
                with _inflight_lock:
                    _inflight.discard(pid)

    threading.Thread(target=worker, daemon=True).start()
    return queued


def warm_index():
    """Build the container index at startup rather than inside the first
    request that needs it. The first build costs one paced call per GTM
    account, which is enough to time a web request out."""
    if not enabled():
        return

    def go():
        try:
            n = len(build_index())
            print(f"[gtm] index warmed: {n} containers", flush=True)
        except Exception as e:
            print(f"[gtm] index warm failed: {e}", flush=True)

    threading.Thread(target=go, daemon=True).start()
