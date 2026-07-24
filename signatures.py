"""
CMP fingerprints and tracker endpoint signatures.

Each CMP entry:
  name             - display name
  domains          - substrings matched against <script src>, <link href>, and raw HTML
  js_globals       - window globals checked in full (Playwright) mode
  cookies          - cookie-name prefixes checked in full mode
  banner_selectors - CSS selectors for the visible banner element
  gtm_event        - the dataLayer custom event to use as the GTM consent trigger
                     (feeds the buyer procedure / GTM automation recipe)
  notes            - anything a buyer should know
"""

CMP_SIGNATURES = [
    {
        "name": "OneTrust",
        "domains": ["cdn.cookielaw.org", "otSDKStub.js", "onetrust.com/consent"],
        "js_globals": ["OneTrust", "OptanonWrapper"],
        "cookies": ["OptanonConsent", "OptanonAlertBoxClosed"],
        "banner_selectors": ["#onetrust-banner-sdk"],
        "gtm_event": "OneTrustGroupsUpdated",
        "notes": "Event fires on every page view AND on preference updates (including reject) - pair with consent state checks.",
    },
    {
        "name": "Cookiebot",
        "domains": ["consent.cookiebot.com", "consentcdn.cookiebot.com"],
        "js_globals": ["Cookiebot"],
        "cookies": ["CookieConsent"],
        "banner_selectors": ["#CybotCookiebotDialog"],
        "gtm_event": "cookie_consent_update",
        "notes": "Standard event for Cookiebot's GTM template.",
    },
    {
        "name": "Usercentrics",
        "domains": ["app.usercentrics.eu", "web.cmp.usercentrics", "sdp.usercentrics.eu"],
        "js_globals": ["UC_UI", "usercentrics"],
        "cookies": ["uc_settings", "usercentrics"],
        "banner_selectors": ["#usercentrics-root", "#usercentrics-cmp-ui"],
        "gtm_event": "uc_consent_status",
        "notes": "Also emits uc_event depending on template version. Banner renders in shadow DOM.",
    },
    {
        "name": "iubenda",
        "domains": ["cdn.iubenda.com", "cs.iubenda.com"],
        "js_globals": ["_iub"],
        "cookies": ["_iub_cs"],
        "banner_selectors": ["#iubenda-cs-banner"],
        "gtm_event": "iubenda_gtm_consent_event",
        "notes": "Requires emitGtmEvents / GTM integration enabled in the iubenda configuration.",
    },
    {
        "name": "Osano",
        "domains": ["cmp.osano.com"],
        "js_globals": ["Osano"],
        "cookies": ["osano_consentmanager"],
        "banner_selectors": [".osano-cm-dialog", ".osano-cm-window"],
        "gtm_event": "osano-consent-saved",
        "notes": "Fires when a user saves or updates choices.",
    },
    {
        "name": "CookieYes",
        "domains": ["cdn-cookieyes.com", "app.cookieyes.com"],
        "js_globals": ["CookieYes"],
        "cookies": ["cookieyes-consent"],
        "banner_selectors": [".cky-consent-container", ".cky-consent-bar"],
        "gtm_event": "cookie_consent_update",
        "notes": "Matches Cookiebot's event syntax.",
    },
    {
        "name": "Termly",
        "domains": ["app.termly.io"],
        "js_globals": ["Termly"],
        "cookies": ["TERMLY_API_CACHE"],
        "banner_selectors": ["#termly-code-snippet-support", "[data-tid='banner']"],
        "gtm_event": "termly_consent_update",
        "notes": "Fires on banner interaction.",
    },
    {
        "name": "Ketch",
        "domains": ["global.ketchcdn.com"],
        "js_globals": ["ketch", "semaphore"],
        "cookies": ["_swb"],
        "banner_selectors": ["#lanyard_root"],
        "gtm_event": "ketch_consent_update",
        "notes": "Sent when the Ketch Smart Tag updates legal bases.",
    },
    {
        "name": "Didomi",
        "domains": ["sdk.privacy-center.org", "api.privacy-center.org"],
        "js_globals": ["Didomi", "didomiOnReady"],
        "cookies": ["didomi_token", "euconsent-v2"],
        "banner_selectors": ["#didomi-host", "#didomi-notice"],
        "gtm_event": "didomi-consent-changed",
        "notes": "Confirm event name against the site's Didomi GTM template version.",
    },
    {
        "name": "TrustArc",
        "domains": ["consent.trustarc.com", "consent.truste.com"],
        "js_globals": ["truste"],
        "cookies": ["notice_gdpr_prefs", "cmapi_cookie_privacy"],
        "banner_selectors": ["#truste-consent-track", "#consent_blackbar"],
        "gtm_event": None,
        "notes": "No standard GTM event - inspect the site's dataLayer or ask the TrustArc admin.",
    },
    {
        "name": "Complianz (WordPress)",
        "domains": ["complianz-gdpr"],
        "js_globals": ["complianz"],
        "cookies": ["cmplz_"],
        "banner_selectors": ["#cmplz-cookiebanner-container", ".cmplz-cookiebanner"],
        "gtm_event": "cmplz_event_marketing",
        "notes": "Complianz pushes cmplz_event_<category> events per consent category.",
    },
    {
        "name": "CookieLawInfo / WebToffee (WordPress)",
        "domains": ["cookie-law-info"],
        "js_globals": ["CLI"],
        "cookies": ["cookielawinfo-checkbox", "CookieLawInfoConsent"],
        "banner_selectors": ["#cookie-law-info-bar"],
        "gtm_event": None,
        "notes": "Older plugin versions have no dataLayer event - may need the regex fallback or plugin upgrade.",
    },
    {
        "name": "Quantcast Choice",
        "domains": ["cmp.quantcast.com", "quantcast.mgr.consensu.org"],
        "js_globals": ["__tcfapi"],
        "cookies": ["euconsent-v2"],
        "banner_selectors": [".qc-cmp2-container"],
        "gtm_event": None,
        "notes": "TCF-based; use a TCF consent listener rather than a simple custom event.",
    },
    {
        "name": "Axeptio",
        "domains": ["static.axept.io", "client.axept.io"],
        "js_globals": ["axeptio", "_axcb"],
        "cookies": ["axeptio_cookies", "axeptio_authorized_vendors"],
        "banner_selectors": ["#axeptio_overlay"],
        "gtm_event": None,
        "notes": "Axeptio pushes per-vendor booleans to the dataLayer; check site config.",
    },
]

# Well-known ad/analytics pixel endpoints. `vendor` is the display name;
# `google` flags endpoints participating in Google Consent Mode, whose
# cookieless pings can legitimately fire pre-consent when Consent Mode
# defaults are set (we classify those as informational, not violations).
TRACKER_ENDPOINTS = [
    {"vendor": "Meta Pixel", "patterns": ["facebook.com/tr", "connect.facebook.net"], "google": False},
    {"vendor": "TikTok Pixel", "patterns": ["analytics.tiktok.com"], "google": False},
    {"vendor": "LinkedIn Insight", "patterns": ["px.ads.linkedin.com", "snap.licdn.com"], "google": False},
    {"vendor": "Snapchat Pixel", "patterns": ["tr.snapchat.com", "sc-static.net/scevent"], "google": False},
    {"vendor": "Pinterest Tag", "patterns": ["ct.pinterest.com"], "google": False},
    {"vendor": "Reddit Pixel", "patterns": ["events.reddit.com", "alb.reddit.com"], "google": False},
    {"vendor": "Microsoft UET", "patterns": ["bat.bing.com"], "google": False},
    {"vendor": "X / Twitter Pixel", "patterns": ["analytics.twitter.com", "t.co/i/adsct"], "google": False},
    {"vendor": "Microsoft Clarity", "patterns": ["clarity.ms"], "google": False},
    {"vendor": "Hotjar", "patterns": ["hotjar.com", "hotjar.io"], "google": False},
    {"vendor": "FullStory", "patterns": ["fullstory.com"], "google": False},
    {"vendor": "Google Analytics 4", "patterns": ["google-analytics.com/g/collect", "analytics.google.com/g/collect"], "google": True},
    {"vendor": "Google Ads", "patterns": ["googleadservices.com", "googleads.g.doubleclick.net"], "google": True},
    {"vendor": "DoubleClick / Floodlight", "patterns": ["fls.doubleclick.net", "ad.doubleclick.net"], "google": True},
]
