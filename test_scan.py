"""Dev test harness - run against /tmp/fixtures server on :8917."""
from scanner import scan_site

for name in ["onetrust", "cookiebot", "nocmp"]:
    r = scan_site(f"http://localhost:8917/{name}.html", prefer_full=True)
    print(f"--- {name}: mode={r['mode']} verdict={r['verdict']}")
    print(f"    cmps={[(c['name'], c['gtm_event']) for c in r['cmps']]}")
    print(f"    banner={r['banner_visible']} consent_mode={r['consent_mode_default']} "
          f"gtm={r['gtm']['container_ids']}")
    print(f"    pre_consent={[(h['vendor'], h['severity']) for h in r['pre_consent']]}")
    print(f"    detail={r['verdict_detail']}")
