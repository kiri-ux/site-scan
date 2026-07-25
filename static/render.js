const TIPS = {
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

function ownerBadge(owner){
  if (owner === 'VICI') return `<span class="ob ob-vici" data-tip="Vici-side change - the buyer makes this fix directly">VICI</span>`;
  if (owner === 'CLIENT') return `<span class="ob ob-ext" data-tip="Client-side change - Vici provides the corrected snippet or spec; the client's web team installs it">CLIENT</span>`;
  return `<span class="ob ob-un" data-tip="Owner depends on who manages the tags - set Implementation (Vici-owned GTM vs Client placement) on the scan form to resolve">SET IMPLEMENTATION</span>`;
}

function actionItemsHtml(rs, impl){
  if (!rs || !rs.length) return '';
  const pixOwner = impl === 'Vici-owned GTM' ? 'VICI' : impl === 'Client placement' ? 'CLIENT' : 'UNSET';
  const main = rs.slice().sort((a,b) => (a.url||'').length - (b.url||'').length)[0];
  const items = [];
  const push = (owner, text) => items.push({owner, text});

  // product pixels missing anywhere
  const missing = [...new Set(rs.flatMap(r => (r.products||[]).filter(p => p.fired === 0).map(p => p.product)))];
  if (missing.length) push(pixOwner, `Install or repair the ${missing.join(', ')} pixel${missing.length>1?'s':''} - expected but not seen on any scanned page.` + (pixOwner==='CLIENT' ? ' Vici supplies the pixel code.' : ''));

  const hasCmp = (main.cmps||[]).length > 0;
  // no CMP: what the LAW requires is a working opt-out method - a
  // banner is the recommended delivery, never the requirement itself
  const mechFail = (main.state_checks || []).some(c => c.check === 'Opt-out mechanism' && c.status === 'fail');
  if (!hasCmp && main.ok && main.mode === 'full'){
    if (mechFail){
      const mechStates = (main.state_checks || []).filter(c => c.check === 'Opt-out mechanism' && c.status === 'fail').map(c => c.state);
      const followUp = pixOwner === 'VICI'
        ? 'Once one is in place, Vici applies the GTM consent procedure.'
        : pixOwner === 'CLIENT'
        ? "Once one is in place, Vici provides the GTM consent procedure for the client's team to apply."
        : 'Once one is in place, the GTM consent procedure gates the pixels (owner per Implementation).';
      push('CLIENT', `Give residents a working opt-out method - required for ${mechStates.join(' & ')} targeting and currently absent (no banner, no opt-out link, GPC not honored). Recommended fix: a consent banner (CMP), which delivers the opt-out link, GPC handling, and pixel gating in one install - the law requires the opt-out, not the banner itself. ${followUp}${GTM_PROCEDURE}`);
    } else {
      const followUp2 = pixOwner === 'VICI'
        ? 'Vici applies the GTM consent procedure once one is in place.'
        : pixOwner === 'CLIENT'
        ? "Vici provides the GTM consent procedure for the client's team to apply once one is in place."
        : 'The GTM consent procedure gates the pixels once one is in place.';
      push('CLIENT', `Recommended (not required): install a consent banner (CMP) to gate pixels and cover current and future state targeting. ${followUp2}${GTM_PROCEDURE}`);
    }
  }
  // consent-gating for product pixels (only meaningful once a CMP exists)
  const preOnly = [...new Set(rs.flatMap(r => (r.products||[]).filter(p => (p.pixels||[]).some(px => px.fired_pre && !px.fired_post)).map(p => p.product)))];
  if (hasCmp && preOnly.length) push(pixOwner, `Consent-gate ${preOnly.join(', ')} - firing before consent despite the banner.` + (pixOwner==='CLIENT' ? ' Vici provides consent-wrapped snippets or GTM tag exports to reinstall.' : ''));

  // hardcoded bypassers on CMP pages
  const bypass = [...new Set(rs.flatMap(r => {
    if (!(r.cmps||[]).length) return [];
    const p2p = {};
    for (const p of (r.products||[])) for (const px of (p.pixels||[])) p2p[px.name] = p.product;
    return [...(r.pre_consent||[]).filter(h => h.severity==='violation'), ...(r.post_reject||[])].map(h => p2p[h.vendor] || h.vendor);
  }))];
  if (bypass.length) push('CLIENT', `Migrate or consent-wrap the hardcoded pixels bypassing the CMP (${bypass.join(', ')}) - these fire from page code, so the client's web team applies the fix; Vici provides the corrected snippets (consent-default APIs or GTM migration).`);

  // consent mode defaults
  const defs = main.consent_defaults || {};
  const defKeys = Object.keys(defs);
  const leaking = defKeys.filter(k => defs[k] !== 'denied');
  if (defKeys.length && leaking.length) push(pixOwner, `Set Consent Mode defaults to denied (${leaking.join(', ')} currently granted).` + (pixOwner==='VICI' ? ' Fixable in the GTM Consent Initialization trigger.' : ' Vici provides the default-consent block; it must load above the tags.'));
  else if (!defKeys.length && main.gtm && main.gtm.found && hasCmp) push(pixOwner, 'Add Google Consent Mode defaults (none detected) so Google tags start denied until consent.');

  // reject violations already covered by bypass on CMP pages; state/site items:
  for (const c of (main.state_checks || [])){
    if (c.status !== 'fail') continue;
    if (c.check === 'Privacy policy link') push('CLIENT', 'Add an accessible privacy policy link - none found on the page.');
    if (c.check === 'Opt-out link' && !mechFail) push('CLIENT', 'Add a "Your Privacy Choices" / opt-out link to the site footer.');
    if (c.check === 'GPC signal') push('CLIENT', 'Honor the Global Privacy Control signal - typically CMP configuration once a banner exists' + (hasCmp ? '.' : ' (part of the CMP conversation above).'));
    if (c.check === 'Health-context tracking' || c.check === 'Child-directed tracking') push('CLIENT', `${c.check.replace('-', ' ')} flagged - route to compliance review before continuing ad pixels on this client.`);
  }
  // macros: internal
  const macros = [...new Set(rs.flatMap(r => (r.products||[]).flatMap(p => (p.pixels||[]).filter(px => px.macro_warning).map(px => px.name))))];
  if (macros.length) push('VICI', `Fill trafficking macros on ${macros.join(', ')} - template values like [ORDER] unreplaced (internal trafficking fix).`);

  if (!items.length) return '';
  // dedupe identical opt-out/GPC lines that repeat per state group
  const seen = new Set();
  const rows = items.filter(it => { const k = it.owner + it.text; if (seen.has(k)) return false; seen.add(k); return true; });
  return `<h3>Action items</h3><ul class="ai">` + rows.map(it =>
    `<li>${ownerBadge(it.owner)}<div>${it.text}</div></li>`).join('') + `</ul>`;
}

function stateChecksHtml(r){
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

function chainFor(r, opts){
  const withStates = !(opts && opts.states === false);
  const cmpNames = r.cmps.map(c => c.name).join(', ');
  const cmpState = r.cmps.length ? 'pass' : (r.ok ? 'fail' : 'mid');
  const bannerState = r.banner_visible === true ? 'pass'
                    : r.banner_visible === false ? 'fail' : 'mid';
  const cmState = r.consent_mode_default === true ? 'pass'
                : r.consent_mode_default === false ? 'fail' : 'mid';
  const viol = r.pre_consent.filter(h => h.severity === 'violation');
  const warns = r.pre_consent.filter(h => h.severity === 'warn');
  const fireState = viol.length ? 'fail' : (warns.length ? 'mid' : (r.mode==='full' ? 'pass' : 'mid'));
  const fireLabel = r.mode !== 'full' ? 'Unknown'
                  : viol.length ? `${viol.length} firing` : (warns.length ? 'Verify' : 'None');
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
      ${chainLink('Product pixels', prodLabel, prodState)}
      ${noCmp ? '' : chainLink('Reject honored', rejLabel, rejState)}
      ${withStates && (r.states||[]).length ? chainLink('State checks', scLabel, scState) : ''}
    </div>`;
}

function renderSite(r, i){
  const meta = VERDICT_META[r.verdict] || VERDICT_META.error;
  const cmpNames = r.cmps.map(c => c.name).join(', ');
  const prods = r.products || [];
  const chain = chainFor(r, {states: false});

  const gtmEvent = r.cmps.map(c => c.gtm_event).find(Boolean);
  const kvBits = [];
  if (r.gtm && r.gtm.found) kvBits.push(`<span class="kv">GTM: <b>${r.gtm.container_ids.join(', ') || 'present'}</b></span>`);
  if (gtmEvent) kvBits.push(`<span class="kv">Trigger event: <span class="pill">${gtmEvent}</span></span>`);
  const defaults = Object.entries(r.consent_defaults || {});
  if (defaults.length) kvBits.push(`<span class="kv"${tipAttr('defaults')}>Defaults: <b>${defaults.map(([k,v])=>`${k}=${v}`).join(', ')}</b></span>`);

  // correctness note under the Defaults line: denied-by-default is the
  // target Consent Mode setup; granted-by-default means Google tags
  // track before consent; no defaults at all (with GTM + a CMP) means
  // Consent Mode likely isn't configured.
  let cmNote = '';
  let cmStamp = '';
  if (defaults.length) {
    const granted = defaults.filter(([k, v]) => v !== 'denied').map(([k]) => k);
    cmStamp = granted.length
      ? `<span class="cm-stamp bad"${tipAttr('defaults')}>&#10007; INCORRECT SETUP</span>`
      : `<span class="cm-stamp ok"${tipAttr('defaults')}>&#10003; CORRECT SETUP</span>`;
    cmNote = granted.length
      ? `<div class="cm-note warn">&#9888; <b>${granted.join(', ')}</b> ${granted.length > 1 ? 'are' : 'is'} granted by default - Google tags can track before the visitor consents. The target setup starts every storage type <b>denied</b> and flips to granted on Accept (this is what the GTM consent procedure installs).</div>`
      : `<div class="cm-note ok">&#10003; Correct setup: every storage type starts <b>denied</b>, so Google tags run cookieless until the visitor accepts - exactly the Consent Mode configuration the GTM consent procedure installs. No consent work needed here.</div>`;
  } else if (r.gtm && r.gtm.found && r.cmps.length) {
    cmStamp = `<span class="cm-stamp bad">&#10007; NOT CONFIGURED</span>`;
    cmNote = `<div class="cm-note warn">&#9888; No Consent Mode defaults detected in this page's GTM/gtag setup - Google tags likely run at full capability before consent even though a CMP is present. The GTM consent procedure installs denied-by-default settings.</div>`;
  }

  const cmpDetail = r.cmps.length ? `<h3>CMP evidence</h3><ul>` + r.cmps.map(c =>
      `<li><div><b>${c.name}</b> <span class="evidence"${tipAttr('cmp-evidence')}>${(c.evidence||[]).join(' &middot; ')}</span>
        ${c.notes ? `<div class="evidence">${c.notes}</div>` : ''}</div></li>`).join('') + `</ul>` : '';

  const preViol = (r.pre_consent || []).filter(h => h.severity === 'violation').length;
  // group hits that belong to a selected product under the product name
  // (full per-pixel detail stays in the Product pixels section)
  const pixToProd = {};
  for (const p of (r.products || []))
    for (const px of (p.pixels || [])) pixToProd[px.name] = p.product;
  const grouped = [];
  const prodAgg = {};
  for (const h of r.pre_consent || []){
    const prod = pixToProd[h.vendor];
    if (prod){
      if (!prodAgg[prod]){ prodAgg[prod] = {vendor: prod, severity: h.severity, count: 0, agg: true}; grouped.push(prodAgg[prod]); }
      prodAgg[prod].count++;
      if (h.severity === 'violation') prodAgg[prod].severity = 'violation';
    } else grouped.push(h);
  }
  const fires = grouped.length ? `<h3>Other pixels${preViol ? ` <span class="badge bad">${preViol} pre-consent</span>` : ''}</h3><ul>` + grouped.map(h =>
      h.agg
      ? `<li><span class="badge ${h.severity==='violation'?'bad':h.severity==='warn'?'warn':'neutral'}"${h.severity==='violation' ? tipAttr('violation') : tipAttr('ungated')}>${h.severity === 'ungated' ? 'ungated' : h.severity}</span>
        <div><b>${h.vendor}</b> <span class="evidence">${h.count} component pixel${h.count>1?'s':''} - per-pixel detail in Product pixels above</span></div></li>`
      : `<li><span class="badge ${h.severity==='violation'?'bad':h.severity==='warn'?'warn':'neutral'}"${h.severity==='ungated' ? tipAttr('ungated') : h.severity==='violation' ? tipAttr('violation') : ''}>${h.severity === 'ungated' ? 'ungated' : h.severity}</span>
        <div><b>${h.vendor}</b> <span class="evidence">${h.note}</span><div class="u">${h.url}</div></div></li>`).join('') + `</ul>`
    : (r.mode === 'full' && r.ok ? `<h3>Other pixels</h3><p class="kv">No known ad/analytics endpoints were contacted before consent on this page.</p>` : '');

  const hasCmp = (r.cmps || []).length > 0;
  const pxBadge = px => !px.fired_pre && !px.fired_post
        ? (px.configured === true
            ? `<span class="badge warn"${tipAttr('configured-silent')}>configured, not firing</span>`
            : px.configured === false
            ? `<span class="badge bad"${tipAttr('not found')}>not found</span>`
            : `<span class="badge bad"${tipAttr('not seen')}>not seen</span>`)
        : px.fired_pre && !px.fired_post
        ? (hasCmp
            ? `<span class="badge warn"${tipAttr('pre-consent only')}>pre-consent only</span>`
            : `<span class="badge neutral"${tipAttr('ungated-pixel')}>ungated</span>`)
        : (px.fired_pre ? `<span class="badge ok"${tipAttr('pre + post')}>pre + post</span>` : `<span class="badge ok"${tipAttr('post-consent')}>post-consent</span>`);
  const dspDetail = (r.mode === 'full' && r.ok) ? `<h3>Product pixels</h3>` + (prods.length ? prods.map(p => {
      const stateBadge = p.fired === 0 ? `<span class="badge bad"${tipAttr('missing')}>missing</span>`
                       : p.fired < p.expected ? `<span class="badge warn"${tipAttr('partial')}>partial</span>`
                       : `<span class="badge ok"${tipAttr('firing')}>firing</span>`;
      const countPill = p.expected > 1 ? ` <span class="pill">${p.fired}/${p.expected} firing</span>` : '';
      return `<div class="prodflat"><div class="prodhead"><b>${p.product}</b>${countPill} ${stateBadge}</div>
       <ul>` + p.pixels.map(px =>
        `<li>${pxBadge(px)}<div><b>${px.name}</b>${px.fired_pre && !px.fired_post ? ` <span class="evidence">${hasCmp ? 'working, but should be consent-gated' : 'working - would need consent-gating if a banner is added'}</span>` : ''}${px.macro_warning ? ' <span class="macro-warn">pixel URL contains unreplaced macros like [ORDER] - the template was pasted without filling values, so conversion data will be blank</span>' : ''}
         ${px.sample_url ? `<div class="u">${px.sample_url}</div>` : ''}</div></li>`).join('') + `</ul></div>`;
    }).join('')
    : `<p class="kv">${r.accept_clicked ? 'No product pixels observed on this page, before or after accept.' : 'Accept could not be clicked, so post-consent firing could not be verified on this page.'}</p>`) : '';

  // hardcoded-pixel remediation: when a page HAS a CMP but pixels fire
  // before consent or after reject, they're bypassing it - almost
  // always hardcoded in the page <head>. Offer the three fix paths,
  // tailored to the vendors actually caught.
  const bypassers = [...(r.pre_consent || []).filter(h => h.severity === 'violation'),
                     ...(r.post_reject || [])];
  let fixNote = '';
  if (r.cmps.length && bypassers.length) {
    const vendors = [...new Set(bypassers.map(h => h.vendor))];
    const hasMeta = vendors.some(v => /meta|facebook/i.test(v));
    const hasGoogle = vendors.some(v => /google|doubleclick|floodlight|analytics/i.test(v));
    const specifics = [
      hasGoogle ? `Google tags: set <code>gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',...})</code> BEFORE the tag loads; the CMP sends the 'update' to granted on Accept.` : '',
      hasMeta ? `Meta Pixel: call <code>fbq('consent','revoke')</code> before <code>init</code>; the CMP calls <code>fbq('consent','grant')</code> on Accept.` : '',
    ].filter(Boolean);
    fixNote = `<div class="cm-note warn"><b>Likely hardcoded pixels bypassing the CMP</b> (${vendors.join(', ')}). Fix paths, in order of preference:
      <ol style="margin:6px 0 0 18px;padding:0">
        <li>Move the pixels into GTM and apply the GTM consent procedure - triggers then respect consent automatically (this is what the consent setup covers).</li>
        <li>Native consent APIs in the hardcoded snippets: ${specifics.length ? specifics.join(' ') : 'set the vendor\u2019s consent-default API to denied before the tag initializes, updated to granted by the CMP.'} The default MUST appear above the pixel code.</li>
        <li>CMP script-blocking: change the snippet to <code>type="text/plain"</code> with the CMP's category attribute so it only executes after opt-in.</li>
      </ol>
      Re-scan after any fix - the before/after pair is the verification.</div>`;
  }

  const rejFires = (r.post_reject || []).length ? `<h3>Requests after Reject</h3><ul>` + r.post_reject.map(h =>
      `<li><span class="badge ${h.severity==='violation'?'bad':'warn'}">${h.severity}</span>
        <div><b>${h.vendor}</b> <span class="evidence">${h.note}</span><div class="u">${h.url}</div></div></li>`).join('') + `</ul>`
    : (r.reject_tested ? `<h3>Requests after Reject</h3><p class="kv">No trackers fired after Reject - the decline path is honored.</p>` : '');

  const gated = (r.post_consent || []).length ? `<h3>Fired after accept (gated correctly)</h3><ul>` + r.post_consent.map(h =>
      `<li><span class="badge ok"${tipAttr('post-consent')}>post-consent</span><div><b>${h.vendor}</b><div class="u">${h.url}</div></div></li>`).join('') + `</ul>` : '';

  const missingProds = prods.filter(p => p.fired === 0);
  const rejV = (r.post_reject || []).some(h => h.severity === 'violation');
  const headBadges = [
    rejV ? `<span class="badge bad"${tipAttr('fires after reject')}>fires after reject</span>` : '',
    r.verdict === 'misconfigured' && !rejV ? `<span class="badge bad"${tipAttr('pre-consent fires')}>pre-consent fires</span>` : '',
    missingProds.length ? `<span class="badge bad"${tipAttr('pixels missing')}>pixels missing</span>` : '',
    r.verdict === 'error' ? `<span class="badge warn"${tipAttr('scan error')}>scan error</span>` : '',
    r.mode !== 'full' ? `<span class="badge neutral">${r.mode}</span>` : '',
  ].join('');
  const prodStat = prods.map(p => {
    const count = p.expected > 1 ? ` ${p.fired}/${p.expected}` : '';
    const cls = p.fired === 0 ? 'bad' : p.fired < p.expected ? 'warn' : 'ok';
    const mark = p.fired === 0 ? '&#10007;' : '&#10003;';
    return `<span class="pstat ${cls}">${p.product}${count} ${mark}</span>`;
  }).join('');
  return `<div class="site" id="site-${i}">
    <div class="site-head" onclick="this.parentElement.classList.toggle('open')">
      ${headBadges}
      <span class="site-url">${r.url}</span>
      ${cmpNames ? `<span class="cmp-name">${cmpNames}</span>` : ''}
      ${prodStat}
      <span class="scanned">${r.scanned_local || r.scanned_at || ''}</span>
      <span class="caret">&#9654;</span>
    </div>
    <div class="site-body">
      ${r.verdict === 'error' || r.mode !== 'full' ? `<div class="verdict ${meta.cls}">${(r.verdict_lines && r.verdict_lines.length ? r.verdict_lines : [r.verdict_detail || r.error || '']).map(l => `<div class="vline">${l}</div>`).join('')}</div>` : ''}
      ${kvBits.length || cmStamp ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px;align-items:center">${cmStamp}${kvBits.join('')}</div>` : ''}
      ${cmNote}
      <div class="detail">${cmpDetail}${rejFires}${fixNote}${dspDetail}${fires}${gated}</div>
    </div>
  </div>`;
}

const VERDICT_RANK = {error:0, no_cmp:0, misconfigured:0, cmp_found_basic:1, ok:2};

function groupBadge(items){
  let worst = 2;
  items.forEach(({r}) => { worst = Math.min(worst, VERDICT_RANK[r.verdict] ?? 0); });
  const anyMissing = items.some(({r}) => (r.products||[]).some(p => p.fired === 0));
  if (worst === 0 || anyMissing) return '<span class="badge bad">needs attention</span>';
  if (worst === 1) return '<span class="badge neutral">basic</span>';
  return '<span class="badge ok">looks good</span>';
}

function mainItem(g){
  // main site = shortest normalized URL in the run (root beats inner pages)
  return g.items.reduce((best, it) =>
    normUrl(it.r.url).length < normUrl(best.r.url).length ? it : best, g.items[0]);
}
