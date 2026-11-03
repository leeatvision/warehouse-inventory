/* Everyday screens: setup, sign-in, home, more, Cart, check and save, entries, catalogue, pick lists, stock counts. */
'use strict';

// ------------------------------------------------------------------ first-time setup
SCREENS.setup = () => {
  const firstManager = S.snap && !S.snap.users.some(u => u.role === 'manager' && u.hash);
  if (S.key && S.snap && firstManager) return setupFirstManager();
  return `<div class="card narrow stack">
    <div class="brand-row">${logoHtml()}<span class="side-name">${esc(B.name || 'Warehouse')}</span></div>
    <h1>Set up this device</h1>
    <p class="muted">Do this once on each phone or tablet. A Manager has the device key.</p>
    ${S.setupMsg ? `<div class="msg warn">${esc(S.setupMsg)}</div>` : ''}
    ${!B.supabaseUrl ? `<div class="msg bad">This copy of the app has no server address, so it can only show placeholders.</div>` : ''}
    <label class="f">Device key<input type="password" id="dk" autocomplete="off" data-enter="saveKey" data-autofocus></label>
    <button class="btn primary big" data-act="saveKey">Connect</button><span id="setupState" class="muted small"></span>
  </div>`;
};
ACT.saveKey = async () => {
  const k = $('#dk').value.trim(); if (!k) return;
  $('#setupState').textContent = 'Connecting…';
  try {
    const snap = await rpc('wh_snapshot', { p_key: k });
    S.key = k; S.snap = snap; await DB.put('kv', k, 'device_key'); await DB.put('kv', snap, 'snapshot');
    $('#setupState').textContent = 'Loading Job codes…';
    await loadJobs(); S.setupMsg = ''; S.lastSync = new Date().toISOString();
    startSyncLoop();
    go(snap.users.some(u => u.role === 'manager' && u.hash) ? 'signin' : 'setup');
  } catch (e) { $('#setupState').textContent = e.keyRejected ? 'That key was not accepted.' : 'Could not connect: ' + e.message; }
};
function setupFirstManager() {
  const mgrs = S.snap.users.filter(u => u.role === 'manager');
  return `<div class="card narrow stack">
    <h1>Set a Manager PIN</h1>
    <p class="muted">No Manager has a PIN yet. Pick yourself and choose a PIN of 4 to 8 digits. After that, Managers set everyone else's PIN under People and PINs.</p>
    ${mgrs.length ? `<div class="list card flat">${mgrs.map(u => personRow(u, 'setPinFor', 'data-first="1"')).join('')}</div>`
      : `<div class="msg bad">Nobody is marked as a Manager in the database yet.</div>`}
  </div>`;
}
function personRow(u, act, extra = '') {
  return `<button class="row-i" data-act="${act}" data-id="${u.id}" ${extra} ${act === 'pickUser' && !u.hash ? 'disabled' : ''}>
    <span class="avatar soft">${esc(initials(u.name))}</span>
    <span class="grow"><span class="t">${esc(u.name)}</span>${act === 'pickUser' && !u.hash ? '<span class="s">No PIN yet. Ask a Manager.</span>' : ''}</span>
    ${u.role === 'manager' ? '<span class="s">Manager</span>' : ''}${icon('chevron', 18, 'class="ico chev"')}</button>`;
}

// ------------------------------------------------------------------ sign-in
SCREENS.boot = () => '<p class="boot">Loading…</p>';
let whoQ = '';
SCREENS.signin = () => {
  const users = (S.snap && S.snap.users) || [];
  return `<div class="signin">
    <div class="head-big"><h1>Who's working?</h1><p class="muted">Tap your name, then enter your PIN.</p></div>
    ${storageWarning()}
    ${users.length > 8 ? `<label class="field-search">${icon('search', 20)}<input type="search" placeholder="Find your name" aria-label="Find your name" value="${esc(whoQ)}" data-in="whoQ" autocomplete="off"></label>` : ''}
    ${region('who', () => {
      const t = norm(whoQ); const list = users.filter(u => !t || norm(u.name).includes(t));
      return list.length ? `<div class="card flat list">${list.map(u => personRow(u, 'pickUser')).join('')}</div>`
        : `<div class="empty">${users.length ? 'No one by that name.' : 'No users yet. Check the connection at the top.'}</div>`;
    })}</div>`;
};
IN.whoQ = v => { whoQ = v; refresh('who'); };
function storageWarning() {
  const n = S.outbox.length; const out = [];
  if (n) out.push(`<div class="msg warn">${plural(n, 'entry', 'entries')} not sent yet. Until they are, do not clear this browser's data, sign it in to an account or uninstall the app. A Manager can save them to a file under Device and billing.</div>`);
  if (S.persisted === false) out.push(`<div class="msg warn">This browser has not agreed to keep the app's data safe. It may clear it if the device runs low on space. A Manager should check Device and billing.</div>`);
  return out.length ? `<div class="stack">${out.join('')}</div>` : '';
}
ACT.pickUser = d => openModal('pin', { userId: Number(d.id), entry: '', mode: 'signin', tries: 0 });
const pinLock = new Map();
MODALS.pin = () => {
  const m = S.modal; const u = V().users.get(m.userId);
  const title = m.mode === 'signin' ? esc(u.name) : m.step === 2 ? 'Enter the new PIN again' : `New PIN for ${esc(u.name)}`;
  return modal(title, `<div class="dots ${m.shake ? 'shake' : ''}">${Array.from({ length: Math.max(4, m.entry.length) }, (_, i) => `<i class="${i < m.entry.length ? 'on' : ''}"></i>`).join('')}</div>
    ${m.msg ? `<div class="msg ${m.msgKind || 'bad'} center">${esc(m.msg)}</div>` : ''}
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="pinKey" data-k="${n}">${n}</button>`).join('')}
      <button data-act="pinKey" data-k="clear" class="word">Clear</button><button data-act="pinKey" data-k="0">0</button>
      <button data-act="pinKey" data-k="ok" class="word ok">OK</button></div>
    <p class="muted small center">${m.mode === 'signin' ? '' : '4 to 8 digits'}</p>`, '', false, 'pin');
};
ACT.pinKey = async d => {
  const m = S.modal; m.shake = false; m.msg = '';
  if (d.k === 'clear') m.entry = '';
  else if (d.k === 'ok') return pinSubmit();
  else if (m.entry.length < 8) m.entry += d.k;
  if (m.mode === 'signin' && m.entry.length >= 4) {
    const u = V().users.get(m.userId);
    if (await checkPin(u, m.entry)) return finishSignIn(u);
  }
  renderModal();
};
document.addEventListener('keydown', e => {
  if (!S.modal || S.modal.kind !== 'pin') return;
  if (/^\d$/.test(e.key)) ACT.pinKey({ k: e.key });
  else if (e.key === 'Backspace') { S.modal.entry = S.modal.entry.slice(0, -1); renderModal(); }
  else if (e.key === 'Enter') pinSubmit();
});
async function pinSubmit() {
  const m = S.modal; const u = V().users.get(m.userId);
  if (m.mode === 'signin') {
    const lock = pinLock.get(u.id);
    if (lock && lock.until > Date.now()) { m.msg = `Too many tries. Wait ${Math.ceil((lock.until - Date.now()) / 1000)} seconds.`; return renderModal(); }
    if (await checkPin(u, m.entry)) return finishSignIn(u);
    const l = pinLock.get(u.id) || { n: 0, until: 0 }; l.n++; if (l.n >= 5) { l.until = Date.now() + 60000; l.n = 0; } pinLock.set(u.id, l);
    m.entry = ''; m.shake = true; m.msg = 'Wrong PIN'; return renderModal();
  }
  if (m.entry.length < 4) { m.msg = 'Use at least 4 digits'; return renderModal(); }
  if (m.step !== 2) { m.first = m.entry; m.entry = ''; m.step = 2; return renderModal(); }
  if (m.entry !== m.first) { m.entry = ''; m.step = 1; m.first = ''; m.shake = true; m.msg = 'The two PINs did not match. Start again.'; return renderModal(); }
  const p = await makePin(m.entry);
  await queue('user_save', { user_id: u.id, ...p }, m.firstSetup ? null : S.user.id);
  closeModal(); toast(`PIN set for ${u.name}`);
  if (m.firstSetup) { await sync(); go('signin'); } else render();
}
function finishSignIn(u) {
  pinLock.delete(u.id); S.user = u; S.modal = null; lastTap = Date.now(); whoQ = '';
  go('home'); toast(`Signed in as ${u.name}`);
}
ACT.setPinFor = d => openModal('pin', { userId: Number(d.id), entry: '', mode: 'set', step: 1, firstSetup: !!d.first });

// ------------------------------------------------------------------ home
function todayLabel() {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: tz(), weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()); }
  catch { return new Date().toDateString(); }
}
function greeting() {
  let h = new Date().getHours(); try { h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', hour12: false }).format(new Date())) % 24; } catch { }
  return (h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening') + ', ' + esc(String(S.user.name).split(' ')[0]);
}
function myRecentCarts(limit = 4) {
  const me = S.user.id;
  return (S.snap.carts || []).filter(c => c.entered_by === me || c.on_behalf_of === me).slice(0, limit);
}
function cartJobs(c) { return [...new Set(c.lines.map(l => jobLabel(l.jobcode_id)))].join('; ') || (c.equipment.length ? 'Equipment' : '—'); }
function recentRows(list) {
  return list.map(c => `<button class="row-i" data-act="openCart" data-id="${c.id}"><span class="grow"><span class="t clip">${esc(cartJobs(c))}</span>
    <span class="s">Cart ${c.id} · ${plural(c.lines.length + c.equipment.length, 'item')}${c.corrections ? ' · corrected' : ''}${c.cancelled ? ' · cancelled' : ''}</span></span>
    <span class="s nowrap">${fmtDT(c.received_at)}</span></button>`).join('');
}
SCREENS.home = () => {
  const v = V(); const me = S.user.id;
  const mineOut = v.checkouts.filter(c => c.user_id === me).length;
  const openPicks = v.picks.filter(p => p.status === 'open').length;
  const myCounts = v.counts.filter(c => c.status === 'open' && (c.assigned_to === me || (isManager() && !c.assigned_to))).length;
  const alerts = isManager() ? alertList() : [];
  const recent = myRecentCarts();
  const card = (to, ic, title, sub) => `<button class="action" data-act="go" data-to="${to}">${icon(ic, 26)}<b>${title}</b><span>${sub}</span></button>`;
  const desk = isDesk() && isManager();
  return `<div class="home">
    <div class="head-big"><p class="muted">${esc(todayLabel())}</p><h1>${greeting()}</h1></div>
    <div class="home-grid ${desk ? 'desk' : ''}">
      <div class="stack-l">
        <button class="hero" data-act="go" data-to="cart?mode=take"><span class="hero-ic">${icon('swap', 28)}</span>
          <span class="grow"><b>Take out or return</b><span>Parts for a Job code</span></span>${icon('chevron', 22)}</button>
        <div class="actions">
          ${card('cart?mode=equipment', 'tool', 'Equipment', mineOut ? `${plural(mineOut, 'item')} checked out to you` : 'Check out or check in')}
          ${card('entries', 'list', 'My entries', 'Fix the last 2 weeks')}
          ${isWide() ? card('catalogue', 'box', 'Catalogue', 'Find any item') : ''}
        </div>
        ${openPicks || myCounts ? `<div class="actions">${openPicks ? card('picks', 'list', 'Pick lists', `${plural(openPicks, 'list')} ready to pick`) : ''}${myCounts ? card('counts', 'box', 'Stock counts', `${plural(myCounts, 'count')} waiting for you`) : ''}</div>` : ''}
        ${alerts.length && !isWide() ? `<button class="banner warn" data-act="go" data-to="alerts">${icon('alert', 20)}<span class="grow">${plural(alerts.length, 'thing needs', 'things need')} a look</span><b>View</b></button>` : ''}
        ${desk ? deskStats() : ''}
      </div>
      <div class="stack-l">
        ${alerts.length && isWide() ? `<section class="sec"><h2 class="sec-h">Needs a look</h2><div class="card flat list">${alerts.slice(0, 5).map(alertRow).join('')}
          ${alerts.length > 5 ? `<button class="row-i" data-act="go" data-to="alerts"><span class="grow t">See all ${alerts.length}</span>${icon('chevron', 18, 'class="ico chev"')}</button>` : ''}</div></section>` : ''}
        ${desk ? '' : entriesWidget()}
      </div>
    </div>${desk ? `<div class="home-wide">${entriesWidget()}</div>` : ''}</div>`;
};
function alertRow(a) {
  return `<button class="row-i" ${a.item ? `data-act="openItem" data-id="${a.item}"` : a.to ? `data-act="go" data-to="${a.to}"` : ''}>
    <span class="dot-s ${a.kind}"></span><span class="grow"><span class="t">${esc(a.text)}</span><span class="s">${esc(a.sub)}</span></span></button>`;
}
// Summary cards for Managers on desktop.
function deskStats() {
  const day = new Date().toDateString();
  const carts = (S.snap.carts || []).filter(c => new Date(c.received_at).toDateString() === day);
  const items = carts.reduce((n, c) => n + c.lines.length + c.equipment.length, 0);
  const low = V().itemList.filter(i => !i.archived && (num(i.qty) < 0 || (i.low_stock !== null && i.low_stock !== undefined && num(i.qty) <= num(i.low_stock)))).length;
  const dl = S.snap.delivery || {};
  const stat = (to, label, val, sub, cls = '') => `<button class="stat" data-act="go" data-to="${to}"><span class="s">${label}</span><b class="${cls}">${val}</b><span class="s">${sub}</span></button>`;
  return `<div class="stats">
      ${stat('entries?all=1', 'Carts today', carts.length, plural(items, 'line'))}
      ${stat('catalogue?stock=low', 'Low stock', low, 'At or under their level', low ? 'warn' : '')}
      ${stat('catalogue?stock=out', 'Equipment out', V().checkouts.length, 'Checked out now')}
      ${stat('status', 'Billing PDFs', dl.waiting ? dl.waiting + ' waiting' : 'Up to date', dl.last_delivered ? 'Last sent ' + fmtDT(dl.last_delivered) : 'None sent yet', dl.waiting ? 'warn' : 'ok')}
    </div>`;
}
// The entries box on Home. Managers see everyone's Carts (with a switch to their own); others see their own.
let homeScope = null;
function entriesWidget() {
  const mgr = isManager(); const scope = mgr ? (homeScope || 'all') : 'mine';
  const me = S.user.id; const limit = isDesk() ? 8 : isWide() ? 6 : 5;
  const all = (S.snap.carts || []).filter(c => scope === 'all' || c.entered_by === me || c.on_behalf_of === me);
  const pend = V().pendingCarts.filter(o => scope === 'all' || o.user_id === me || (o.data && o.data.on_behalf_of === me));
  const list = all.slice(0, Math.max(0, limit - pend.length));
  const who = c => userName(c.on_behalf_of || c.entered_by);
  const status = c => c.cancelled ? '<span class="pill bad">Cancelled</span>' : c.corrections ? '<span class="pill">Corrected</span>' : '';
  const kinds = c => [...new Set([...c.lines, ...c.equipment].map(l => l.kind))].map(k => `<span class="tag ${k}">${MODES[k]}</span>`).join(' ');
  const pendRows = pend.slice(0, limit).map(o => `<div class="row-i static"><span class="grow"><span class="t">Waiting to send</span>
    <span class="s">${esc(userName((o.data && o.data.on_behalf_of) || o.user_id))} · ${plural((o.data.lines || []).length, 'item')}</span></span><span class="pill warn">Not sent yet</span></div>`).join('');
  const body = isDesk()
    ? `<div class="card flat table-wrap"><table class="t"><thead><tr><th>When</th>${scope === 'all' ? '<th>Who</th>' : ''}<th>What</th><th>Job code</th><th class="right">Lines</th><th></th></tr></thead>
      <tbody>${list.map(c => `<tr class="click" data-act="openCart" data-id="${c.id}"><td class="muted nowrap">${fmtDT(c.received_at)}</td>${scope === 'all' ? `<td class="nowrap">${esc(who(c))}</td>` : ''}
        <td>${kinds(c)}</td><td>${esc(cartJobs(c))}</td><td class="n">${c.lines.length + c.equipment.length}</td><td>${status(c)}</td></tr>`).join('')
        || `<tr><td colspan="6" class="muted">No Carts in the last 2 weeks.</td></tr>`}</tbody></table></div>`
    : `<div class="card flat list">${pendRows}${list.map(c => `<button class="row-i" data-act="openCart" data-id="${c.id}"><span class="grow"><span class="t clip">${esc(cartJobs(c))}</span>
        <span class="s">${scope === 'all' ? esc(who(c)) + ' · ' : ''}Cart ${c.id} · ${plural(c.lines.length + c.equipment.length, 'item')}</span></span>
        <span class="ent-r">${status(c)}<span class="s nowrap">${fmtDT(c.received_at)}</span></span></button>`).join('')}
        ${!list.length && !pend.length ? `<div class="empty">${scope === 'all' ? 'No Carts in the last 2 weeks.' : 'Nothing yet. Tap Take out or return to start.'}</div>` : ''}</div>`;
  return `<section class="sec entries-widget"><div class="sec-row"><h2 class="sec-h">${mgr ? 'Latest entries' : 'Your recent carts'}</h2>
      ${mgr ? `<div class="seg small" role="tablist" aria-label="Whose entries"><button role="tab" aria-selected="${scope === 'all'}" class="${scope === 'all' ? 'on' : ''}" data-act="homeScope" data-s="all">Everyone</button>
        <button role="tab" aria-selected="${scope === 'mine'}" class="${scope === 'mine' ? 'on' : ''}" data-act="homeScope" data-s="mine">Mine</button></div>` : ''}</div>
    ${body}
    <a href="#" class="see-all" data-act="go" data-to="entries" ${scope === 'all' ? 'data-all="1"' : ''}>See all ${scope === 'all' ? 'entries' : 'my entries'}</a></section>`;
}
ACT.homeScope = d => { homeScope = d.s; render(); };

// ------------------------------------------------------------------ more (phone and tablet: everything not in the bottom bar)
SCREENS.more = () => {
  const row = (to, label, sub, count = '') => `<button class="row-i" data-act="go" data-to="${to}"><span class="grow"><span class="t">${label}</span><span class="s">${sub}</span></span>
    ${count ? `<span class="count">${count}</span>` : ''}${icon('chevron', 18, 'class="ico chev"')}</button>`;
  const alerts = isManager() ? alertList() : [];
  const sub = { receive: 'Deliveries and parts brought back', adjust: 'Fix a count, with a reason', counts: 'Start and review counts', picks: 'Prepare items for a job',
    pos: 'Make, print and receive', supplierReturn: 'Job material going back', alerts: 'Low stock, overdue, delivery', reports: 'History, stock, moves',
    people: `${V().users.size} people`, setup2: 'Shelves, bins, custom fields', status: 'Sending, billing PDFs, settings' };
  return `${pageHead('More')}<div class="stack-l">
    ${alerts.length ? `<button class="banner warn" data-act="go" data-to="alerts">${icon('alert', 20)}<span class="grow"><b>${plural(alerts.length, 'thing needs', 'things need')} a look</b></span>${icon('chevron', 18)}</button>` : ''}
    <section class="sec"><h2 class="sec-h">You</h2><div class="card flat list">
      ${row('entries', 'My entries', 'See and correct your Carts')}
      ${!isManager() ? row('status', 'Device', 'Connection and unsent entries') : ''}
      ${V().picks.some(p => p.status === 'open') ? row('picks', 'Pick lists', 'Lists ready to pick', navCount('picks')) : ''}
      ${!isManager() && V().counts.some(c => c.status === 'open' && c.assigned_to === S.user.id) ? row('counts', 'Stock counts', 'Counts waiting for you') : ''}</div></section>
    ${isManager() ? NAV_GROUPS.map(([h, items]) => `<section class="sec"><h2 class="sec-h">${h}</h2><div class="card flat list">
      ${items.map(([to, label]) => row(to, label, sub[to] || '', navCount(to))).join('')}</div></section>`).join('') : ''}
    <button class="btn big" data-act="logout">Sign out</button></div>`;
};

// ------------------------------------------------------------------ the Cart
// Allow "screen?mode=x&a=b" in data-to.
const _go = go;
go = (screen, params = {}) => {
  const [s, q] = String(screen).split('?');
  if (q) new URLSearchParams(q).forEach((v, k) => { params[k] = v; });
  if (s === 'cart') startCart(params.mode);
  return _go(s, params);
};
function startCart(mode, extra = {}) {
  if (mode === 'checkout' || mode === 'checkin') mode = 'equipment';
  if (S.cart && !extra.correction && !extra.lines) { if (mode && !S.cart.correction) S.cart.mode = mode; return; }
  S.cart = { mode: mode || 'take', lines: [], note: '', obo: null, jobAll: null, q: '', correction: null, pick_id: null, ...extra };
}
const MODES = { take: 'Take out', return: 'Return', checkout: 'Check out', checkin: 'Check in' };
const lineCount = () => S.cart.lines.reduce((n, l) => n + 1, 0);
SCREENS.cart = () => {
  if (!S.cart) startCart('take');
  const c = S.cart; const wide = isWide();
  const modes = c.correction ? [['take', 'Take out'], ['return', 'Return']] : [['take', 'Take out'], ['return', 'Return'], ['equipment', 'Equipment']];
  const forSel = isManager() && !c.correction ? `<label class="for">For <select data-ch="obo"><option value="">${esc(S.user.name)}</option>${[...V().users.values()].filter(u => u.id !== S.user.id)
    .map(u => `<option value="${u.id}" ${c.obo === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : `<span class="s">${esc(S.user.name)}</span>`;
  const seg = `<div class="seg" role="tablist" aria-label="What are you doing?">${modes.map(([m, l]) => `<button role="tab" aria-selected="${c.mode === m}" class="${c.mode === m ? 'on' : ''}" data-act="mode" data-m="${m}">${l}</button>`).join('')}</div>`;
  const search = `<div class="search-row"><label class="field-search">${icon('search', 20)}<input type="search" placeholder="${wide ? 'Search by name or Item number' : 'Add an item'}" aria-label="Add an item" value="${esc(c.q)}"
      data-in="cartQ" data-enter="cartEnter" data-autofocus autocomplete="off"></label>
      ${Scanner.supported() ? `<button class="btn icon-btn" data-act="scan" data-for="cart" aria-label="Scan a label">${icon('scan', 22)}${wide ? '<span>Scan</span>' : ''}</button>` : ''}</div>`;
  const title = c.correction ? `Correcting Cart ${c.correction.cart_id}` : 'Cart';
  if (!wide) {
    return `<div class="cart-phone">
      <div class="head">${back('Home', 'home')}<h1>${title}</h1>${forSel}</div>
      ${seg}${jobCard()}${search}
      ${region('finder', finderHtml)}
      ${region('cartLines', cartLinesHtml)}
      ${region('savebar', saveBar)}</div>`;
  }
  return `<div class="cart-wide">
    <section class="cart-find"><div class="head"><h1>${c.correction ? title : 'Add items'}</h1>${seg}</div>${search}${region('finder', finderHtml)}</section>
    <aside class="cart-panel"><div class="cart-panel-h"><h2>${c.correction ? 'Corrected Cart' : 'Cart'}</h2>${forSel}</div>${jobCard()}
      <div class="cart-panel-b">${region('cartLines', cartLinesHtml)}</div>${region('savebar', saveBar)}</aside></div>`;
};
function jobCard() {
  const c = S.cart; if (c.mode === 'equipment' && !c.lines.some(l => l.kind === 'checkout')) return '';
  return `<button class="job-card ${c.jobAll ? '' : 'empty-job'}" data-act="jobAll"><span class="grow"><span class="lbl">Job code</span>
    <b>${c.jobAll ? esc(jobLabel(c.jobAll)) : 'Choose the Job code'}</b>${c.jobAll && jobAddr(c.jobAll) ? `<span class="addr">${esc(jobAddr(c.jobAll))}</span>` : ''}</span><span class="act">${c.jobAll ? 'Change' : 'Choose'}</span></button>`;
}
function saveBar() {
  const n = S.cart.lines.length;
  return `<div class="savebar">${n ? `<button class="btn primary big" data-act="review">Check and save · ${plural(n, 'item')}</button>`
    : `<button class="btn big" disabled>Add items to save</button>`}</div>`;
}
CH.obo = v => { S.cart.obo = v ? Number(v) : null; refresh('finder'); };
ACT.mode = d => { S.cart.mode = d.m; S.cart.q = ''; render(); };
IN.cartQ = v => { S.cart.q = v; refresh('finder'); if (!isWide()) refresh('cartLines'); fillPhotos(); };
ACT.cartEnter = () => {
  const res = searchItems(S.cart.q, finderFilter());
  const it = itemByCode(S.cart.q) || (res.length === 1 ? res[0] : null);
  if (it) { addToCart(it.id); clearCartQ(); }
};
function clearCartQ() { S.cart.q = ''; const i = $('.field-search input[data-in=cartQ]'); if (i) i.value = ''; refresh('finder', 'cartLines'); }
function finderFilter() {
  const m = S.cart.mode;
  if (m === 'take' || m === 'return') return i => i.kind === 'consumable';
  return i => i.kind === 'equipment' && (i.counted ? num(i.qty) > 0 : i.status === 'available');
}
function finderHtml() {
  const c = S.cart; const wide = isWide(); const parts = [];
  if (c.mode === 'equipment' && !c.q) {
    const who = c.obo || S.user.id;
    const outs = V().checkouts.filter(x => x.user_id === who || (isManager() && !c.obo));
    if (outs.length) parts.push(`<section class="sec"><h2 class="sec-h">Checked out${isManager() && !c.obo ? '' : ' to ' + (who === S.user.id ? 'you' : esc(userName(who)))}. Tap to check in.</h2>
      <div class="card flat list">${outs.map(x => { const it = item(x.item_id); const left = num(x.qty) - num(x.qty_returned); const inCart = c.lines.some(l => l.checkout_id === x.id);
        return `<button class="row-i" data-act="addCheckin" data-id="${x.id}" ${inCart ? 'disabled' : ''}><span class="grow"><span class="t">${esc(it ? it.name : '?')}</span>
          <span class="s">${esc(userName(x.user_id))} · since ${fmtD(x.opened_at)} · ${esc(jobLabel(x.jobcode_id))}</span></span><span class="q">${inCart ? 'In Cart' : fmtQty(left)}</span></button>`; }).join('')}</div></section>`);
  }
  if (c.mode === 'return' && !c.q) {
    const who = c.obo || S.user.id; const seen = new Set();
    const recent = (S.snap.returnable || []).filter(r => r.user_id === who).sort((a, b) => b.at.localeCompare(a.at))
      .filter(r => { const k = r.item_id + ':' + r.jobcode_id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, wide ? 12 : 6);
    if (recent.length) parts.push(`<section class="sec"><h2 class="sec-h">Recently taken out by ${who === S.user.id ? 'you' : esc(userName(who))}</h2><div class="card flat list">
      ${recent.map(r => { const it = item(r.item_id); return it ? `<button class="row-i" data-act="addReturn" data-item="${it.id}" data-job="${r.jobcode_id}" data-line="${r.line_id}">
        <span class="grow"><span class="t">${esc(it.name)}</span><span class="s">${esc(jobLabel(r.jobcode_id))} · Cart ${r.cart_id}</span></span><span class="q">${fmtQty(r.qty)}</span></button>` : ''; }).join('')}</div></section>`);
  }
  // On a phone the results only show while searching; on wider screens the list is always there.
  if (c.q || wide || c.mode === 'equipment') {
    const res = searchItems(c.q, finderFilter(), wide ? 80 : 30);
    const title = c.mode === 'equipment' ? 'Available to check out' : c.q ? 'Results' : 'All items';
    parts.push(`<section class="sec">${wide || c.mode === 'equipment' ? `<h2 class="sec-h">${title}</h2>` : ''}${res.length
      ? `<div class="${wide ? 'pick-grid' : 'card flat list'}">${res.map(i => wide ? pickCard(i) : itemRow(i, 'addItem')).join('')}</div>`
      : `<div class="empty card flat">${c.q ? 'No match.' : 'No items yet.'}${isManager() ? ' Add items in the Catalogue.' : ''}</div>`}</section>`);
  }
  return parts.join('');
}
function pickCard(i) {
  return `<div class="pick-card"><span class="grow"><span class="t">${esc(i.name)}</span>
    <span class="s"><span class="num">${esc(i.number || 'new')}</span>${locPath(i.location_id) ? ' · ' + esc(locPath(i.location_id)) : ''} · ${esc(onShelf(i))}</span></span>
    <button class="round" data-act="addItem" data-id="${i.id}" aria-label="Add ${esc(i.name)}">${icon('plus', 20)}</button></div>`;
}
function itemRow(i, act, extraAttrs = '') {
  const ph = firstPhoto(i.id);
  return `<button class="row-i" data-act="${act}" data-id="${i.id}" ${extraAttrs}>
    ${ph ? `<img class="thumb" data-photo="${ph}" alt="">` : `<span class="thumb">${icon('box', 20)}</span>`}
    <span class="grow"><span class="t">${esc(i.name)}</span>
    <span class="s"><span class="num">${esc(i.number || 'new')}</span>${locPath(i.location_id) ? ' · ' + esc(locPath(i.location_id)) : ''}</span></span>
    <span class="qty-col"><b class="${num(i.qty) < 0 ? 'bad' : ''}">${i.kind === 'equipment' && !i.counted ? '' : fmtQty(i.qty)}</b><span class="st ${stockState(i)}">${esc(stockWord(i))}</span></span></button>`;
}
function stockState(i) {
  if (i.kind === 'equipment' && !i.counted) return i.status === 'available' ? 'ok' : 'out';
  if (num(i.qty) < 0) return 'bad';
  if (i.low_stock !== null && i.low_stock !== undefined && num(i.qty) <= num(i.low_stock)) return 'low';
  return 'ok';
}
function stockWord(i) {
  if (i.kind === 'equipment' && !i.counted) return onShelf(i);
  return { bad: 'Count is off', low: 'Low', ok: 'On shelf' }[stockState(i)];
}
ACT.addItem = d => { addToCart(d.id); if (!isWide()) clearCartQ(); };
ACT.addReturn = d => addToCart(d.item, { jobcode_id: Number(d.job), link_line_id: Number(d.line) });
ACT.addCheckin = d => {
  const x = V().checkouts.find(c => c.id === d.id); if (!x) return;
  S.cart.lines.push({ lid: uuid(), kind: 'checkin', item_id: x.item_id, qty: num(x.qty) - num(x.qty_returned), checkout_id: x.id, jobcode_id: x.jobcode_id, note: '' });
  refresh('finder', 'cartLines', 'savebar');
};
function addToCart(itemId, extra = {}) {
  const c = S.cart; const it = item(itemId); if (!it) return;
  const kind = c.mode === 'equipment' ? 'checkout' : c.mode;
  if ((kind === 'take' || kind === 'return') && it.kind !== 'consumable') return toast(`${it.name} is Equipment. Use the Equipment tab.`);
  if (kind === 'checkout' && it.kind !== 'equipment') return toast(`${it.name} is a Consumable. Use Take out.`);
  const job = extra.jobcode_id || c.jobAll || null;
  const same = c.lines.find(l => l.item_id === itemId && l.kind === kind && l.jobcode_id === job && !l.note && !extra.link_line_id);
  if (same && !(kind === 'checkout' && !it.counted)) same.qty = num(same.qty) + 1;
  else if (kind === 'checkout' && !it.counted && c.lines.some(l => l.item_id === itemId && l.kind === 'checkout')) return toast('Already in the Cart');
  else c.lines.push({ lid: uuid(), kind, item_id: itemId, qty: 1, jobcode_id: job, note: '', checkout_id: kind === 'checkout' ? uuid() : undefined, ...extra });
  if (kind === 'checkout' && !$('.job-card')) render(); else refresh('cartLines', 'savebar', 'finder');
  toast(`Added ${it.name}`, 1200);
}
function cartLinesHtml() {
  const c = S.cart;
  if (!isWide() && c.q) return '';
  if (!c.lines.length) return `<div class="empty card flat">${isWide() ? 'Tap + on an item to add it.' : 'Search or scan to add items.'}</div>
    ${c.correction ? `<button class="btn danger" data-act="cancelCart" data-id="${c.correction.cart_id}">Cancel the whole Cart instead</button>` : ''}`;
  return `<div class="lines">${c.lines.map(lineHtml).join('')}</div>`;
}
function lineHtml(l) {
  const c = S.cart; const it = item(l.item_id) || { name: '?', number: '' };
  const fixed = l.kind === 'checkin' || (l.kind === 'checkout' && !it.counted);
  const short = l.kind === 'take' && num(l.qty) > num(it.qty);
  const otherJob = l.kind !== 'checkin' && l.jobcode_id && l.jobcode_id !== c.jobAll;
  const missingJob = l.kind !== 'checkin' && !l.jobcode_id;
  return `<article class="line-card ${missingJob ? 'missing' : ''}">
    <div class="lc-top"><div class="grow">${l.kind !== 'take' ? `<span class="tag ${l.kind}">${MODES[l.kind]}</span> ` : ''}<span class="t">${esc(it.name)}</span>
      <span class="s"><span class="num">${esc(it.number)}</span>${locPath(it.location_id) ? ' · ' + esc(locPath(it.location_id)) : ''}</span></div>
      <button class="icon-x" data-act="rmLine" data-lid="${l.lid}" aria-label="Remove ${esc(it.name)}">${icon('x', 18)}</button></div>
    ${short ? `<span class="warn-t">Only ${fmtQty(it.qty)} on the shelf. It will still be saved.</span>` : ''}
    ${l.kind === 'checkin' ? `<span class="s">Back from ${esc(jobLabel(l.jobcode_id))}</span>` : ''}
    ${otherJob || missingJob ? `<button class="chip ${missingJob ? 'bad' : ''}" data-act="pickJob" data-lid="${l.lid}">${missingJob ? 'Choose a Job code' : 'Job: ' + esc(jobLabel(l.jobcode_id))}</button>` : ''}
    ${l.noteOpen || l.note ? `<input class="note-in" type="text" placeholder="Note for this line" value="${esc(l.note)}" data-in="lineNote" data-lid="${l.lid}" aria-label="Line note">` : ''}
    <div class="lc-bot">${fixed ? `<b class="qty-fixed">${fmtQty(l.qty)}</b>` : `<div class="stepper"><button data-act="qty" data-lid="${l.lid}" data-d="-1" aria-label="One less">−</button>
      <input type="number" inputmode="decimal" min="0" step="any" value="${fmtQty(l.qty)}" data-in="qtyIn" data-lid="${l.lid}" aria-label="Quantity">
      <button data-act="qty" data-lid="${l.lid}" data-d="1" aria-label="One more">+</button></div>`}
      <span class="grow"></span>
      ${l.kind !== 'checkin' && !otherJob && !missingJob && c.jobAll ? `<button class="link" data-act="pickJob" data-lid="${l.lid}">Other job</button>` : ''}
      ${!l.noteOpen && !l.note ? `<button class="link" data-act="noteOpen" data-lid="${l.lid}">Add note</button>` : ''}</div>
  </article>`;
}
const lineBy = lid => S.cart.lines.find(l => l.lid === lid);
ACT.qty = d => { const l = lineBy(d.lid); l.qty = Math.max(0, num(l.qty) + num(d.d)); if (l.qty === 0) S.cart.lines = S.cart.lines.filter(x => x !== l); refresh('cartLines', 'savebar'); };
IN.qtyIn = (v, d) => { const l = lineBy(d.lid); if (l) l.qty = num(v); };
IN.lineNote = (v, d) => { const l = lineBy(d.lid); if (l) l.note = v; };
ACT.noteOpen = d => { const l = lineBy(d.lid); l.noteOpen = true; refresh('cartLines'); const i = $(`[data-in=lineNote][data-lid="${d.lid}"]`); if (i) i.focus(); };
ACT.rmLine = d => { S.cart.lines = S.cart.lines.filter(l => l.lid !== d.lid); if (!S.cart.lines.some(l => l.kind === 'checkout') && S.cart.mode === 'equipment') render(); else refresh('cartLines', 'finder', 'savebar'); };
ACT.jobAll = () => openModal('job', { target: 'all' });
ACT.pickJob = d => openModal('job', { target: d.lid });

// Job code picker
MODALS.job = () => {
  const m = S.modal;
  return modal('Choose a Job code', `<label class="field-search">${icon('search', 20)}<input type="search" placeholder="Customer, job or address" aria-label="Search Job codes" value="${esc(m.q || '')}" data-in="jobQ" data-autofocus autocomplete="off"></label>
    ${jobsStale() ? `<div class="msg warn small">The Job code list was last updated ${ago(S.jobs.synced_at)}. A new job may be missing.</div>` : ''}
    ${region('jobRes', jobResHtml)}`);
};
function jobsStale() { return S.jobs.synced_at && Date.now() - new Date(S.jobs.synced_at).getTime() > 36 * 3600000; }
let recentCache = [];
function jobResHtml() {
  const q = (S.modal && S.modal.q) || '';
  if (!q) {
    const rec = recentCache.map(jobOf).filter(Boolean);
    return rec.length ? `<h3 class="sec-h">Recent</h3><div class="card flat list">${rec.map(jobLi).join('')}</div>` : '<div class="empty">Type part of the customer or job name.</div>';
  }
  const res = searchJobs(q);
  return res.length ? `<div class="card flat list">${res.map(jobLi).join('')}</div>` : '<div class="empty">No Job code matches.</div>';
}
function jobLi(j) {
  const parts = j.full.split(/\s*:\s*|\s*=>\s*/);
  return `<button class="row-i" data-act="setJob" data-id="${j.id}"><span class="grow"><span class="t">${esc(parts[parts.length - 1])}</span>
    ${parts.length > 1 ? `<span class="s">${esc(parts.slice(0, -1).join(' › '))}</span>` : ''}
    ${j.addr ? `<span class="s addr">${icon('pin', 14)}${esc(j.addr)}</span>` : ''}</span></button>`;
}
IN.jobQ = v => { S.modal.q = v; refresh('jobRes'); };
const _openModal = openModal;
openModal = async (kind, params) => { if (kind === 'job') recentCache = await recentJobs(); _openModal(kind, params); };
ACT.setJob = async d => {
  const id = Number(d.id); const m = S.modal;
  if (m.onPick) { m.onPick(id); }
  else if (m.target === 'all') {
    const prev = S.cart.jobAll; S.cart.jobAll = id;
    S.cart.lines.forEach(l => { if (l.kind !== 'checkin' && (!l.jobcode_id || l.jobcode_id === prev)) l.jobcode_id = id; });
  } else { const l = lineBy(m.target); if (l) l.jobcode_id = id; }
  await rememberJob(id); closeModal();
  if (!m.onPick) { if (S.screen === 'cart') render(); }
};

// ------------------------------------------------------------------ check and save
ACT.review = () => {
  const c = S.cart;
  c.lines = c.lines.filter(l => num(l.qty) > 0);
  if (!c.lines.length) return toast('The Cart is empty');
  if (c.lines.some(l => l.kind !== 'checkin' && !l.jobcode_id)) { render(); return toast(c.jobAll ? 'Every line needs a Job code' : 'Choose the Job code first'); }
  _go('review', {});
};
SCREENS.review = () => {
  const c = S.cart; if (!c) return pageHead('Check and save', '', 'home');
  const groups = new Map();
  for (const l of c.lines) { const k = l.jobcode_id || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const short = c.lines.filter(l => l.kind === 'take' && num(l.qty) > num((item(l.item_id) || {}).qty));
  const verbs = [...new Set(c.lines.map(l => MODES[l.kind]))].join(', ');
  return `<div class="review">${pageHead(c.correction ? `Check your Correction to Cart ${c.correction.cart_id}` : 'Check and save', '', 'cart', 'Cart')}
    <p class="lead">${esc(verbs)} by <b>${esc(S.user.name)}</b>${c.obo ? ` for <b>${esc(userName(c.obo))}</b>` : ''}. Each Job code gets its own billing document.</p>
    ${[...groups.entries()].map(([job, ls]) => `<section class="card flat"><h2 class="card-h">${job ? esc(jobLabel(job)) : 'Equipment coming back'}${job && jobAddr(job) ? `<span class="addr">${esc(jobAddr(job))}</span>` : ''}</h2>
      ${ls.map(l => { const it = item(l.item_id) || {}; return `<div class="rv-row"><span class="grow">${l.kind !== 'take' ? `<span class="tag ${l.kind}">${MODES[l.kind]}</span> ` : ''}<span class="t">${esc(it.name)}</span>
        <span class="s"><span class="num">${esc(it.number || '')}</span></span>${l.note ? `<span class="s note">${esc(l.note)}</span>` : ''}</span><b class="rv-q">${fmtQty(l.qty)}</b></div>`; }).join('')}</section>`).join('')}
    ${short.length ? `<div class="msg warn">More than the app thinks is on the shelf: ${short.map(l => esc(item(l.item_id).name)).join(', ')}. It will be saved and Managers will be asked to recount.</div>` : ''}
    <label class="f">Note for the whole Cart (optional)<textarea data-in="cartNote" rows="2" placeholder="e.g. Rough-in, second floor">${esc(c.note)}</textarea>
      <span class="hint">Goes on every billing document from this Cart. For one job only, use a line note.</span></label>
    ${c.correction ? `<label class="f">Correction note (optional)<input type="text" data-in="corrNote" value="${esc(c.correctionNote || '')}" placeholder="e.g. Took 6, not 8">
      <span class="hint">The original Cart stays on record. Billing documents for the Job codes this changes are replaced with a corrected version.</span></label>` : ''}
    <div class="savebar two"><button class="btn big" data-act="go" data-to="cart">Back</button><button class="btn primary big" data-act="saveCart">${c.correction ? 'Save Correction' : 'Save'}</button></div></div>`;
};
IN.cartNote = v => { S.cart.note = v; };
IN.corrNote = v => { S.cart.correctionNote = v; };
ACT.saveCart = async () => {
  const c = S.cart;
  const lines = c.lines.map(l => ({ kind: l.kind, item_id: l.item_id, qty: num(l.qty), jobcode_id: l.jobcode_id || null, note: l.note || '',
    checkout_id: l.checkout_id || undefined, link_line_id: l.link_line_id || undefined }));
  if (c.correction) await queue('correction', { cart_id: c.correction.cart_id, lines, note: c.note, correction_note: c.correctionNote || '' });
  else await queue('cart', { lines, note: c.note, on_behalf_of: c.obo || undefined, pick_id: c.pick_id || undefined });
  for (const l of lines) if (l.jobcode_id) await rememberJob(l.jobcode_id);
  S.cart = null; S.modal = null; go('home');
  toast(c.correction ? 'Correction saved' : 'Saved', 2500);
};

// ------------------------------------------------------------------ scanning
ACT.scan = d => openModal('scan', { for: d.for });
MODALS.scan = () => modal('Scan a label', `<video class="scan" playsinline muted></video><p class="muted small">Point the camera at the QR code or barcode.</p>`,
  `<button class="btn" data-act="close">Close</button>`);
const _closeModal = closeModal;
closeModal = () => { Scanner.stop(); _closeModal(); };
const _renderModal = renderModal;
renderModal = () => {
  _renderModal();
  if (S.modal && S.modal.kind === 'scan' && !Scanner.stream) {
    const v = $('#modal-host video');
    Scanner.start(v, code => {
      const forWhat = S.modal && S.modal.for; closeModal();
      const it = itemByCode(code);
      if (!it) return toast('No item with code ' + code);
      if (forWhat === 'cart') addToCart(it.id);
      else if (forWhat === 'catalogue') openItem(it.id);
      else if (forWhat === 'lines' && S.lineEditor) S.lineEditor.add(it.id);
    }).catch(e => { toast('Camera not available: ' + e.message); closeModal(); });
  }
  fillPhotos($('#modal-host'));
};
const _render = render;
render = () => { _render(); fillPhotos(); };

// ------------------------------------------------------------------ entries and Corrections
SCREENS.entries = () => {
  const me = S.user.id; const days = num(setting('correction_days', 14));
  const cutoff = Date.now() - days * 86400000;
  const mine = c => isManager() && S.params.all ? true : (c.entered_by === me || c.on_behalf_of === me);
  const carts = (S.snap.carts || []).filter(c => mine(c) && new Date(c.received_at).getTime() > cutoff);
  const pend = V().pendingCarts.filter(o => o.user_id === me || (o.data && o.data.on_behalf_of === me));
  return `${pageHead(S.params.all ? 'All Carts' : 'My entries', isManager() ? `<div class="seg small">
      <button class="${S.params.all ? '' : 'on'}" data-act="go" data-to="entries">Mine</button><button class="${S.params.all ? 'on' : ''}" data-act="go" data-to="entries" data-all="1">Everyone</button></div>` : '')}
    <p class="muted sub">Tap a Cart to correct it. Carts can be corrected for ${days} days.</p>
    <div class="card flat list">
      ${pend.map(o => `<div class="row-i static"><span class="grow"><span class="t">Waiting to send</span><span class="s">${fmtDT(o.at)} · ${plural((o.data.lines || []).length, 'item')}</span></span><span class="pill warn">Not sent yet</span></div>`).join('')}
      ${carts.map(c => `<button class="row-i" data-act="openCart" data-id="${c.id}"><span class="grow"><span class="t clip">${esc(cartJobs(c))}</span>
        <span class="s">Cart ${c.id} · ${fmtDT(c.received_at)}${S.params.all || c.on_behalf_of ? ' · ' + esc(userName(c.on_behalf_of || c.entered_by)) : ''}</span></span>
        ${c.cancelled ? '<span class="pill bad">Cancelled</span>' : c.corrections ? `<span class="pill">Corrected</span>` : ''}${icon('chevron', 18, 'class="ico chev"')}</button>`).join('')}
      ${!carts.length && !pend.length ? `<div class="empty">No Carts in the last ${days} days.</div>` : ''}
    </div>`;
};
ACT.openCart = d => openModal('cartDetail', { id: Number(d.id) });
MODALS.cartDetail = () => {
  const c = (S.snap.carts || []).find(x => x.id === S.modal.id); if (!c) return modal('Cart', 'Not found');
  const pending = S.outbox.some(o => o.op === 'correction' && o.data.cart_id === c.id);
  const can = !c.cancelled && !pending && (c.entered_by === S.user.id || c.on_behalf_of === S.user.id || isManager());
  const rows = [...c.lines.map(l => ({ ...l })), ...c.equipment];
  return modal(`Cart ${c.id}`, `<dl class="kv"><dt>Saved</dt><dd>${fmtDT(c.received_at)}</dd><dt>Entered by</dt><dd>${esc(userName(c.entered_by))}</dd>
      ${c.on_behalf_of ? `<dt>For</dt><dd>${esc(userName(c.on_behalf_of))}</dd>` : ''}${c.note ? `<dt>Note</dt><dd>${esc(c.note)}</dd>` : ''}</dl>
    ${c.cancelled ? '<div class="msg bad">This Cart was cancelled.</div>' : ''}${pending ? '<div class="msg warn">A Correction is waiting to send.</div>' : ''}
    <div class="card flat">${rows.map(l => { const it = item(l.item_id) || {}; return `<div class="rv-row"><span class="grow"><span class="tag ${l.kind}">${MODES[l.kind]}</span> <span class="t">${esc(it.name)}</span>
      <span class="s">${esc(jobLabel(l.jobcode_id))}${l.note ? ' · ' + esc(l.note) : ''}</span></span><b class="rv-q">${fmtQty(l.qty)}</b></div>`; }).join('') || '<div class="empty">No lines</div>'}</div>
    ${c.equipment.length ? '<p class="muted small">Equipment lines cannot be corrected here; check the item in or out again instead.</p>' : ''}`,
    can ? `<button class="btn danger" data-act="cancelCart" data-id="${c.id}">Cancel Cart</button><span class="grow"></span>
      <button class="btn primary" data-act="correctCart" data-id="${c.id}" ${c.lines.length ? '' : 'disabled'}>Correct</button>` : '');
};
ACT.correctCart = d => {
  const c = S.snap.carts.find(x => x.id === Number(d.id));
  const jobs = [...new Set(c.lines.map(l => l.jobcode_id))];
  S.cart = { mode: 'take', q: '', note: c.note || '', obo: null, jobAll: jobs.length === 1 ? jobs[0] : null, correction: { cart_id: c.id },
    lines: c.lines.map(l => ({ lid: uuid(), kind: l.kind, item_id: l.item_id, qty: num(l.qty), jobcode_id: l.jobcode_id, note: l.note || '' })) };
  S.modal = null; _go('cart', {});
};
ACT.cancelCart = async d => {
  if (!confirm(`Cancel Cart ${d.id}? Its Take outs and Returns are undone and its billing documents are marked cancelled.`)) return;
  const note = prompt('Correction note (optional)', '') || '';
  await queue('correction', { cart_id: Number(d.id), cancel: true, lines: [], correction_note: note });
  S.cart = null; closeModal(); go('home'); toast('Cart cancelled');
};

// ------------------------------------------------------------------ catalogue
const CHIPS = [['', 'All'], ['consumable', 'Consumables'], ['equipment', 'Equipment'], ['low', 'Low stock'], ['out', 'Checked out']];
SCREENS.catalogue = () => {
  const p = S.params; p.q = p.q || '';
  const locs = [...V().locations.values()].filter(l => !l.archived);
  const tags = [...new Set(V().itemList.flatMap(i => i.tags || []))].sort();
  const chipOn = k => (k === 'consumable' || k === 'equipment') ? p.kind === k && !p.stock : (k === 'low' || k === 'out') ? p.stock === k : !p.kind && !p.stock;
  const desk = isDesk();
  const actions = isManager() ? `${desk ? `<button class="btn" data-act="catCsv">Export CSV</button>` : ''}
    <button class="btn" data-act="labelMode">${p.labels ? 'Done choosing' : 'Print labels'}</button>
    <button class="btn primary" data-act="newItem">${isWide() ? 'New item' : icon('plus', 20)}</button>` : '';
  const list = `<div class="cat-tools">
      <div class="search-row"><label class="field-search">${icon('search', 20)}<input type="search" placeholder="Search name, Item number, tag" aria-label="Search the catalogue" value="${esc(p.q)}" data-in="catQ" data-autofocus autocomplete="off"></label>
        ${Scanner.supported() ? `<button class="btn icon-btn" data-act="scan" data-for="catalogue" aria-label="Scan a label">${icon('scan', 22)}</button>` : ''}</div>
      <div class="chips">${CHIPS.map(([k, l]) => `<button class="chip-f ${chipOn(k) ? 'on' : ''}" aria-pressed="${chipOn(k)}" data-act="catChip" data-k="${k}">${l}</button>`).join('')}
        ${locs.length ? `<select class="chip-sel" data-ch="catF" data-f="loc" aria-label="Location"><option value="">Any location</option>${locs.map(l => `<option value="${l.id}" ${p.loc === l.id ? 'selected' : ''}>${esc(locPath(l.id))}</option>`).join('')}</select>` : ''}
        ${tags.length ? `<select class="chip-sel" data-ch="catF" data-f="tag" aria-label="Tag"><option value="">Any tag</option>${tags.map(t => `<option ${p.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        <select class="chip-sel" data-ch="catF" data-f="sort" aria-label="Sort"><option value="">Name</option><option value="number" ${p.sort === 'number' ? 'selected' : ''}>Item number</option><option value="qty" ${p.sort === 'qty' ? 'selected' : ''}>Count</option><option value="changed" ${p.sort === 'changed' ? 'selected' : ''}>Last change</option></select>
        ${isManager() ? `<button class="chip-f ${p.stock === 'archived' ? 'on' : ''}" data-act="catChip" data-k="archived">Archived</button>` : ''}</div>
      ${p.labels ? `<div class="msg info row"><span class="grow">Tick items, then print. Labels fit 30-per-sheet address label paper.</span>
        <button class="btn small" data-act="labelAll">Tick all shown</button><button class="btn small primary" data-act="printLabels">Print ${(p.picked || []).length} labels</button></div>` : ''}
    </div>${region('catList', catListHtml)}`;
  if (desk) return `<div class="cat-desk"><section class="cat-main">${pageHead('Catalogue', actions)}${list}</section>
    <aside class="cat-side" aria-label="Selected item">${region('catSide', catSideHtml)}</aside></div>`;
  return `${pageHead('Catalogue', actions)}${list}`;
};
ACT.catChip = d => {
  const p = S.params;
  if (d.k === 'consumable' || d.k === 'equipment') { p.kind = p.kind === d.k ? '' : d.k; p.stock = ''; }
  else if (d.k) { p.stock = p.stock === d.k ? '' : d.k; if (d.k !== 'archived') p.kind = ''; }
  else { p.kind = ''; p.stock = ''; }
  render();
};
function catFiltered() {
  const p = S.params;
  let list = p.stock === 'archived' ? V().itemList.filter(i => i.archived) : searchItems(p.q, () => true, 5000);
  if (p.stock === 'archived' && p.q) list = list.filter(i => norm(i.name + ' ' + i.number).includes(norm(p.q)));
  list = list.filter(i => (!p.kind || i.kind === p.kind) && (!p.loc || i.location_id === p.loc) && (!p.tag || (i.tags || []).includes(p.tag)));
  if (p.stock === 'low') list = list.filter(i => i.low_stock !== null && i.low_stock !== undefined && num(i.qty) <= num(i.low_stock) || num(i.qty) < 0);
  if (p.stock === 'out') { const out = new Set(V().checkouts.map(c => c.item_id)); list = list.filter(i => out.has(i.id)); }
  const by = { number: (a, b) => String(a.number).localeCompare(String(b.number)), qty: (a, b) => num(a.qty) - num(b.qty),
    changed: (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) }[p.sort];
  return by ? list.slice().sort(by) : list;
}
function catListHtml() {
  const p = S.params; const list = catFiltered();
  if (!list.length) return `<div class="empty card flat">${V().itemList.length ? 'Nothing matches.' : 'The catalogue is empty.' + (isManager() ? ' Add the first item with New item.' : '')}</div>`;
  const picked = new Set(p.picked || []);
  const shown = list.slice(0, 400);
  const more = list.length > 400 ? '<div class="empty">Showing the first 400. Search to narrow it down.</div>' : '';
  if (isDesk() && !p.labels) {
    return `<p class="muted sub">${plural(list.length, 'item')}</p><div class="card flat table-wrap"><table class="t">
      <thead><tr><th>Item number</th><th>Name</th><th>Location</th><th>Tags</th><th class="right">On shelf</th></tr></thead>
      <tbody>${shown.map(i => `<tr class="click ${p.sel === i.id ? 'sel' : ''}" data-act="openItem" data-id="${i.id}"><td class="num">${esc(i.number || 'new')}</td><td class="t">${esc(i.name)}</td>
        <td class="muted">${esc(locPath(i.location_id))}</td><td class="muted">${esc((i.tags || []).join(', '))}</td>
        <td class="n nowrap"><b>${i.kind === 'equipment' && !i.counted ? '' : fmtQty(i.qty)}</b> <span class="st ${stockState(i)}">${esc(stockState(i) === 'ok' && !(i.kind === 'equipment' && !i.counted) ? '' : stockWord(i))}</span></td></tr>`).join('')}</tbody></table></div>${more}`;
  }
  return `<p class="muted sub">${plural(list.length, 'item')}</p><div class="card flat list">${shown.map(i =>
    p.labels ? `<label class="row-i"><input type="checkbox" data-ch="pickLabel" data-id="${i.id}" ${picked.has(i.id) ? 'checked' : ''} class="big-check">
      <span class="grow"><span class="t">${esc(i.name)}</span><span class="s num">${esc(i.number || 'new')}</span></span></label>` : itemRow(i, 'openItem')).join('')}</div>${more}`;
}
IN.catQ = v => { S.params.q = v; refresh('catList'); fillPhotos(); };
CH.catF = (v, d) => { S.params[d.f] = v; refresh('catList'); fillPhotos(); };
ACT.labelMode = () => { S.params.labels = !S.params.labels; S.params.picked = []; render(); };
CH.pickLabel = (v, d, el) => { const s = new Set(S.params.picked || []); el.checked ? s.add(d.id) : s.delete(d.id); S.params.picked = [...s]; const b = $('[data-act=printLabels]'); if (b) b.textContent = `Print ${s.size} labels`; };
ACT.labelAll = () => { S.params.picked = catFiltered().filter(i => i.number).map(i => i.id); render(); };
ACT.printLabels = () => { const its = (S.params.picked || []).map(item).filter(i => i && i.number); if (!its.length) return toast('Tick some items first'); printLabels(its); };
ACT.catCsv = () => downloadCsv('catalogue.csv', [['Item number', 'Name', 'Type', 'Location', 'Tags', 'On shelf', 'Low-stock level'],
  ...catFiltered().map(i => [i.number, i.name, i.kind, locPath(i.location_id), (i.tags || []).join(', '), i.kind === 'equipment' && !i.counted ? onShelf(i) : fmtQty(i.qty), i.low_stock ?? ''])]);
function openItem(id) {
  if (S.screen === 'catalogue' && isDesk()) { S.params.sel = id; refresh('catList', 'catSide'); fillPhotos(); }
  else openModal('item', { id });
}
ACT.openItem = d => openItem(d.id);
function catSideHtml() {
  const i = S.params.sel && item(S.params.sel);
  if (!i) return `<div class="empty">Choose an item to see its details.</div>`;
  return `<div class="stack">${itemDetail(i)}<div class="side-actions">${itemActions(i)}</div></div>`;
}
function itemDetail(i) {
  const v = V(); const outs = v.checkouts.filter(c => c.item_id === i.id);
  const photos = [...((S.snap.photos || {})[i.id] || []), ...S.outbox.filter(o => o.op === 'photo_add' && o.data.item_id === i.id).map(o => o.data.id)];
  const fields = [...v.fields.values()].filter(f => !f.archived && i.custom && i.custom[f.id] !== undefined && i.custom[f.id] !== '');
  const indiv = i.kind === 'equipment' && !i.counted;
  return `<div class="item-head"><span class="num">${esc(i.number || 'new')}</span><h2>${esc(i.name)}</h2>
      ${stockState(i) !== 'ok' ? `<span class="pill ${stockState(i) === 'low' ? 'warn' : stockState(i) === 'bad' ? 'bad' : ''}">${esc(stockWord(i))}</span>` : ''}</div>
    ${photos.length ? `<div class="photos">${photos.map(id => `<img data-photo="${id}" alt="">`).join('')}</div>` : ''}
    <div class="mini-stats"><div><span>${indiv ? 'Status' : 'On shelf'}</span><b>${indiv ? esc(onShelf(i)) : fmtQty(i.qty)}</b></div>
      ${i.low_stock !== null && i.low_stock !== undefined ? `<div><span>Alert at</span><b>${fmtQty(i.low_stock)}</b></div>` : ''}</div>
    <dl class="kv"><dt>Type</dt><dd>${i.kind === 'equipment' ? (i.counted ? 'Equipment, counted' : 'Equipment, one piece') : 'Consumable'}</dd>
      <dt>Location</dt><dd>${esc(locPath(i.location_id) || 'None')}</dd>
      ${(i.tags || []).length ? `<dt>Tags</dt><dd>${esc(i.tags.join(', '))}</dd>` : ''}
      ${i.description ? `<dt>Notes</dt><dd>${esc(i.description)}</dd>` : ''}
      ${fields.map(f => `<dt>${esc(f.name)}</dt><dd>${esc(fieldShow(f, i.custom[f.id]))}</dd>`).join('')}</dl>
    ${outs.length ? `<h3 class="sec-h">Checked out</h3><div class="card flat">${outs.map(c => `<div class="rv-row"><span class="grow"><span class="t">${esc(userName(c.user_id))}</span><span class="s">since ${fmtD(c.opened_at)} · ${esc(jobLabel(c.jobcode_id))}</span></span><b class="rv-q">${fmtQty(num(c.qty) - num(c.qty_returned))}</b></div>`).join('')}</div>` : ''}
    ${i.number ? `<div class="qr-row"><div class="qr">${qrSvg(i.number)}</div><span class="muted small">Label code ${esc(i.number)}</span></div>` : ''}`;
}
function itemActions(i) {
  if (!isManager()) return '';
  return `<button class="btn primary" data-act="editItem" data-id="${i.id}">Edit</button>
    <button class="btn" data-act="adjustOne" data-id="${i.id}">Adjust count</button>
    <button class="btn" data-act="history" data-id="${i.id}">History</button>
    ${i.number ? `<button class="btn" data-act="printOne" data-id="${i.id}">Print label</button>` : ''}
    <label class="btn">Add photo<input type="file" accept="image/*" capture="environment" data-ch="addPhoto" data-id="${i.id}" hidden></label>
    ${i.kind === 'equipment' && !i.counted ? `<button class="btn" data-act="eqStatus" data-id="${i.id}">Set status</button>` : ''}`;
}
MODALS.item = () => {
  const i = item(S.modal.id); if (!i) return modal('Item', 'Not found');
  return modal('Item', itemDetail(i), itemActions(i));
};
function fieldShow(f, v) { if (f.ftype === 'bool') return v ? 'Yes' : 'No'; if (f.ftype === 'date') return fmtD(v + 'T12:00:00Z'); return String(v); }
ACT.printOne = d => printLabels([item(d.id)]);
ACT.history = d => { closeModal(); go('reports', { kind: 'flow', item: d.id }); };
ACT.adjustOne = d => { closeModal(); S.le = S.le || {}; S.le.adjust = { lines: [], note: '' }; go('adjust'); addEdLine('adjust', d.id); };
CH.addPhoto = async (v, d, el) => {
  const f = el.files && el.files[0]; if (!f) return;
  const data = await resizePhoto(f); const id = uuid();
  S.photoCache.set(id, data); await DB.put('photos', data, id);
  await queue('photo_add', { id, item_id: d.id, data }); if (S.modal) renderModal(); else refresh('catSide'); fillPhotos(); toast('Photo added');
};
ACT.eqStatus = d => openModal('eqStatus', { id: d.id });
MODALS.eqStatus = () => {
  const i = item(S.modal.id);
  return modal(`Status of ${esc(i.name)}`, `${i.status === 'checked_out' ? '<div class="msg warn">Checked out. Check it in first.</div>' : ''}
    <div class="stack">${['available', 'in_repair', 'lost', 'retired'].map(s => `<button class="btn big ${i.status === s ? 'primary' : ''}" data-act="setEq" data-s="${s}" ${i.status === 'checked_out' ? 'disabled' : ''}>${({ available: 'Available', in_repair: 'In repair', lost: 'Lost', retired: 'Retired' })[s]}</button>`).join('')}</div>`);
};
ACT.setEq = async d => { await queue('equipment_status', { item_id: S.modal.id, status: d.s }); closeModal(); toast('Status saved'); render(); };

// Item editor (Managers)
ACT.newItem = () => openModal('editItem', { draft: { id: uuid(), kind: 'consumable', name: '', description: '', location_id: '', tags: [], custom: {}, low_stock: '', counted: false }, isNew: true });
ACT.editItem = d => { const i = item(d.id); openModal('editItem', { draft: JSON.parse(JSON.stringify({ ...i, low_stock: i.low_stock ?? '' })), isNew: false }); };
MODALS.editItem = () => {
  const m = S.modal; const x = m.draft; const fields = [...V().fields.values()].filter(f => !f.archived).sort((a, b) => a.sort - b.sort);
  const locs = [...V().locations.values()].filter(l => !l.archived);
  return modal(m.isNew ? 'New item' : `Edit ${esc(x.number || '')}`, `
    ${m.isNew ? `<div class="seg"><button class="${x.kind === 'consumable' ? 'on' : ''}" data-act="draftKind" data-k="consumable">Consumable</button><button class="${x.kind === 'equipment' ? 'on' : ''}" data-act="draftKind" data-k="equipment">Equipment</button></div>
      ${x.kind === 'equipment' ? `<label class="check"><input type="checkbox" data-ch="draft" data-f="counted" ${x.counted ? 'checked' : ''}> Counted type (e.g. 12 scaffold frames), not one individual piece</label>` : ''}
      <p class="hint">The Item number is given automatically and never changes.</p>` : ''}
    <label class="f">Name<input type="text" value="${esc(x.name)}" data-in="draft" data-f="name" data-autofocus></label>
    <div class="grid2">
      <label class="f">Location<select data-ch="draft" data-f="location_id"><option value="">None</option>${locs.map(l => `<option value="${l.id}" ${x.location_id === l.id ? 'selected' : ''}>${esc(locPath(l.id))}</option>`).join('')}</select></label>
      <label class="f">Low-stock level<input type="number" inputmode="decimal" value="${esc(x.low_stock)}" data-in="draft" data-f="low_stock" placeholder="No alert"></label>
    </div>
    <label class="f">Tags (comma between)<input type="text" value="${esc((x.tags || []).join(', '))}" data-in="draftTags"></label>
    <label class="f">Notes<textarea data-in="draft" data-f="description" rows="2">${esc(x.description)}</textarea></label>
    ${fields.map(f => fieldInput(f, x.custom[f.id])).join('')}
    ${m.isNew ? `<p class="hint">After saving, use Adjust counts to enter how many are on the shelf.</p>` : `<label class="check"><input type="checkbox" data-ch="draft" data-f="archived" ${x.archived ? 'checked' : ''}> Archived (hidden, never deleted)</label>`}`,
    `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="saveItem">Save</button>`);
};
function fieldInput(f, v) {
  const a = `data-ch="draftField" data-in="draftField" data-id="${f.id}"`;
  if (f.ftype === 'bool') return `<label class="check"><input type="checkbox" ${v ? 'checked' : ''} ${a}> ${esc(f.name)}</label>`;
  if (f.ftype === 'choice') return `<label class="f">${esc(f.name)}<select ${a}><option value=""></option>${(f.options || []).map(o => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  return `<label class="f">${esc(f.name)}<input type="${f.ftype === 'number' ? 'number' : f.ftype === 'date' ? 'date' : 'text'}" value="${esc(v ?? '')}" ${a}></label>`;
}
ACT.draftKind = d => { S.modal.draft.kind = d.k; renderModal(); };
IN.draft = (v, d) => { S.modal.draft[d.f] = v; };
CH.draft = (v, d, el) => { S.modal.draft[d.f] = el.type === 'checkbox' ? el.checked : v; if (d.f === 'counted') renderModal(); };
IN.draftTags = v => { S.modal.draft.tags = v.split(',').map(s => s.trim()).filter(Boolean); };
IN.draftField = CH.draftField = (v, d, el) => { S.modal.draft.custom[d.id] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (v === '' ? '' : num(v)) : v); };
ACT.saveItem = async () => {
  const x = S.modal.draft; const isNew = S.modal.isNew; if (!x.name.trim()) return toast('Give it a name');
  const data = { id: x.id, kind: x.kind, name: x.name.trim(), description: x.description || '', location_id: x.location_id || null,
    tags: x.tags || [], custom: x.custom || {}, low_stock: x.low_stock === '' ? null : num(x.low_stock), counted: !!x.counted, archived: !!x.archived };
  await queue('item_save', data); closeModal(); toast(isNew ? 'Item added. Use Adjust counts to enter how many there are.' : 'Saved', 3500);
  if (S.screen === 'catalogue' && isDesk()) S.params.sel = x.id;
  render();
};

// ------------------------------------------------------------------ pick lists (picking)
SCREENS.picks = () => {
  const picks = V().picks.filter(p => p.status === 'open');
  return `${pageHead('Pick lists', isManager() ? '<button class="btn primary" data-act="editPick">New pick list</button>' : '', isWide() ? null : 'more', 'More')}
    <div class="card flat list">${picks.map(p => `<div class="row-i static"><span class="grow"><span class="t">${esc(p.name)}</span>
      <span class="s">${esc(jobLabel(p.jobcode_id))} · ${plural(p.lines.length, 'line')} · ${p.lines.filter(l => l.picked).length} picked</span></span>
      ${isManager() ? `<button class="btn small" data-act="editPick" data-id="${p.id}">Edit</button>` : ''}
      <button class="btn small primary" data-act="go" data-to="pick" data-id="${p.id}">Pick</button></div>`).join('') || '<div class="empty">No open pick lists.</div>'}</div>`;
};
SCREENS.pick = () => {
  const p = V().picks.find(x => x.id === S.params.id); if (!p) return pageHead('Pick list', '', 'picks', 'Pick lists') + '<div class="empty">Not found</div>';
  S.pickDraft = S.pickDraft && S.pickDraft.id === p.id ? S.pickDraft : JSON.parse(JSON.stringify(p));
  const x = S.pickDraft;
  return `${pageHead(esc(x.name), `<span class="pill">${esc(jobLabel(x.jobcode_id))}</span>`, 'picks', 'Pick lists')}
    <div class="card flat list">${x.lines.map((l, n) => { const it = item(l.item_id) || {}; return `<label class="row-i">
      <input type="checkbox" data-ch="pickTick" data-n="${n}" ${l.picked ? 'checked' : ''} class="big-check">
      <span class="grow"><span class="t">${esc(it.name)}</span><span class="s"><span class="num">${esc(it.number || '')}</span> · ${esc(locPath(it.location_id) || 'No location')} · ${esc(onShelf(it))}</span></span>
      <span class="q">${fmtQty(l.qty)}</span></label>`; }).join('')}</div>
    <p class="hint">Finishing makes a Take out Cart for this Job code. You can change it before saving.</p>
    <div class="savebar"><button class="btn primary big" data-act="finishPick">Finish and make Take out</button></div>`;
};
CH.pickTick = (v, d, el) => { S.pickDraft.lines[d.n].picked = el.checked; queue('pick_progress', { id: S.pickDraft.id, lines: S.pickDraft.lines }); };
ACT.finishPick = () => {
  const x = S.pickDraft;
  const lines = x.lines.filter(l => l.picked).map(l => ({ lid: uuid(), kind: 'take', item_id: l.item_id, qty: num(l.qty), jobcode_id: x.jobcode_id, note: '' }));
  if (!lines.length) return toast('Tick what you picked first');
  S.cart = { mode: 'take', q: '', note: x.name, obo: null, jobAll: x.jobcode_id, correction: null, pick_id: x.id, lines };
  S.pickDraft = null; _go('cart', {});
};

// ------------------------------------------------------------------ stock counts (counting)
const COUNT_STATUS = { open: 'Open', submitted: 'Counted, waiting for review', applied: 'Applied', cancelled: 'Cancelled' };
SCREENS.counts = () => {
  const me = S.user.id;
  const list = V().counts.filter(c => isManager() || (c.assigned_to === me && c.status === 'open'));
  return `${pageHead('Stock counts', isManager() ? '<button class="btn primary" data-act="newCount">New count</button>' : '', isWide() ? null : 'more', 'More')}
    <div class="card flat list">${list.map(c => `<div class="row-i static"><span class="grow"><span class="t">${esc(c.name)}</span>
      <span class="s">${COUNT_STATUS[c.status]} · ${c.assigned_to ? esc(userName(c.assigned_to)) : 'Anyone'} · ${plural(c.lines.length, 'item')}</span></span>
      ${c.status === 'open' && (c.assigned_to === me || isManager()) ? `<button class="btn small primary" data-act="go" data-to="count" data-id="${c.id}">Count</button>` : ''}
      ${c.status === 'submitted' && isManager() ? `<button class="btn small primary" data-act="go" data-to="countReview" data-id="${c.id}">Review</button>` : ''}</div>`).join('') || '<div class="empty">No counts.</div>'}</div>`;
};
SCREENS.count = () => {
  const c = V().counts.find(x => x.id === S.params.id); if (!c) return pageHead('Count', '', 'counts', 'Counts') + '<div class="empty">Not found</div>';
  S.countDraft = S.countDraft && S.countDraft.id === c.id ? S.countDraft : JSON.parse(JSON.stringify(c));
  const x = S.countDraft;
  return `${pageHead(esc(x.name), '', 'counts', 'Counts')}
    <p class="muted sub">Enter what is on the shelf. Leave blank anything you did not count.</p>
    <div class="card flat list">${x.lines.map((l, n) => { const it = item(l.item_id) || {}; return `<div class="row-i static">
      <span class="grow"><span class="t">${esc(it.name)}</span><span class="s"><span class="num">${esc(it.number || '')}</span> · ${esc(locPath(it.location_id) || 'No location')}</span></span>
      <input type="number" inputmode="decimal" class="count-in" value="${l.counted ?? ''}" data-in="countIn" data-n="${n}" aria-label="Counted ${esc(it.name)}"></div>`; }).join('')}</div>
    <div class="savebar two"><button class="btn big" data-act="saveCount">Save for later</button><button class="btn primary big" data-act="submitCount">Finished counting</button></div>`;
};
IN.countIn = (v, d) => { S.countDraft.lines[d.n].counted = v === '' ? null : num(v); };
ACT.saveCount = async () => { await queue('count_save', { id: S.countDraft.id, lines: S.countDraft.lines }); toast('Saved'); };
ACT.submitCount = async () => {
  await queue('count_save', { id: S.countDraft.id, lines: S.countDraft.lines, status: 'submitted' });
  S.countDraft = null; go('home'); toast('Count sent to the Managers');
};
