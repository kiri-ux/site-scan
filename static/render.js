const TIPS = {
  'gtag-only': 'The page loads gtag.js (Google Analytics / Google Ads) from googletagmanager.com, but no Tag Manager container was found. Tags here are configured in the gtag snippet or in page code, not in a container.',
  'configured-silent': 'This tag\u2019s code was found in the page source or the GTM container, but no matching request fired. That is a FIRING problem - a trigger condition, a consent block, or a script error - not a missing tag. Fixable, and worth a GTM Preview session.',
  'not found': 'No matching request fired AND no trace of this tag was found in the page source or the GTM container JS. It was most likely never installed on this page - a placement conversation, not a debugging one.',
  'not seen': 'No request matching this pixel was observed on this page, before or after consent. From outside we cannot tell not-installed from blocked - it may also fire only on specific pages or events (a thank-you page, a form submit). The GTM config audit is what settles it.',
  'pre-consent only': 'This page HAS a consent banner, and this pixel fired before any consent interaction - it is jumping the banner. Working, but not consent-gated.',
  'ungated-pixel': 'This pixel runs unrestricted because the page has no consent mechanism at all. It is working - the finding is the missing CMP (the site-level condition), and if the client adds a banner, this pixel should then be gated behind it. US state laws don\u2019t require the banner itself - see the opt-out mechanism check for what they do require.',
  'pre + post': 'Fired both before AND after Accept. The post-consent fire is fine - the pre-consent fire is the problem half, since it ran before the visitor agreed.',
  'post-consent': 'Fired only after Accept was clicked - correctly consent-gated. This is the target state for every tracking pixel.',
  'firing': 'Every expected pixel for this product was observed on this page.',
  'partial': 'Some of this product\u2019s expected pixels were observed, others were not - check each row below.',
  'missing': 'None of this product\u2019s expected pixels were observed on this page, before or after consent.',
  'ungated': 'This tracker runs with no consent mechanism on the page at all. The finding is the missing CMP - the site-level condition - not a fault of this individual tag.',
  'violation': 'Fired before consent on a page that HAS a consent banner - it is bypassing the CMP. This is the pattern consent litigation targets.',
  'after-reject': 'Fired after the visitor explicitly clicked Reject/Decline. Continuing to track after an explicit no is the highest-risk behavior the scanner checks for.',
  'defaults': 'Google Consent Mode defaults found in this page\u2019s GTM/gtag setup. denied means each storage type starts blocked until the visitor consents, so Google tags run cookieless until Accept - this is exactly the end-state the GTM consent procedure installs.',
  'cmp-evidence': 'How this CMP was identified: the network requests, script domains, JS globals, or cookies observed on the page that match its signature.',
  'pixels missing': 'One or more selected products had no pixels observed on this page - see the Product pixels section.',
  'pre-consent fires': 'Trackers fired before consent on a page that has a consent banner - see Other pixels and the product rows.',
  'fires after reject': 'Trackers fired after Reject was clicked - see Requests after Reject.',
  'scan error': 'This page could not be fully scanned - the result may be incomplete. Re-run after checking the URL.',
  'still running': 'The browser stopped waiting for this page, but the scan is most likely still going server-side. Nothing here is a finding about the site - the real result replaces this on its own when it lands.',
};
function tipAttr(key){ const t = TIPS[key]; return t ? ` data-tip="${t.replace(/"/g,'&quot;')}"` : ''; }

// Shared rendering for scan results (index + share pages).
const $ = id => document.getElementById(id);
function normUrl(u){
  let s = (u || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return s;
}

const VERDICT_META = {
  ok:              {cls:'ok',      label:'Looks good'},
  no_cmp:          {cls:'bad',     label:'No CMP'},
  misconfigured:   {cls:'bad',     label:'Pre-consent fires'},
  cmp_found_basic: {cls:'neutral', label:'CMP found (basic)'},
  error:           {cls:'warn',    label:'Scan error'},
  pending:         {cls:'neutral', label:'Still running'},
};

const CHAIN_TIPS = {
  'CMP': 'Consent Management Platform: the cookie-banner vendor detected on this page. "None found" means no known consent tech is installed, so nothing is gating the pixels.',
  'Banner visible': 'Whether the consent banner actually rendered on page load. A CMP can be installed but broken, hidden, or geo-gated to other regions.',
  'Consent Mode default': 'Whether Google Consent Mode defaults (e.g. ad_storage=denied) are set before any interaction. Without them, Google tags treat consent as granted and the consent checks in GTM do nothing.',
  'Pre-consent trackers': 'Ad/analytics requests that fired BEFORE any consent interaction. Non-Google fires are compliance violations; Google fires may be permitted cookieless Consent Mode pings.',
  'Product pixels': 'Vici product pixels seen on this page, firing vs expected (e.g. BARCK+ 3/5). Products selected for this client that show 0 firing are flagged as missing.',
  'Reject honored': 'A fresh page load where the scan clicks Reject/Decline instead of Accept, then checks nothing fires. Trackers firing after an explicit Reject is the failure driving most consent litigation. "No reject option" is common on US opt-out banners.',
  'State checks': 'Checks mapped to the states this client targets: whether ad trackers stay quiet on a page load carrying the Global Privacy Control signal (required in 12 states), and whether a recognizable opt-out link is present. Check failures, not legal conclusions.',
};

function chainLink(k, v, state){
  const tip = (CHAIN_TIPS[k] || '').replace(/"/g, '&quot;');
  return `<div class="link ${state}" data-tip="${tip}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}
const GTM_PROCEDURE = `<details class="ai-proc"><summary>GTM consent procedure - the standard steps</summary><ol>
<li><b>Consent defaults:</b> add a Consent Mode default block setting every storage type to <code>denied</code> (ad_storage, analytics_storage, ad_user_data, ad_personalization), firing on GTM's <i>Consent Initialization - All Pages</i> trigger (or pasted above the GTM snippet in page code).</li>
<li><b>Connect the CMP:</b> enable the banner's Google Consent Mode integration (most CMPs have a toggle or GTM template) so Accept/Reject sends <code>gtag('consent','update',...)</code>.</li>
<li><b>Google tags:</b> respect Consent Mode automatically once defaults exist - verify each tag's consent settings in GTM show the built-in checks.</li>
<li><b>Non-Google tags</b> (Meta, TikTok, etc.): set "Additional consent checks" to require <code>ad_storage</code>, or fire them on a consent-updated event where <code>ad_storage == granted</code> instead of page load.</li>
<li><b>Publish, then re-scan:</b> the report should show Defaults &#10003; CORRECT SETUP, no pre-consent fires, and reject honored - the before/after pair is the verification.</li>
</ol></details>`;

function srcTag(s, containers, hasGtm){
  const c = (containers || []).filter(Boolean);
  if (s === 'runtime' && !c.length && hasGtm === false)
    return ` <span class="src-tag gtm" data-tip="Injected at runtime - no trace in the raw page source. No Tag Manager container was detected on this page, so another script is loading it.">RUNTIME</span>`;
  if (s === 'runtime' && c.length === 1) return ` <span class="src-tag gtm" data-tip="Injected at runtime, and this pixel's fingerprint appears in ${c[0]}'s published container - strong evidence that is the source. It proves the tag is configured there, not that this exact request came from it.">${c[0]}</span>`;
  if (s === 'runtime' && c.length > 1) return ` <span class="src-tag gtm" data-tip="Injected at runtime. The fingerprint appears in more than one container (${c.join(', ')}), so container code alone can't say which one fired it.">GTM &times;${c.length}</span>`;
  if (s === 'runtime') return ` <span class="src-tag gtm" data-tip="Injected at runtime - no trace in the raw page source. With a GTM on the page, this is how GTM-managed tags load. No container fingerprint matched, so the specific container is unresolved.">GTM</span>`;
  if (s === 'page') return ` <span class="src-tag page" data-tip="Hardcoded - the vendor's snippet appears in the raw page source, outside any tag manager.">HARDCODED</span>`;
  return '';
}

// Consent Mode natively governs only Google tags. Naming the client's
// own affected products beats a generic list - a Meta-only client gains
// nothing from a defaults fix, and should not be told otherwise.
const GOOGLE_PIXELS = ['Google Ads', 'Google Analytics', 'Google Analytics 4', 'Floodlight'];
function googleProds(r){
  return (r.products || []).filter(p => (p.pixels || [])
    .some(px => GOOGLE_PIXELS.includes(px.name))).map(p => p.product).join(', ');
}
function nonGoogleProds(r){
  return (r.products || []).filter(p => !(p.pixels || [])
    .some(px => GOOGLE_PIXELS.includes(px.name))).map(p => p.product).join(', ');
}

// The Consent Mode signals that are actually granted or denied. A
// consent default call also carries configuration parameters - region,
// wait_for_update - which are neither. Reading those as "granted" turns
// a correctly configured site into an INCORRECT SETUP stamp.
const CM_STORAGE = new Set(['ad_storage', 'analytics_storage', 'ad_user_data',
  'ad_personalization', 'functionality_storage', 'personalization_storage',
  'security_storage']);

// Vendors Consent Mode governs natively. Everything else has to be
// gated by a per-tag consent check in GTM instead.
const GOOGLE_VENDORS = new Set(['Google Ads', 'Google tag', 'Google Analytics 4',
  'GA4', 'Google Tag Manager', 'Floodlight']);

function cmBlock(r){
  // Consent Mode verdict - site-level, rendered once in the client
  // summary rather than per page
  const defaults = Object.entries(r.consent_defaults || {})
    .filter(([k]) => CM_STORAGE.has(k)).sort();
  let stamp = '', note = '';
  if (defaults.length) {
    const granted = defaults.filter(([k, v]) => v !== 'denied').map(([k]) => k);
    // Denied defaults are only "correct" when a banner can grant
    // consent. With none, nothing ever flips them and the Google tags
    // are switched off for good - the opposite of a pass.
    // A notice-only bar is not a consent path: it dismisses itself and
    // sets a cookie, it does not push a consent update. So denied
    // defaults behind one leave the tags dark exactly as no banner would.
    const realCmp = (r.cmps || []).filter(c => c.name !== 'Notice-only banner');
    const noticeOnly = realCmp.length < (r.cmps || []).length;
    const noPath = !granted.length && !realCmp.length;
    stamp = granted.length
      ? `<span class="cm-stamp bad"${tipAttr('defaults')}>&#10007; INCORRECT SETUP</span>`
      : noPath
      ? `<span class="cm-stamp bad"${tipAttr('defaults')}>&#10007; BLOCKED - NO CONSENT PATH</span>`
      : `<span class="cm-stamp ok"${tipAttr('defaults')}>&#10003; CORRECT SETUP</span>`;
    note = granted.length
      ? `<div class="cm-note warn">&#9888; <b>${granted.join(', ')}</b> ${granted.length > 1 ? 'start' : 'starts'} granted, so Google tags can track before consent. <b>Fix:</b> set every storage type to <b>denied</b> by default and let the banner flip them on Accept.</div>`
      : noPath
      ? `<div class="cm-note warn">&#9888; <b>Every storage type starts denied and ${noticeOnly ? 'the notice-only bar cannot grant it' : 'there is no banner to grant it'}.</b> ${noticeOnly ? 'A notice-only bar sets a cookie and dismisses itself - it sends no consent update. ' : ''}Google tags${googleProds(r) ? ` (${googleProds(r)})` : ''} stay dark indefinitely: no conversion attribution, no remarketing, GA4 modelled only.${nonGoogleProds(r) ? ` Non-Google pixels (${nonGoogleProds(r)}) keep firing normally.` : ''} <b>Fix:</b> install a banner that sends a consent update, or revert the defaults until one is in place.</div>`
      : `<div class="cm-note ok">&#10003; Every storage type starts <b>denied</b> and a CMP is present to grant it. No Consent Mode work needed.</div>`;
  } else if (r.gtm && r.gtm.found && (r.cmps||[]).length) {
    stamp = `<span class="cm-stamp bad">&#10007; NOT CONFIGURED</span>`;
    note = `<div class="cm-note warn">&#9888; A CMP is present but no Consent Mode defaults were found, so Google tags run at full capability before consent. <b>Fix:</b> install denied-by-default settings.</div>`;
  }
  // Ownership is a client-level fact, so it rides the summary GTM line
  // rather than repeating on every page below. The container and owner
  // are reported whether or not there is Consent Mode data - they are
  // independent facts and used to disappear together with it.
  const own = r.implementation === 'Vici-owned GTM'
    ? ` <span class="ob ob-vici">VICI OWNED</span>`
    : r.implementation === 'Client placement'
    ? ` <span class="ob ob-ext">CLIENT OWNED</span>` : '';
  const g = r.gtm || {};
  // Confirm the container on the page is the one the API read - without
  // it there is no way to tell a verified container from a guess.
  const verified = (g.container_ids || [])
    .map(id => AUDITS[id]).filter(a => a && a.status === 'ok');
  const vTag = verified.length
    ? ` <span class="src-tag gtm" data-tip="This container was read through the Tag Manager API - the tag list below is its published configuration, not an inference from the page.">&#10003; ${verified.reduce((n, a) => n + (a.tags || []).length, 0)} tags read via API</span>`
    : '';
  const gtmBit = (g.container_ids || []).length
    ? `<span class="kv">GTM: <b>${g.container_ids.join(', ')}</b>${own}${vTag}</span>`
    : g.found
    ? `<span class="kv">GTM: <b>container present, ID not detected</b>${own}</span>`
    : g.gtag_only
    ? `<span class="kv"${tipAttr('gtag-only')}>No Tag Manager container - <b>gtag.js only${(g.gtag_ids || []).length ? ` (${g.gtag_ids.join(', ')})` : ''}</b>${own}</span>`
    : '';
  if (!stamp && !note && !gtmBit) return '';
  return `<div style="display:flex;gap:14px;align-items:center;margin:14px 0 6px">${stamp}${gtmBit}</div>${note}`;
}

function ownerBadge(owner){
  if (owner === 'VICI') return `<span class="ob ob-vici" data-tip="Vici-side change - the buyer makes this fix directly">VICI</span>`;
  if (owner === 'CLIENT') return `<span class="ob ob-ext">CLIENT</span>`;
  return `<span class="ob ob-un" data-tip="Owner depends on who manages the tags - set Implementation (Vici-owned GTM vs Client placement) on the scan form to resolve">SET IMPLEMENTATION</span>`;
}

// A Vici-named container that is empty and was never seen on the page
// means the client moved to their own setup. The stale one sits in
// Vici's GTM account making the container list less trustworthy, so it
// is the buyer's to clean up - and it is internal work, not something a
// client should read on a share link.
function staleContainers(rs){
  if (SHARE_MASK()) return [];
  const seenIds = new Set((rs || []).flatMap(r => ((r.gtm || {}).container_ids) || []));
  return [...new Set((rs || []).map(r => AUDIT_BY_URL[_rootDomain(r.url)]).filter(Boolean))]
    .filter(pid => !seenIds.has(pid))
    .filter(pid => { const a = AUDITS[pid]; return a && a.status === 'ok' && !(a.tags || []).length; });
}

function staleContainerText(rs){
  const s = staleContainers(rs);
  return `Deprecate ${s.join(', ')} in Vici's GTM account - the container is empty and was not found on the site, so this client is running their own container or standalone pixels. Confirm with the buyer before removing.`;
}

function actionItemsHtml(rs, impl){
  if (!rs || !rs.length) return '';
  // Nothing has reported yet - any action item would be invented.
  const waiting = rs.filter(r => r.pending);
  if (waiting.length === rs.length)
    return `<h3>Action items</h3><div class="cm-note">&#8987; <b>Still waiting on this scan.</b> ${waiting[0].verdict_detail || ''} No action items until it reports.</div>`;
  // A page that didn't load produces false work ("install or repair
  // the pixel") - say the scan is unreliable instead.
  const bad = rs.filter(r => r.inconclusive);
  if (bad.length === rs.length){
    const b = bad[0];
    // show what the page actually returned, so the next run diagnoses
    // itself instead of needing a code read
    const ev = [
      b.http_status ? `HTTP ${b.http_status}` : null,
      b.page_title ? `page title "${b.page_title}"` : null,
      b.html_len ? `${Math.round(b.html_len / 1024)} KB of HTML` : null,
      (b.final_url && b.final_url !== b.url) ? `redirected to ${b.final_url}` : null
    ].filter(Boolean);
    const stale = staleContainers(rs).length
      ? `<ul><li>${ownerBadge('VICI')}<div>${staleContainerText(rs)}</div></li></ul>` : '';
    return `<h3>Action items</h3><div class="cm-note warn">&#9888; <b>No action items about the site - this scan is inconclusive.</b> ${b.verdict_detail || 'The page did not load fully.'} Nothing here should be treated as a finding about the site.${ev.length ? `<div class="evidence" style="margin-top:6px">What the scanner received: ${ev.join(' &middot; ')}.</div>` : ''}</div>${stale}`;
  }
  const pixOwner = impl === 'Vici-owned GTM' ? 'VICI' : impl === 'Client placement' ? 'CLIENT' : 'UNSET';
  const main = rs.slice().sort((a,b) => (a.url||'').length - (b.url||'').length)[0];
  // Vici-owned items are a work queue for the buyer, not an
  // explanation for a client - name the step and stop.
  const terse = pixOwner === 'VICI';
  const items = [];
  // rank = dependency order within an owner's list; lower runs first.
  // 10 banner (everything below assumes it exists) - 20 gating -
  // 30 Consent Mode - 40 pixels - 60+ independent site items.
  const push = (owner, text, rank = 50) => items.push({owner, text, rank, seq: items.length});

  // product pixels missing anywhere
  const missing = [...new Set(rs.flatMap(r => (r.products||[]).filter(p => p.fired === 0).map(p => p.product)))];
  if (missing.length) push(pixOwner, terse
    ? `Install or repair the ${missing.join(', ')} pixel${missing.length>1?'s':''}.`
    : `Install or repair the ${missing.join(', ')} pixel${missing.length>1?'s':''} - expected but not seen on any scanned page.` + (pixOwner==='CLIENT' ? ' Vici supplies the pixel code.' : ''), 40);

  const hasCmp = (main.cmps||[]).length > 0;
  // Vici-owned GTM means the buyer applies the procedure (and will do
  // it via the API), so the step list isn't part of the deliverable.
  const proc = pixOwner === 'VICI' ? '' : GTM_PROCEDURE;
  const below = pixOwner === 'VICI' ? '' : ' (steps below)';
  // no CMP: what the LAW requires is a working opt-out method - a
  // banner is the recommended delivery, never the requirement itself
  const mechFail = (main.state_checks || []).some(c => c.check === 'Opt-out mechanism' && c.status === 'fail');
  // A failing mechanism check always gets an action item, even on a
  // site that has a banner - a notice-only bar can't decline, so it
  // fails the check while hasCmp stays true (hasCmp still drives the
  // gating item below, where the banner's presence is the point).
  if (main.ok && main.mode === 'full' && (mechFail || !hasCmp)){
    if (mechFail){
      const mechStates = (main.state_checks || []).filter(c => c.check === 'Opt-out mechanism' && c.status === 'fail').map(c => c.state);
      const followUp = pixOwner === 'VICI'
        ? `Once one is in place, Vici applies the consent procedure in the GTM${below}.`
        : pixOwner === 'CLIENT'
        ? "Once one is in place, the client's team applies the consent procedure in their container (steps below)."
        : 'Once one is in place, the consent procedure gates the pixels (steps below; owner per Implementation).';
      const noticeOnly = (main.cmps || []).some(c => c.name === 'Notice-only banner');
      const absent = noticeOnly
        ? 'the banner is notice-only with no reject option, no opt-out link, GPC not honored'
        : 'no banner, no opt-out link, GPC not honored';
      const fix = noticeOnly
        ? 'Recommended fix: replace the notice-only bar with a real consent banner (CMP)'
        : 'Recommended fix: a consent banner (CMP)';
      push('CLIENT', `Give residents a working opt-out method - required for ${mechStates.join(' & ')} targeting and currently absent (${absent}). ${fix}, which delivers the opt-out link, GPC handling, and pixel gating in one install - the law requires the opt-out, not the banner itself. ${followUp}${proc}`, 10);
    } else {
      const followUp2 = pixOwner === 'VICI'
        ? `Vici applies the consent procedure in the GTM once one is in place${below}.`
        : pixOwner === 'CLIENT'
        ? "The client's team applies the consent procedure in their container once one is in place (steps below)."
        : 'The consent procedure gates the pixels once one is in place (steps below; owner per Implementation).';
      push('CLIENT', `Recommended (not required): install a consent banner (CMP) to gate pixels and cover current and future state targeting. ${followUp2}${proc}`, 10);
    }
  }
  // ONE gating item for everything firing around the banner: product
  // pixels pre-consent, violations, and after-reject fires are the
  // same finding (the CMP isn't gating them). The fix depends on WHERE
  // the tags run - a GTM gets the consent procedure; hardcoded page
  // snippets get consent-wrapped or migrated - not on which list the
  // scanner caught them in.
  const gateSet = new Set();
  for (const r of rs){
    if (!(r.cmps||[]).length) continue;
    const p2p = {};
    for (const p of (r.products||[])) for (const px of (p.pixels||[])) p2p[px.name] = p.product;
    for (const p of (r.products||[])){
      const preonly = (p.pixels||[]).filter(px => px.fired_pre && !px.fired_post);
      if (!preonly.length) continue;
      gateSet.add(p.product);
      if (preonly.some(px => px.src === 'page')) (gateSet.pageCode = gateSet.pageCode || new Set()).add(p.product);
      if (preonly.some(px => px.src === 'runtime')) (gateSet.runtime = gateSet.runtime || new Set()).add(p.product);
    }
    for (const h of [...(r.pre_consent||[]).filter(h => h.severity==='violation'), ...(r.post_reject||[])]){
      const name = h.product || p2p[h.vendor] || h.vendor;
      gateSet.add(name);
      if (h.src === 'page') (gateSet.pageCode = gateSet.pageCode || new Set()).add(name);
      if (h.src === 'runtime') (gateSet.runtime = gateSet.runtime || new Set()).add(name);
    }
  }
  const gate = [...gateSet];
  if (hasCmp && gate.length){
    const pageCode = [...(gateSet.pageCode || [])];
    const runtime = [...(gateSet.runtime || [])].filter(v => !gateSet.pageCode || !gateSet.pageCode.has(v));
    const gtmFix = pixOwner === 'VICI'
      ? `Vici applies the consent procedure in the GTM${below}.`
      : "the client's team applies the consent procedure in their container (steps below).";
    const pageFix = pixOwner === 'VICI'
      ? 'Vici migrates them into the GTM (or consent-wraps the snippets).'
      : "Vici provides consent-wrapped snippets or a GTM migration; the client's team installs.";
    let body;
    if (terse){
      const bits = [];
      if (runtime.length) bits.push(`apply the consent procedure in the GTM for ${runtime.join(', ')}`);
      if (pageCode.length) bits.push(`migrate or consent-wrap ${pageCode.join(', ')} in page code`);
      body = (bits.length ? bits.join('; ') : `${gate.join(', ')}`) + '.';
    } else if (runtime.length && !pageCode.length){
      body = `${gate.join(', ')} - all GTM-injected, so ${gtmFix}`;
    } else if (pageCode.length && !runtime.length){
      body = `${gate.join(', ')} - all hardcoded in page code, so ${pageFix}`;
    } else if (pageCode.length && runtime.length){
      body = `${pageCode.join(', ')} hardcoded in page code (${pageFix}); ${runtime.join(', ')} GTM-injected (${gtmFix})`;
    } else {
      body = `${gate.join(', ')}. If they run from a GTM, apply the consent procedure in that container${below}; if hardcoded in page code, consent-wrap or migrate them${pixOwner === 'UNSET' ? ' (owner per Implementation)' : ''}.`;
    }
    // Why it matters depends on whether state targeting is set. With no
    // states we describe what the scan found, never what the law says.
    const gStates = main.states || [];
    const why = gStates.length
      ? ` Flagged for ${gStates.join(' & ')} targeting, where a resident's opt-out has to take effect.`
      : ' No states are selected for this client, so this is not flagged as a state-law requirement. It still matters: the banner offers Reject and these trackers fire anyway.';
    push(pixOwner, `Consent-gate the trackers firing around the banner - the CMP isn't gating them: ${body}${body.endsWith('.') ? '' : '.'}${terse ? '' : why}${proc}`, 20);
    var gatePushed = true;
  }

  // consent mode defaults
  // Consent Mode defaults are STEP 1 of the consent procedure - when
  // the gating item (which carries the procedure) is already on the
  // list, a separate defaults item is the same work listed twice
  if (typeof gatePushed === 'undefined'){
    const defs = main.consent_defaults || {};
    const defKeys = Object.keys(defs);
    const leaking = defKeys.filter(k => defs[k] !== 'denied');
    const where = pixOwner === 'VICI'
      ? ' Fixable in the GTM Consent Initialization trigger.'
      : ' Vici provides the default-consent block; it must load above the tags.';
    if (defKeys.length && leaking.length && hasCmp)
      push(pixOwner, terse
        ? 'Set Consent Mode defaults to denied in the GTM Consent Initialization trigger.'
        : `Set Consent Mode defaults to denied (${leaking.join(', ')} currently granted).` + where, 30);
    else if (defKeys.length && leaking.length)
      // No banner means nothing would ever grant consent, so denied
      // defaults would leave the Google tags limited indefinitely.
      push(pixOwner, terse
        ? 'Set Consent Mode defaults to denied - with the banner install, not before.'
        : `Set Consent Mode defaults to denied when the consent banner goes in - not before (${leaking.join(', ')} currently granted). With no banner to grant consent, denied defaults would leave Google tags running cookieless indefinitely, so the two changes ship together.` + where, 30);
    else if (!defKeys.length && main.gtm && main.gtm.found && hasCmp) push(pixOwner, terse
      ? 'Add Google Consent Mode defaults, denied by default.'
      : 'Add Google Consent Mode defaults (none detected) so Google tags start denied until consent.', 30);
  }

  // reject violations already covered by bypass on CMP pages; state/site items:
  for (const c of (main.state_checks || [])){
    if (c.status !== 'fail') continue;
    if (c.check === 'Privacy policy link') push('CLIENT', 'Add an accessible privacy policy link - none found on the page.', 60);
    if (c.check === 'Opt-out link' && !mechFail) push('CLIENT', 'Add a "Your Privacy Choices" / opt-out link to the site footer.', 60);
    if (c.check === 'GPC signal') push('CLIENT', hasCmp
      ? 'Honor the Global Privacy Control signal - usually a setting in the consent banner already on the site.'
      : 'Honor the Global Privacy Control signal - the consent banner above delivers this once it is installed.', 60);
    if (c.check === 'Health-context tracking') push('CLIENT', "Get a documented decision from the client's legal/compliance owner on whether ad pixels may run on this site, and on which pages. Pixel payloads include page URLs, so on a health-context site the ad platforms receive health-related browsing data - sensitive data requiring OPT-IN consent in most states. Their options: run as-is, restrict pixels to non-sensitive pages, opt-in gate them, or remove them. Vici supplies this report as the evidence and implements whatever they decide.", 70);
    if (c.check === 'Child-directed tracking') push('CLIENT', "Get a documented decision from the client's legal/compliance owner before any trackers run on this child-directed site - COPPA requires verifiable parental consent (a banner doesn't satisfy it), and behavioral advertising to children is the FTC's most enforced tracking rule. Default recommendation: remove ad trackers entirely; Vici implements whatever they decide.", 70);
  }

  if (!items.length) return '';
  // dedupe identical opt-out/GPC lines that repeat per state group
  if (staleContainers(rs).length)
    push('VICI', staleContainerText(rs), 80);

  const seen = new Set();
  const rows = items.filter(it => { const k = it.owner + it.text; if (seen.has(k)) return false; seen.add(k); return true; });
  // Group each owner's work together so nobody reads past items that
  // aren't theirs. The owner holding the earliest dependency leads.
  const best = {};
  for (const it of rows) best[it.owner] = Math.min(best[it.owner] ?? 99, it.rank);
  rows.sort((a, b) => (best[a.owner] - best[b.owner])
                   || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0)
                   || (a.rank - b.rank) || (a.seq - b.seq));
  return `<h3>Action items</h3><ul class="ai">` + rows.map(it =>
    `<li>${ownerBadge(it.owner)}<div>${it.text}</div></li>`).join('') + `</ul>`;
}

// Site-level checks live on whichever page was scanned with them. On
// older runs that can differ from the display main, so find them
// rather than assuming.
function siteCheckResult(rs, fallback){
  return (rs || []).find(r => (r.state_checks || []).length) || fallback;
}

// --- container audit -------------------------------------------------
// What the GTM container is CONFIGURED to do, as opposed to what the
// scan observed firing. Fetched from the cache, so it is absent until a
// background audit has run - and permanently absent for client-owned
// containers nobody at Vici can read. Absence is normal, not an error.
const AUDITS = {};
const AUDIT_FETCHING = new Set();

// A miss is NOT cached. The background audit takes a few seconds - the
// quota forces 4s between calls - so the first look after a scan finds
// nothing, and caching that would hide the result until a reload.
async function loadAudits(ids, onDone){
  const want = [...new Set((ids || []).filter(Boolean))]
    .filter(id => !AUDITS[id] && !AUDIT_FETCHING.has(id));
  if (!want.length) return;
  want.forEach(id => AUDIT_FETCHING.add(id));
  let arrived = false;
  await Promise.all(want.map(async id => {
    try {
      const d = await (await fetch(`/gtm/audit/${encodeURIComponent(id)}`)).json();
      if (d.audit) { AUDITS[id] = d.audit; arrived = true; }
    } catch(e){ /* not cached yet, or no DB - try again next time */ }
    finally { AUDIT_FETCHING.delete(id); }
  }));
  // only re-render when something new landed, so this cannot loop
  if (arrived && onDone) onDone();
}

// Watch for audits queued by a scan that has just finished. Stops as
// soon as every container has one, or after ~40s if the container is
// simply not readable.
function pollAudits(ids, onDone, tries){
  const list = [...new Set((ids || []).filter(Boolean))];
  const missing = () => list.filter(id => !AUDITS[id]);
  if (!list.length || !missing().length) return;
  if (tries === undefined) tries = 8;
  loadAudits(ids, onDone).then(() => {
    if (tries > 0 && missing().length)
      setTimeout(() => pollAudits(ids, onDone, tries - 1), 5000);
  });
}

// A blocked page never reveals its container ID, so it is resolved
// from the site's domain instead. Keyed by URL because that is all a
// failed scan gives us.
const AUDIT_BY_URL = {};

const AUDIT_URL_TRIED = new Set();

function _rootDomain(u){
  try {
    const h = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u)
      .hostname.toLowerCase().replace(/^www\./, '');
    const p = h.split('.');
    return p.length > 2 ? p.slice(-2).join('.') : h;
  } catch(e){ return u || ''; }
}

async function loadAuditByUrl(url, onDone){
  if (!url) return;
  // Every page of a blocked client resolves to the same container -
  // one lookup per domain, not one per page.
  const root = _rootDomain(url);
  if (AUDIT_URL_TRIED.has(root)) {
    if (AUDIT_BY_URL[root]) AUDIT_BY_URL[url] = AUDIT_BY_URL[root];
    return;
  }
  AUDIT_URL_TRIED.add(root);
  try {
    const d = await (await fetch(`/gtm/audit-by-url?url=${encodeURIComponent(url)}`)).json();
    if (d.public_id){
      AUDIT_BY_URL[url] = d.public_id;
      AUDIT_BY_URL[root] = d.public_id;
      if (d.audit){ AUDITS[d.public_id] = d.audit; if (onDone) onDone(); }
    }
  } catch(e){ AUDIT_URL_TRIED.delete(root); }
}

// Container tags are named for the vendor that fingerprinted them, but
// buyers think in products. Google Ads and Google Analytics are left
// out deliberately - they belong to several products (YouTube, PPC,
// PMax / SEO) and the tag alone cannot say which.
const VENDOR_PRODUCT = {
  'xAd/GroundTruth': 'Mobile', 'Meta Pixel': 'Meta',
  'Amazon Ad Tag': 'Amazon', 'LinkedIn Insight': 'LinkedIn',
  'TikTok Pixel': 'TikTok', 'IDX tag': 'WVID',
  'Beeswax conversion': 'BARCK+', 'Beeswax segment': 'BARCK+',
  'Yahoo': 'BARCK+', 'The Trade Desk': 'BARCK+', 'Floodlight': 'BARCK+',
};

// Vendors actually seen firing across every scanned page - configured
// and firing are different facts, and the gap between them is the
// point of reading the container at all.
function observedVendors(rs){
  const out = new Set();
  for (const r of rs || []){
    for (const k of ['pre_consent', 'post_consent', 'post_reject'])
      for (const h of (r[k] || [])) if (h.vendor) out.add(h.vendor);
    for (const p of (r.products || []))
      for (const px of (p.pixels || []))
        if (px.fired_pre || px.fired_post) out.add(px.name);
  }
  return out;
}

// --- trigger evaluation ----------------------------------------------
// A tag that never fires on page load is not a finding when a page-load
// scan does not see it. Trigger type says whether it could fire at all;
// URL conditions say on which pages. Anything that depends on the
// dataLayer, a cookie or custom JS is reported as undeterminable rather
// than guessed at.
//
// GTM's API returns these enums in camelCase ("domReady", "startsWith").
// Strip separators before comparing so both that and any snake-case
// value in an older cached audit land on the same key.
function _norm(s){ return String(s || '').replace(/[_\s-]/g, '').toUpperCase(); }

const LOAD_TRIGGERS = new Set(['PAGEVIEW', 'DOMREADY', 'WINDOWLOADED',
  'INIT', 'CONSENTINIT', 'ALWAYS', 'SERVERPAGEVIEW']);

// What a buyer would call each trigger type.
const TRIGGER_LABEL = {
  PAGEVIEW:'page view', DOMREADY:'page view', WINDOWLOADED:'page view',
  SERVERPAGEVIEW:'page view', INIT:'initialization',
  CONSENTINIT:'initialization', ALWAYS:'every page',
  CLICK:'click', LINKCLICK:'click', FORMSUBMISSION:'form submit',
  ELEMENTVISIBILITY:'element visible', SCROLLDEPTH:'scroll',
  TIMER:'timer', HISTORYCHANGE:'history change',
  CUSTOMEVENT:'custom event', YOUTUBEVIDEO:'video', JSERROR:'JS error',
};
function triggerLabel(trig){
  const k = _norm(trig && trig.type);
  return TRIGGER_LABEL[k] || (k ? k.toLowerCase() : 'unknown trigger');
}

// One label per tag, so the counts add up to the tag count. A tag wired
// to both a page view and a click is reported by the page view - that is
// the one a page-load scan can say anything about.
function tagKind(t){
  const trigs = t.trigger_detail || [];
  if (!trigs.length)
    return (t.firing_triggers || []).length ? 'trigger not re-read' : 'no trigger';
  return triggerLabel(trigs.find(tr => LOAD_TRIGGERS.has(_norm(tr.type))) || trigs[0]);
}

function _urlVar(name, url){
  let u;
  try { u = new URL(url); } catch(e){ return null; }
  const k = (name || '').replace(/[{}]/g, '').trim().toLowerCase();
  if (k === 'page url' || k === 'url') return u.href;
  if (k === 'page path') return u.pathname;
  if (k === 'page hostname') return u.hostname;
  if (k === 'page query') return u.search.replace(/^\?/, '');
  if (k === 'referrer') return null;   // unknowable from a direct load
  return null;                          // dataLayer, cookie, custom JS
}

function _evalFilter(f, url){
  const left = _urlVar(f.var, url);
  if (left === null) return null;
  const right = f.value == null ? '' : String(f.value);
  let res;
  switch (_norm(f.op)){
    case 'EQUALS':     res = left === right; break;
    case 'CONTAINS':   res = left.indexOf(right) !== -1; break;
    case 'STARTSWITH': res = left.startsWith(right); break;
    case 'ENDSWITH':   res = left.endsWith(right); break;
    case 'MATCHREGEX':
      try { res = new RegExp(right).test(left); } catch(e){ return null; }
      break;
    default: return null;
  }
  return f.negate ? !res : res;
}

// The variables a trigger needs that cannot be read from a URL alone -
// dataLayer values, cookies, lookup tables, custom JS, the referrer.
// Naming them beats saying "conditions cannot be checked".
function unresolvedVars(trig, url){
  return [...new Set((trig.filters || [])
    .filter(f => _urlVar(f.var, url) === null)
    .map(f => String(f.var || '').trim())
    .filter(Boolean))];
}

// 'yes' | 'no' | 'interaction' | 'unknown' - conditions are ANDed
function triggerFiresOn(trig, url){
  if (!LOAD_TRIGGERS.has(_norm(trig.type))) return 'interaction';
  const filters = trig.filters || [];
  if (!filters.length) return 'yes';
  let unknown = false;
  for (const f of filters){
    const r = _evalFilter(f, url);
    if (r === null) { unknown = true; continue; }
    if (r === false) return 'no';
  }
  return unknown ? 'unknown' : 'yes';
}

// How a tag relates to the pages that were actually scanned.
function tagExpectation(tag, urls){
  const trigs = tag.trigger_detail || [];
  // An audit cached before trigger detail was captured has names but no
  // definitions. That is not the same as having no trigger, so say so
  // rather than reporting the tag as dead.
  if (!trigs.length)
    return (tag.firing_triggers || []).length ? 'stale-audit' : 'no-trigger';
  let best = 'interaction';
  for (const t of trigs){
    for (const u of urls){
      const r = triggerFiresOn(t, u);
      if (r === 'yes') return 'expected';
      if (r === 'unknown') best = 'unknown';
      else if (r === 'no' && best === 'interaction') best = 'other-pages';
    }
  }
  return best;
}

function containerAuditHtml(r, allResults){
  const byUrl = AUDIT_BY_URL[r.url] || AUDIT_BY_URL[_rootDomain(r.url)];
  // dedupe: a container found on the page can also match by domain
  const ids = [...new Set([...(((r.gtm || {}).container_ids) || []),
                           ...(byUrl ? [byUrl] : [])])];
  const found = ids.map(id => AUDITS[id]).filter(a => a && a.status === 'ok');
  if (!found.length) return '';
  return found.map(a => {
    const tags = a.tags || [];
    // An empty container is a finding in its own right, not a blank
    // section: it means the tags are somewhere else - hardcoded in the
    // theme, or in a different container than the one named for this
    // client - or were never deployed.
    if (!tags.length){
      // Matched by name, not seen on the page: this is a Vici-named
      // container that may have nothing to do with the live site. The
      // usual cause is a client who moved to their own container and
      // was given standalone pixels - so do not imply the site is
      // untagged.
      const guessed = !((r.gtm || {}).container_ids || []).length;
      return `<h3>Container configuration</h3>
      <div class="cm-note warn">&#9888; <b>${a.public_id} is empty</b> &mdash; no tags, triggers or variables, and it has never been published with any${a.version_name === 'Empty Container' ? 'thing' : ' content'}. ${guessed
        ? 'This container was matched by name, not observed on the page, so it may be a leftover: the site is most likely running the client\'s own container, which Vici has no access to, or pixels placed directly in the page.'
        : 'Whatever is firing on this site is not coming from this container.'}</div>`;
    }
    const gated = tags.filter(t => t.consent_status === 'NEEDED').length;
    const known = tags.filter(t => t.vendor);
    // One row per product, not per tag: eleven Mobile tags is a single
    // fact about the container, and eleven rows buries it.
    const groups = [];
    const byLabel = {};
    for (const t of known){
      const label = VENDOR_PRODUCT[t.vendor] || t.vendor;
      if (!byLabel[label]) { byLabel[label] = {label, tags: []}; groups.push(byLabel[label]); }
      byLabel[label].tags.push(t);
    }
    const seen = observedVendors(allResults || [r]);
    const urls = (allResults || [r]).map(x => x.url).filter(Boolean);
    // "Not seen firing" is only a finding if a page actually loaded. A
    // positive sighting still counts on a blocked scan - something was
    // observed - but an absence is the block talking.
    const usable = (allResults || [r]).some(x => !x.inconclusive && !x.pending);
    const rows = groups.map(grp => {
      const n = grp.tags.length;
      const gatedN = grp.tags.filter(t => t.consent_status === 'NEEDED').length;
      const cls = gatedN === n ? 'ok' : gatedN ? 'warn' : 'bad';
      const label = gatedN === n ? 'gated' : gatedN ? `${gatedN}/${n} gated` : 'not gated';
      const notes = [`${n} tag${n === 1 ? '' : 's'}`];
      // Vendors that map to a product are never named - the buyer
      // thinks in products, and the DSP is not theirs to see.
      const vendors = [...new Set(grp.tags.map(t => t.vendor))]
        .filter(v => !VENDOR_PRODUCT[v] && v !== grp.label);
      if (vendors.length) notes.push(vendors.join(', '));
      const paused = grp.tags.filter(t => t.paused).length;
      if (paused) notes.push(`${paused} paused`);
      const fired = grp.tags.some(t => seen.has(t.vendor));
      // Lead with the trigger mix - "6 click, 2 page view" is the shape
      // of the container, and it explains the expectation counts that
      // follow without spelling each one out.
      const kinds = {};
      grp.tags.forEach(t => { const k = tagKind(t); kinds[k] = (kinds[k] || 0) + 1; });
      Object.entries(kinds).sort((a, b) => b[1] - a[1])
        .forEach(([k, c]) => notes.push(`<b>${c}</b> ${k}`));
      // Split the tags by what a page-load scan could have seen, so a
      // click-triggered tag is not reported as missing.
      const by = {};
      grp.tags.forEach(t => { const k = tagExpectation(t, urls); by[k] = (by[k] || 0) + 1; });
      if (by['expected'])
        notes.push(`<b>${by['expected']} should fire here</b> - ${fired ? 'confirmed firing'
          : usable ? '<b>not seen firing</b>' : 'not tested, the page never loaded'}`);
      if (by['other-pages']) notes.push(`${by['other-pages']} ${by['other-pages'] === 1 ? 'targets' : 'target'} other pages`);
      if (by['unknown']){
        // Name the variables rather than saying "conditions" - the buyer
        // can look them up in the container.
        const vars = [...new Set(grp.tags.flatMap(t =>
          (t.trigger_detail || []).flatMap(tr => unresolvedVars(tr, urls[0] || ''))))];
        notes.push(`${by['unknown']} need${by['unknown'] === 1 ? 's' : ''} ${vars.length ? vars.slice(0, 2).join(', ') : 'values'}, which the scan cannot read`);
      }
      // Per-tag detail behind a toggle: the trigger name is what tells a
      // buyer whether a tag fires on load or on a click, which is the
      // difference between "not firing" and "not firing yet".
      const detail = grp.tags.map(t => {
        const trig = (t.firing_triggers || []).length
          ? t.firing_triggers.join(', ') : 'no firing trigger';
        const kind = tagKind(t);
        const state = tagExpectation(t, urls);
        const vars = [...new Set((t.trigger_detail || [])
          .flatMap(tr => unresolvedVars(tr, urls[0] || '')))];
        const exp = {expected: 'fires here',
                     interaction: '',
                     'other-pages': 'targets other pages',
                     unknown: vars.length ? `needs ${vars.slice(0, 2).join(', ')}` : 'conditions cannot be checked',
                     'no-trigger': 'never fires',
                     'stale-audit': 'trigger not yet re-read'}[state];
        return `<li>${t.name} <span class="evidence">&mdash; ${trig} &middot; <b>${kind}</b>${exp ? ` &middot; ${exp}` : ''}${t.paused ? ' &middot; paused' : ''}${t.consent_status === 'NEEDED' ? ` &middot; gated: ${(t.consent_types || []).join(', ')}` : ''}</span></li>`;
      }).join('');
      return `<li><span class="badge ${cls}">${label}</span>
        <div><b>${grp.label}</b> <span class="evidence">${notes.join(' &middot; ')}</span>
        <details class="ai-proc"><summary>${n} tag${n === 1 ? '' : 's'} and ${n === 1 ? 'its' : 'their'} triggers</summary><ol>${detail}</ol></details></div></li>`;
    }).join('');
    // Tags with no vendor fingerprint are usually UI scripts, not
    // trackers - counted, not listed, so they don't read as findings.
    const other = tags.length - known.length;
    const viaDomain = byUrl === a.public_id && !(((r.gtm || {}).container_ids) || []).length;
    // Consent Mode is a Google-only mechanism, so a container full of
    // non-Google tags needs per-tag consent checks instead. Without this
    // line the Consent Mode verdict above reads as if it covered them.
    const nonGoogle = known.filter(t => !GOOGLE_VENDORS.has(t.vendor));
    const nonGoogleGated = nonGoogle.filter(t => t.consent_status === 'NEEDED').length;
    const scopeNote = nonGoogle.length
      ? `<p class="kv evidence">Consent Mode covers Google tags only. The other ${nonGoogle.length} tag${nonGoogle.length === 1 ? '' : 's'} ${nonGoogle.length === 1 ? 'has' : 'have'} to be gated by a per-tag consent check in GTM &mdash; <b>${nonGoogleGated ? `${nonGoogleGated} of ${nonGoogle.length} ${nonGoogleGated === 1 ? 'does' : 'do'}` : 'none do'}</b>.</p>`
      : '';
    // The denied/granted values themselves live in the page and need a
    // successful load. What the container can answer on its own is
    // whether anything is installed to set them at all - a tag on the
    // Consent Initialization trigger - so a blocked scan is not
    // completely silent on Consent Mode.
    const initTags = tags.filter(t => (t.trigger_detail || [])
      .some(tr => _norm(tr.type) === 'CONSENTINIT'));
    const initNote = Object.keys(r.consent_defaults || {}).length ? ''
      : initTags.length
      ? `<p class="kv evidence">&#10003; <b>${initTags.length} tag${initTags.length === 1 ? '' : 's'} fire${initTags.length === 1 ? 's' : ''} on Consent Initialization</b> (${initTags.slice(0, 3).map(t => t.name).join(', ')}), so this container does set Consent Mode defaults. Whether they are set to <b>denied</b> is in the page, which this scan could not read.</p>`
      : `<p class="kv evidence">&#9888; <b>No tag fires on Consent Initialization</b>, so nothing in this container sets Consent Mode defaults. That is only half the picture &mdash; a CMP plugin can set them directly in the page, outside GTM, which is common on WordPress. A successful scan is needed to confirm.</p>`;
    return `<h3>Container configuration${a._age_days > 1 ? ` <span class="evidence">(read ${Math.round(a._age_days)} days ago)</span>` : ''}</h3>
      ${viaDomain ? `<div class="cm-note ok">Our scan was blocked, so nothing below is observed behaviour. The site's GTM container was found by name and read directly through the Tag Manager API &mdash; this is how it is configured, not what it did.</div>` : ''}
      <p class="kv">${a.public_id} &middot; <b>${tags.length}</b> tag${tags.length === 1 ? '' : 's'}, <b>${gated}</b> with consent checks configured${other ? ` &middot; ${other} with no vendor fingerprint (usually UI scripts, not trackers)` : ''}</p>
      ${scopeNote}
      ${initNote}
      ${rows ? `<ul>${rows}</ul>` : ''}`;
  }).join('');
}

function stateChecksHtml(r){
  // A blocked page finds no privacy policy link and contacts no
  // trackers on the GPC pass - both look like findings and neither is.
  if (r.inconclusive || r.pending) return '';
  if (!(r.state_checks || []).length) return '';
  // combine rows where the same check+status+detail applies to several
  // states (detail differs only by the state name in "...for X
  // targeting") - one row, one tag per state
  const NAME_RE = /for [A-Z][A-Za-z .]+ targeting/g;
  const groups = [];
  const byKey = {};
  for (const c of r.state_checks){
    const key = c.check + '|' + c.status + '|' + (c.detail || '').replace(NAME_RE, 'for # targeting');
    if (byKey[key]) { byKey[key].states.push(c.state); }
    else { byKey[key] = {states: [c.state], check: c.check, status: c.status, detail: c.detail || ''}; groups.push(byKey[key]); }
  }
  return `<h3>State checks</h3><ul>` + groups.map(g => {
    const cls = g.status==='fail'?'bad':g.status==='pass'?'ok':'warn';
    const tags = g.states.map(s => `<span class="badge ${cls}">${s} ${g.status}</span>`).join(' ');
    const detail = g.states.length > 1
      ? g.detail.replace(NAME_RE, `for ${g.states.join(' & ')} targeting`)
      : g.detail;
    return `<li>${tags}
      <div><b>${g.check}</b> <span class="evidence">${detail}</span></div></li>`;
  }).join('') + `</ul>`;
}

// Share links go to clients, who shouldn't see which DSPs sit behind a
// Vici product. Masks only Vici product component pixels - the
// client's own tags in Other pixels keep their real names.
const SHARE_MASK = () => typeof SHARE_MODE !== 'undefined' && SHARE_MODE;
function maskMap(r){
  const m = {};
  if (!SHARE_MASK()) return m;
  for (const p of (r.products || [])){
    // Only bundled products hide DSP names. A single-pixel product is
    // the client's own platform (Meta Pixel, TikTok Pixel) - masking
    // that would be confusing, not discreet.
    if ((p.pixels || []).length < 2) continue;
    let n = 0;
    for (const px of (p.pixels || [])) m[px.name] = `${p.product} DSP tag ${++n}`;
  }
  return m;
}

function cmpEvidenceHtml(r){
  // Site-level: which CMP, how it was identified, and its consent
  // trigger event. Rendered once in the client summary.
  if (!(r.cmps || []).length) return '';
  // A positive hit survives a failed scan - something answered to the
  // signature, so the CMP really is installed. What does not survive is
  // any reading of absence, or of behaviour. Every other block on an
  // inconclusive scan suppresses itself; this one states a fact, so it
  // needs to say how far that fact reaches.
  const caveat = r.inconclusive
    ? `<div class="cm-note warn">&#9888; The page never loaded properly, so this is identification only &mdash; it confirms what is installed and nothing more. Whether the banner actually gates anything was not tested, and anything <i>not</i> listed here may simply never have been reached.</div>`
    : '';
  return `<h3>CMP evidence</h3>${caveat}<ul>` + r.cmps.map(c =>
    `<li><div><b>${c.name}</b> <span class="evidence"${tipAttr('cmp-evidence')}>${(c.evidence||[]).join(' &middot; ')}</span>
      ${c.notes ? `<div class="evidence">${c.notes}</div>` : ''}
      ${c.gtm_event ? `<div class="evidence">Consent trigger event: <span class="pill">${c.gtm_event}</span></div>` : ''}</div></li>`).join('') + `</ul>`;
}

function cmpDiffHtml(r, siteNames){
  // Only speaks up when this page's consent setup differs from the
  // rest of the site - a page missing the banner is a real finding.
  if (!siteNames) return '';
  const mine = (r.cmps || []).map(c => c.name).sort();
  const site = siteNames.slice().sort();
  if (mine.join('|') === site.join('|')) return '';
  const label = a => a.length ? a.join(', ') : 'none detected';
  return `<h3>Consent setup differs on this page</h3><p class="kv">This page: <b>${label(mine)}</b> &middot; rest of the site: <b>${label(site)}</b>.</p>`;
}

function chainFor(r, opts){
  // Every cell in the strip describes observed behaviour. On a page
  // that never loaded, "no CMP" and "no pre-consent trackers" are the
  // block talking - and the second one renders green, which reads as a
  // pass on a site nothing is known about.
  if (r.inconclusive || r.pending) return '';
  const withStates = !(opts && opts.states === false);
  const cmpNames = r.cmps.map(c => c.name).join(', ');
  // No banner is a finding where a state expects an accessible opt-out.
  // With no state targeting set, it is a note, not a failure.
  // A notice-only bar is detected tech but not a consent mechanism, so
  // it must not read green. Where a state expects an accessible
  // opt-out it is a failure; with no state targeting it is a note.
  const realCmps = r.cmps.filter(c => c.name !== 'Notice-only banner');
  const cmpState = realCmps.length ? 'pass'
                 : !r.ok ? 'mid'
                 : (r.states || []).length ? 'fail' : 'mid';
  const bannerState = r.banner_visible === true ? 'pass'
                    : r.banner_visible === false ? 'fail' : 'mid';
  const cmState = r.consent_mode_default === true
                ? ((r.cmps || []).length ? 'pass' : 'fail')
                : r.consent_mode_default === false ? 'fail' : 'mid';
  const viol = r.pre_consent.filter(h => h.severity === 'violation');
  const warns = r.pre_consent.filter(h => h.severity === 'warn');
  // Ungated hits are real fires - the finding is the missing CMP, not
  // the tag, but the cell must not read "None" while pixels run free.
  const ungated = r.pre_consent.filter(h => h.severity === 'ungated');
  const fired = viol.length + ungated.length;
  const fireState = viol.length ? 'fail'
                  : (ungated.length || warns.length) ? 'mid'
                  : (r.mode === 'full' ? 'pass' : 'mid');
  const fireLabel = r.mode !== 'full' ? 'Unknown'
                  : fired ? `${fired} firing` : (warns.length ? 'Verify' : 'None');
  const prods = r.products || [];
  const missing = prods.filter(p => p.fired === 0);
  const partial = prods.filter(p => p.fired > 0 && p.fired < p.expected);
  const prodState = r.mode !== 'full' ? 'mid'
                  : missing.length ? 'fail'
                  : partial.length ? 'mid'
                  : prods.length ? 'pass' : 'mid';
  const prodLabel = r.mode !== 'full' ? 'Unknown'
                  : !prods.length ? (r.accept_clicked ? 'None seen' : 'Unverified')
                  : prods.map(p => p.expected > 1 ? `${p.product} ${p.fired}/${p.expected}` : p.product).join(', ');
  const rejViol = (r.post_reject || []).filter(h => h.severity === 'violation');
  const rejState = !r.reject_tested ? 'mid' : rejViol.length ? 'fail' : 'pass';
  const rejLabel = r.site_checks_skipped ? 'See main site'
      : !r.reject_tested
      ? (r.cmps.length && r.banner_visible === true ? 'No reject option' : 'Untested')
      : rejViol.length ? `${rejViol.length} firing` : 'Yes';
  const scFails = (r.state_checks||[]).filter(c => c.status === 'fail');
  const scState = !(r.states||[]).length ? 'mid' : scFails.length ? 'fail'
                : (r.state_checks||[]).length ? 'pass' : 'mid';
  const scLabel = scFails.length ? `${scFails.length} failing`
                : (r.state_checks||[]).length ? 'Passing' : 'Untested';
  const fmt = v => v === true ? 'Yes' : v === false ? 'No' : 'Unknown';
  // Without a CMP, the banner/consent-mode/reject cells are pure noise
  // (Unknown / No / Untested) - hide them and let the red CMP cell own
  // the story. Exception: Consent Mode defaults set to denied is real
  // signal even without a recognized CMP, so a true value stays.
  const noCmp = r.ok && !r.cmps.length;
  return `<div class="chain">
      ${chainLink('CMP', r.cmps.length ? cmpNames : (r.ok ? 'None found' : 'Unknown'), cmpState)}
      ${noCmp ? '' : chainLink('Banner visible', fmt(r.banner_visible), bannerState)}
      ${noCmp && r.consent_mode_default !== true ? '' : chainLink('Consent Mode default', fmt(r.consent_mode_default), cmState)}
      ${chainLink('Pre-consent trackers', fireLabel, fireState)}
      ${noCmp ? '' : chainLink('Reject honored', rejLabel, rejState)}
      ${chainLink('Product pixels', prodLabel, prodState)}
      ${withStates && (r.states||[]).length ? chainLink('State checks', scLabel, scState) : ''}
    </div>`;
}

// Tags whose triggers match THIS page, with whether the product was
// observed firing on it. The container summary says what exists; this
// says what should have happened on the page in front of you.
function pageTagsHtml(r){
  // Which of the container's tags target THIS url. That comes from the
  // Tag Manager API, not from the page, so it survives a blocked scan.
  // What does not survive is any claim about whether they fired.
  const named = AUDIT_BY_URL[r.url] || AUDIT_BY_URL[_rootDomain(r.url)];
  const ids = [...new Set([...(((r.gtm || {}).container_ids) || []),
                           ...(named ? [named] : [])])];
  const audits = ids.map(id => AUDITS[id]).filter(a => a && a.status === 'ok');
  if (!audits.length || r.pending) return '';
  const usable = !r.inconclusive;
  const blockedNote = usable ? ''
    : `<p class="kv evidence">Our scan was blocked, so this is what the container is <b>configured</b> to do on this page &mdash; not what happened.</p>`;
  const seen = observedVendors([r]);
  const groups = [];
  const byLabel = {};
  const all = [];
  for (const a of audits)
    for (const t of (a.tags || [])){
      if (!t.vendor) continue;
      all.push(t);
      if (tagExpectation(t, [r.url]) !== 'expected') continue;
      const label = VENDOR_PRODUCT[t.vendor] || t.vendor;
      if (!byLabel[label]) { byLabel[label] = {label, tags: [], fired: false}; groups.push(byLabel[label]); }
      byLabel[label].tags.push(t);
      if (seen.has(t.vendor)) byLabel[label].fired = true;
    }
  // Rendering nothing here reads as "not built" rather than "nothing to
  // report" - and the two look identical. Say which, and why.
  if (!groups.length){
    if (!all.length) return '';
    const by = {};
    all.forEach(t => { const k = tagExpectation(t, [r.url]); by[k] = (by[k] || 0) + 1; });
    const parts = [];
    const s = n => n === 1 ? 's' : '';
    if (by['interaction']) parts.push(`${by['interaction']} fire${s(by['interaction'])} on interaction`);
    if (by['other-pages']) parts.push(`${by['other-pages']} target${s(by['other-pages'])} other pages`);
    if (by['unknown']) parts.push(`${by['unknown']} depend${s(by['unknown'])} on values the scan cannot read`);
    if (by['no-trigger']) parts.push(`${by['no-trigger']} ha${by['no-trigger'] === 1 ? 's' : 've'} no firing trigger`);
    if (by['stale-audit']) parts.push(`${by['stale-audit']} not yet re-read`);
    return `<h3>Container tags set to fire on this page</h3>${blockedNote}
      <p class="kv"><b>None.</b> Of the ${all.length} vendor tag${all.length === 1 ? '' : 's'} in the container${parts.length ? `, ${parts.join(', ')}` : ''}. Nothing here is missing - the container simply does not target this page.</p>`;
  }
  const rows = groups.map(g => {
    const n = g.tags.length;
    const list = g.tags.map(t =>
      `<li>${t.name} <span class="evidence">&mdash; ${(t.firing_triggers || []).join(', ') || 'no trigger'} &middot; <b>${tagKind(t)}</b></span></li>`).join('');
    const badge = !usable ? `<span class="badge neutral">not tested</span>`
      : g.fired ? `<span class="badge ok">firing</span>`
      : `<span class="badge bad">not seen firing</span>`;
    return `<li>${badge}
      <div><b>${g.label}</b> <span class="evidence">${n} tag${n === 1 ? '' : 's'} set to fire on this page</span>
      <ol style="margin:4px 0 0 18px;padding:0;font-size:12.5px">${list}</ol></div></li>`;
  }).join('');
  return `<h3>Container tags set to fire on this page</h3>${blockedNote}<ul>${rows}</ul>`;
}

function renderSite(r, i, site){
  const meta = VERDICT_META[r.verdict] || VERDICT_META.error;
  const prods = r.products || [];
  const chain = chainFor(r, {states: false});

  const kvBits = [];
  const g = r.gtm || {};
  if (g.found)
    kvBits.push(`<span class="kv">GTM: <b>${(g.container_ids || []).join(', ') || 'container present, ID not detected'}</b></span>`);
  else if (g.gtag_only)
    kvBits.push(`<span class="kv"${tipAttr('gtag-only')}>No Tag Manager container - <b>gtag.js only${(g.gtag_ids || []).length ? ` (${g.gtag_ids.join(', ')})` : ''}</b></span>`);
  // Consent Mode defaults are stated once in the client summary; the
  // page only speaks up when its own defaults differ.
  const defStr = o => Object.entries(o || {}).sort().map(([k, v]) => `${k}=${v}`).join(', ');
  const mineDef = defStr(r.consent_defaults), siteDef = site ? defStr(site.consent_defaults) : mineDef;
  if (mineDef !== siteDef)
    kvBits.push(`<span class="kv"${tipAttr('defaults')}>Consent Mode defaults differ on this page: <b>${mineDef || 'none'}</b></span>`);
  else if (!site && mineDef)
    kvBits.push(`<span class="kv"${tipAttr('defaults')}>Defaults: <b>${mineDef}</b></span>`);

  const cmpDetail = pageTagsHtml(r) + cmpDiffHtml(r, site && (site.cmps || []).map(c => c.name));

  const preViol = (r.pre_consent || []).filter(h => h.severity === 'violation').length;
  // group hits that belong to a selected product under the product name
  // (full per-pixel detail stays in the Product pixels section)
  const mask = maskMap(r);
  const hasGtm = !!(r.gtm && r.gtm.found);
  const pixToProd = {};
  for (const p of (r.products || []))
    for (const px of (p.pixels || [])) pixToProd[px.name] = p.product;
  const grouped = [];
  const prodAgg = {};
  for (const h of r.pre_consent || []){
    const prod = h.product || pixToProd[h.vendor];
    if (prod){
      if (!prodAgg[prod]){ prodAgg[prod] = {vendor: prod, severity: h.severity, count: 0, agg: true, srcAgg: h.src, contAgg: h.containers || []}; grouped.push(prodAgg[prod]); }
      prodAgg[prod].count++;
      if (prodAgg[prod].srcAgg !== h.src) prodAgg[prod].srcAgg = null;
      // component pixels in different containers can't be rolled up
      if (prodAgg[prod].contAgg.join() !== (h.containers || []).join()) prodAgg[prod].contAgg = [];
      if (h.severity === 'violation') prodAgg[prod].severity = 'violation';
    } else grouped.push(h);
  }
  const fires = grouped.length ? `<h3>Other pixels${preViol ? ` <span class="badge bad">${preViol} pre-consent</span>` : ''}</h3><ul>` + grouped.map(h =>
      h.agg
      ? `<li><span class="badge ${h.severity==='violation'?'bad':h.severity==='warn'?'warn':'neutral'}"${h.severity==='violation' ? tipAttr('violation') : tipAttr('ungated')}>${h.severity === 'ungated' ? 'ungated' : h.severity}</span>
        <div><b>${h.vendor}</b>${srcTag(h.srcAgg, h.contAgg, hasGtm)} <span class="evidence">${h.count} component pixel${h.count>1?'s':''} - per-pixel detail in Product pixels above</span></div></li>`
      : `<li><span class="badge ${h.severity==='violation'?'bad':h.severity==='warn'?'warn':'neutral'}"${h.severity==='ungated' ? tipAttr('ungated') : h.severity==='violation' ? tipAttr('violation') : ''}>${h.severity === 'ungated' ? 'ungated' : h.severity}</span>
        <div><b>${mask[h.vendor] || h.vendor}</b>${srcTag(h.src, h.containers, hasGtm)} <span class="evidence">${h.note}</span><div class="u">${h.url}</div></div></li>`).join('') + `</ul>`
    : (r.mode === 'full' && r.ok ? `<h3>Other pixels</h3><p class="kv">No known ad/analytics endpoints were contacted before consent on this page.</p>` : '');

  const hasCmp = (r.cmps || []).length > 0;
  // A product pixel firing pre-consent is the same finding as any
  // other tracker doing it, so grade it with the scanner's severity
  // rather than a separate product-only scale. pre_consent is sorted
  // worst-first, so the first hit per vendor is the one that counts.
  const pxBadge = px => {
    if (!px.fired_pre && !px.fired_post)
      return px.configured === true
        ? `<span class="badge warn"${tipAttr('configured-silent')}>configured, not firing</span>`
        : px.configured === false
        ? `<span class="badge bad"${tipAttr('not found')}>not found</span>`
        : `<span class="badge bad"${tipAttr('not seen')}>not seen</span>`;
    const sev = px.fired_pre ? px.severity : null;
    if (sev === 'violation') return `<span class="badge bad"${tipAttr('violation')}>violation</span>`;
    if (sev === 'warn') return `<span class="badge warn">warn</span>`;
    if (sev === 'info') return `<span class="badge neutral">info</span>`;
    if (sev === 'ungated') return `<span class="badge neutral"${tipAttr('ungated-pixel')}>ungated</span>`;
    return px.fired_pre && !px.fired_post
      ? (hasCmp
          ? `<span class="badge warn"${tipAttr('pre-consent only')}>pre-consent only</span>`
          : `<span class="badge neutral"${tipAttr('ungated-pixel')}>ungated</span>`)
      : (px.fired_pre ? `<span class="badge ok"${tipAttr('pre + post')}>pre + post</span>` : `<span class="badge ok"${tipAttr('post-consent')}>post-consent</span>`);
  };
  const dspDetail = (r.mode === 'full' && r.ok) ? `<h3>Product pixels</h3>` + (prods.length ? prods.map(p => {
      const stateBadge = p.fired === 0 ? `<span class="badge bad"${tipAttr('missing')}>missing</span>`
                       : p.fired < p.expected ? `<span class="badge warn"${tipAttr('partial')}>partial</span>`
                       : `<span class="badge ok"${tipAttr('firing')}>firing</span>`;
      const countPill = p.expected > 1 ? ` <span class="pill">${p.fired}/${p.expected}</span>` : '';
      // Share links collapse a multi-pixel product to one bundle row -
      // clients get the count and the status, not the DSP roster.
      if (SHARE_MASK() && (p.pixels || []).length > 1){
        const sev = ['violation','warn','ungated','info'].find(s => p.pixels.some(x => x.severity === s));
        const bundle = {name: 'DSP bundle', severity: sev,
          fired_pre: p.pixels.some(x => x.fired_pre),
          fired_post: p.pixels.some(x => x.fired_post),
          configured: p.pixels.every(x => x.configured === false) ? false : undefined};
        return `<div class="prodflat"><div class="prodhead"><b>${p.product}</b>${countPill} ${stateBadge}</div>
       <ul><li>${pxBadge(bundle)}<div><b>DSP bundle</b></div></li></ul></div>`;
      }
      return `<div class="prodflat"><div class="prodhead"><b>${p.product}</b>${countPill} ${stateBadge}</div>
       <ul>` + p.pixels.map(px =>
        `<li>${pxBadge(px)}<div><b>${mask[px.name] || px.name}</b>${srcTag(px.src, px.containers, hasGtm)}${(() => {
          const sev = px.fired_pre ? px.severity : null;
          if ((sev === 'warn' || sev === 'info') && px.severity_note) return ` <span class="evidence">${px.severity_note}</span>`;
          return px.fired_pre && !px.fired_post ? ` <span class="evidence">${hasCmp ? 'working, but should be consent-gated' : 'working - would need consent-gating if a banner is added'}</span>` : '';
        })()}
         ${px.sample_url ? `<div class="u">${px.sample_url}</div>` : ''}</div></li>`).join('') + `</ul></div>`;
    }).join('')
    : `<p class="kv">${r.accept_clicked ? 'No product pixels observed on this page, before or after accept.' : 'Accept could not be clicked, so post-consent firing could not be verified on this page.'}</p>`) : '';

  // hardcoded-pixel remediation: when a page HAS a CMP but pixels fire
  // before consent or after reject, they're bypassing it - almost
  // always hardcoded in the page <head>. Offer the three fix paths,
  const rejFires = (r.post_reject || []).length ? `<h3>Requests after Reject</h3><ul>` + r.post_reject.map(h =>
      `<li><span class="badge ${h.severity==='violation'?'bad':'warn'}">${h.severity}</span>
        <div><b>${mask[h.vendor] || h.vendor}</b>${srcTag(h.src, h.containers, hasGtm)} <span class="evidence">${h.note}</span><div class="u">${h.url}</div></div></li>`).join('') + `</ul>`
    : (r.reject_tested ? `<h3>Requests after Reject</h3><p class="kv">No trackers fired after Reject - the decline path is honored.</p>` : '');

  const gated = (r.post_consent || []).length ? `<h3>Fired after accept (gated correctly)</h3><ul>` + r.post_consent.map(h =>
      `<li><span class="badge ok"${tipAttr('post-consent')}>post-consent</span><div><b>${mask[h.vendor] || h.vendor}</b><div class="u">${h.url}</div></div></li>`).join('') + `</ul>` : '';

  const missingProds = prods.filter(p => p.fired === 0);
  const rejV = (r.post_reject || []).some(h => h.severity === 'violation');
  const headBadges = [
    rejV ? `<span class="badge bad"${tipAttr('fires after reject')}>fires after reject</span>` : '',
    r.verdict === 'misconfigured' && !rejV ? `<span class="badge bad"${tipAttr('pre-consent fires')}>pre-consent fires</span>` : '',
    (missingProds.length && !r.inconclusive && !r.pending) ? `<span class="badge bad"${tipAttr('pixels missing')}>pixels missing</span>` : '',
    r.pending ? `<span class="badge neutral"${tipAttr('still running')}>still running</span>` : '',
    r.verdict === 'error' ? `<span class="badge warn"${tipAttr('scan error')}>scan error</span>` : '',
    (r.mode && r.mode !== 'full' && !r.pending) ? `<span class="badge neutral">${r.mode}</span>` : '',
  ].join('');
  // Nothing loaded, so every product reads 0/n - that is the block
  // talking, not the site. Show the reason instead.
  const prodStat = (r.inconclusive || r.pending) ? '' : prods.map(p => {
    const count = p.expected > 1 ? ` ${p.fired}/${p.expected}` : '';
    const cls = p.fired === 0 ? 'bad' : p.fired < p.expected ? 'warn' : 'ok';
    const mark = p.fired === 0 ? '&#10007;' : '&#10003;';
    return `<span class="pstat ${cls}">${p.product}${count} ${mark}</span>`;
  }).join('');
  return `<div class="site" id="site-${i}">
    <div class="site-head" onclick="this.parentElement.classList.toggle('open')">
      ${headBadges}
      <span class="site-url">${r.url}</span>
      ${prodStat}
      <span class="scanned">${r.scanned_local || r.scanned_at || ''}</span>
      <span class="caret">&#9654;</span>
    </div>
    <div class="site-body">
      ${r.pending || r.verdict === 'error' || r.mode !== 'full' ? `<div class="verdict ${meta.cls}">${(r.verdict_lines && r.verdict_lines.length ? r.verdict_lines : [r.verdict_detail || r.error || '']).map(l => `<div class="vline">${l}</div>`).join('')}</div>` : ''}
      ${kvBits.length ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px;align-items:center">${kvBits.join('')}</div>` : ''}
      <div class="detail">${cmpDetail}${rejFires}${dspDetail}${fires}${gated}</div>
    </div>
  </div>`;
}

const VERDICT_RANK = {error:0, no_cmp:0, misconfigured:0, cmp_found_basic:1, pending:1, ok:2};

function groupBadge(items){
  let worst = 2;
  items.forEach(({r}) => { worst = Math.min(worst, VERDICT_RANK[r.verdict] ?? 0); });
  const anyMissing = items.some(({r}) => !r.pending && (r.products||[]).some(p => p.fired === 0));
  const anyStateFail = items.some(({r}) => (r.state_checks||[]).some(c => c.status === 'fail'));
  if (worst === 0 || anyMissing || anyStateFail)
    return `<span class="st-ico bad" data-tip="Needs attention - open for findings and action items"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg></span>`;
  if (worst === 1)
    return `<span class="st-ico mid" data-tip="Basic scan only - full details unavailable"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/></svg></span>`;
  return `<span class="st-ico ok" data-tip="Looks good - no findings on the latest run"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.2 12.4 2.6 2.6 5-5.4"/></svg></span>`;
}

function mainItem(g){
  // main site = shortest normalized URL in the run (root beats inner pages)
  return g.items.reduce((best, it) =>
    normUrl(it.r.url).length < normUrl(best.r.url).length ? it : best, g.items[0]);
}
