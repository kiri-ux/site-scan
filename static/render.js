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
  return `<div class="link ${state}" title="${tip}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}
function stateChecksHtml(r){
  if (!(r.state_checks || []).length) return '';
  return `<h3>State checks</h3><ul>` + r.state_checks.map(c =>
    `<li><span class="badge ${c.status==='fail'?'bad':c.status==='pass'?'ok':'warn'}">${c.state} ${c.status}</span>
      <div><b>${c.check}</b> <span class="evidence">${c.detail}</span></div></li>`).join('') + `</ul>`;
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
  return `<div class="chain">
      ${chainLink('CMP', r.cmps.length ? cmpNames : (r.ok ? 'None found' : 'Unknown'), cmpState)}
      ${chainLink('Banner visible', fmt(r.banner_visible), bannerState)}
      ${chainLink('Consent Mode default', fmt(r.consent_mode_default), cmState)}
      ${chainLink('Pre-consent trackers', fireLabel, fireState)}
      ${chainLink('Product pixels', prodLabel, prodState)}
      ${chainLink('Reject honored', rejLabel, rejState)}
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
  if (defaults.length) kvBits.push(`<span class="kv">Defaults: <b>${defaults.map(([k,v])=>`${k}=${v}`).join(', ')}</b></span>`);

  const cmpDetail = r.cmps.length ? `<h3>CMP evidence</h3><ul>` + r.cmps.map(c =>
      `<li><div><b>${c.name}</b> <span class="evidence">${(c.evidence||[]).join(' &middot; ')}</span>
        ${c.notes ? `<div class="evidence">${c.notes}</div>` : ''}</div></li>`).join('') + `</ul>` : '';

  const fires = r.pre_consent.length ? `<h3>Requests before consent</h3><ul>` + r.pre_consent.map(h =>
      `<li><span class="badge ${h.severity==='violation'?'bad':h.severity==='warn'?'warn':'neutral'}">${h.severity === 'ungated' ? 'ungated' : h.severity}</span>
        <div><b>${h.vendor}</b> <span class="evidence">${h.note}</span><div class="u">${h.url}</div></div></li>`).join('') + `</ul>`
    : (r.mode === 'full' && r.ok ? `<h3>Requests before consent</h3><p class="kv">No known ad/analytics endpoints were contacted before consent on this page.</p>` : '');

  const pxBadge = px => !px.fired_pre && !px.fired_post
        ? '<span class="badge bad">not firing</span>'
        : px.fired_pre && !px.fired_post
        ? '<span class="badge warn">pre-consent only</span>'
        : '<span class="badge ok">' + (px.fired_pre ? 'pre + post' : 'post-consent') + '</span>';
  const dspDetail = (r.mode === 'full' && r.ok) ? `<h3>Product pixels</h3>` + (prods.length ? prods.map(p => {
      const stateBadge = p.fired === 0 ? '<span class="badge bad">missing</span>'
                       : p.fired < p.expected ? '<span class="badge warn">partial</span>'
                       : '<span class="badge ok">firing</span>';
      const countPill = p.expected > 1 ? ` <span class="pill">${p.fired}/${p.expected} firing</span>` : '';
      return `<details class="prod"><summary><b>${p.product}</b>${countPill} ${stateBadge}<span class="caret">&#9654;</span></summary>
       <ul>` + p.pixels.map(px =>
        `<li>${pxBadge(px)}<div><b>${px.name}</b>${px.fired_pre && !px.fired_post ? ' <span class="evidence">working, but should be consent-gated</span>' : ''}${px.macro_warning ? ' <span class="macro-warn">pixel URL contains unreplaced macros like [ORDER] - the template was pasted without filling values, so conversion data will be blank</span>' : ''}
         ${px.sample_url ? `<div class="u">${px.sample_url}</div>` : ''}</div></li>`).join('') + `</ul></details>`;
    }).join('')
    : `<p class="kv">${r.accept_clicked ? 'No product pixels observed on this page, before or after accept.' : 'Accept could not be clicked, so post-consent firing could not be verified on this page.'}</p>`) : '';

  const rejFires = (r.post_reject || []).length ? `<h3>Requests after Reject</h3><ul>` + r.post_reject.map(h =>
      `<li><span class="badge ${h.severity==='violation'?'bad':'warn'}">${h.severity}</span>
        <div><b>${h.vendor}</b> <span class="evidence">${h.note}</span><div class="u">${h.url}</div></div></li>`).join('') + `</ul>`
    : (r.reject_tested ? `<h3>Requests after Reject</h3><p class="kv">No trackers fired after Reject - the decline path is honored.</p>` : '');

  const gated = (r.post_consent || []).length ? `<h3>Fired after accept (gated correctly)</h3><ul>` + r.post_consent.map(h =>
      `<li><span class="badge ok">post-consent</span><div><b>${h.vendor}</b><div class="u">${h.url}</div></div></li>`).join('') + `</ul>` : '';

  const missingProds = prods.filter(p => p.fired === 0);
  const rejV = (r.post_reject || []).some(h => h.severity === 'violation');
  const headBadges = [
    rejV ? '<span class="badge bad">fires after reject</span>' : '',
    r.verdict === 'misconfigured' && !rejV ? '<span class="badge bad">pre-consent fires</span>' : '',
    missingProds.length ? '<span class="badge bad">pixels missing</span>' : '',
    r.verdict === 'error' ? '<span class="badge warn">scan error</span>' : '',
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
      ${chain}
      <div class="verdict ${meta.cls}">${(r.verdict_lines && r.verdict_lines.length ? r.verdict_lines : [r.verdict_detail || r.error || '']).map(l => `<div class="vline">${l}</div>`).join('')}</div>
      ${kvBits.length ? `<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:6px">${kvBits.join('')}</div>` : ''}
      <div class="detail">${cmpDetail}${fires}${rejFires}${dspDetail}${gated}</div>
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
