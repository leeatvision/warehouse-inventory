/* Everyday screens: setup, sign-in, home, Cart, My entries, catalogue, pick lists, stock counts. */
'use strict';

// ------------------------------------------------------------------ first-time setup
SCREENS.setup = () => {
  const firstManager = S.snap && !S.snap.users.some(u => u.role === 'manager' && u.hash);
  if (S.key && S.snap && firstManager) return setupFirstManager();
  return `<div class="panel pad stack" style="max-width:520px;margin:8vh auto">
    <h1>${esc(B.name || 'Warehouse')}</h1>
    <p class="muted">Set up this device once. A Manager has the device key.</p>
    ${S.setupMsg ? `<div class="msg warn">${esc(S.setupMsg)}</div>` : ''}
    ${!B.supabaseUrl ? `<div class="msg bad">This copy of the app has no server address, so it can only show placeholders.</div>` : ''}
    <label class="f">Device key<input type="password" id="dk" autocomplete="off" data-enter="saveKey" data-autofocus></label>
    <div class="row"><button class="btn primary" data-act="saveKey">Connect</button><span id="setupState" class="muted small"></span></div>
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
  return `<div class="panel pad stack" style="max-width:560px;margin:6vh auto">
    <h1>Set a Manager PIN</h1>
    <p class="muted">No Manager has a PIN yet. Pick yourself and choose a PIN (4 to 8 digits). After that, Managers set everyone else's PIN under People.</p>
    ${mgrs.length ? `<div class="names">${mgrs.map(u => `<button class="name" data-act="setPinFor" data-id="${u.id}" data-first="1">${esc(u.name)}</button>`).join('')}</div>`
      : `<div class="msg bad">Nobody is marked as a Manager in the database yet.</div>`}
  </div>`;
}

// ------------------------------------------------------------------ sign-in
SCREENS.boot = () => '<p class="boot">Loading…</p>';
SCREENS.signin = () => {
  const users = (S.snap && S.snap.users) || [];
  return `<div class="head"><h1>Who is using the tablet?</h1></div>
    ${storageWarning()}
    <div class="names">${users.map(u => `<button class="name" data-act="pickUser" data-id="${u.id}" ${u.hash ? '' : 'disabled'}>
      ${esc(u.name)}<small>${u.hash ? (u.role === 'manager' ? 'Manager' : '&nbsp;') : 'No PIN yet. Ask a Manager.'}</small></button>`).join('')}</div>
    ${!users.length ? '<div class="empty">No users yet. Check the connection under the status at the top.</div>' : ''}`;
};
function storageWarning() {
  const n = S.outbox.length; const out = [];
  if (n) out.push(`<div class="msg warn">${plural(n, 'entry', 'entries')} not sent yet. Until they are, do not clear this browser's data, sign it in to an account or uninstall the app. A Manager can save them to a file under Device and delivery.</div>`);
  if (S.persisted === false) out.push(`<div class="msg warn">This browser has not agreed to keep the app's data safe. It may clear it if the tablet runs low on space. A Manager should check Device and delivery.</div>`);
  return out.length ? `<div class="stack" style="margin-bottom:12px">${out.join('')}</div>` : '';
}
ACT.pickUser = d => openModal('pin', { userId: Number(d.id), entry: '', mode: 'signin', tries: 0 });
const pinLock = new Map();
MODALS.pin = () => {
  const m = S.modal; const u = V().users.get(m.userId);
  const title = m.mode === 'signin' ? esc(u.name) : m.step === 2 ? 'Enter the new PIN again' : `New PIN for ${esc(u.name)}`;
  const max = 8;
  return modal(title, `<div class="dots ${m.shake ? 'shake' : ''}">${Array.from({ length: Math.max(4, m.entry.length) }, (_, i) => `<i class="${i < m.entry.length ? 'on' : ''}"></i>`).join('')}</div>
    ${m.msg ? `<div class="msg ${m.msgKind || 'bad'}" style="text-align:center">${esc(m.msg)}</div>` : ''}
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="pinKey" data-k="${n}">${n}</button>`).join('')}
      <button data-act="pinKey" data-k="clear" style="font-size:16px">Clear</button><button data-act="pinKey" data-k="0">0</button>
      <button data-act="pinKey" data-k="ok" style="font-size:16px;background:var(--brand-500);color:var(--on-brand, #fff)">OK</button></div>
    <p class="muted small" style="text-align:center">${m.mode === 'signin' ? '' : '4 to ' + max + ' digits'}</p>`);
};
ACT.pinKey = async d => {
  const m = S.modal; m.shake = false; m.msg = '';
  if (d.k === 'clear') m.entry = '';
  else if (d.k === 'ok') return pinSubmit();
  else if (m.entry.length < 8) m.entry += d.k;
  if (m.mode === 'signin' && m.entry.length >= 4) {
    const u = V().users.get(m.userId);
    // Try automatically once the length could match; no message until OK is pressed.
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
  pinLock.delete(u.id); S.user = u; S.modal = null; lastTap = Date.now();
  go('home'); toast(`Signed in as ${u.name}`);
}
ACT.setPinFor = d => openModal('pin', { userId: Number(d.id), entry: '', mode: 'set', step: 1, firstSetup: !!d.first });

// ------------------------------------------------------------------ home
SCREENS.home = () => {
  const v = V(); const me = S.user.id;
  const mineOut = v.checkouts.filter(c => c.user_id === me).length;
  const openPicks = V().picks.filter(p => p.status === 'open').length;
  const myCounts = V().counts.filter(c => c.status === 'open' && (c.assigned_to === me || (isManager() && !c.assigned_to))).length;
  const alerts = isManager() ? alertList().length : 0;
  const tile = (to, title, sub, cls = '', count = 0) => `<button class="tile ${cls}" data-act="go" data-to="${to}">
    ${count ? `<span class="pill ${cls === 'alert' ? 'bad' : 'brand'} count">${count}</span>` : ''}<b>${title}</b><span>${sub}</span></button>`;
  return `<div class="stack">
    <div class="tiles">
      ${tile('cart', 'Take out / Return', 'Parts for a Job code, or bring them back', 'hero')}
      ${tile('cart?mode=checkout', 'Equipment', mineOut ? `You have ${plural(mineOut, 'item')} checked out` : 'Check out or check in', '', mineOut)}
      ${tile('entries', 'My entries', 'See and correct your Carts from the last 2 weeks')}
      ${tile('catalogue', 'Catalogue', 'Everything in the warehouse')}
      ${openPicks ? tile('picks', 'Pick lists', 'Lists prepared for a job', '', openPicks) : ''}
      ${myCounts ? tile('counts', 'Stock counts', 'Counts waiting for you', '', myCounts) : ''}
    </div>
    ${isManager() ? `<h3 style="margin-top:8px">Manager</h3><div class="tiles">
      ${tile('alerts', 'Alerts', alerts ? 'Things that need a look' : 'Nothing needs a look', alerts ? 'alert' : '', alerts)}
      ${tile('receive', 'Receive delivery', 'Add a supplier delivery to Stock')}
      ${tile('adjust', 'Adjust counts', 'Fix a count, with a reason')}
      ${tile('supplierReturn', 'Supplier return', 'Job material going straight back')}
      ${tile('pos', 'Purchase orders', 'Make, print and receive POs')}
      ${tile('picks', 'Pick lists', 'Prepare lists for a job')}
      ${tile('counts', 'Stock counts', 'Start and review counts')}
      ${tile('reports', 'Reports', 'History, stock, people, moves')}
      ${tile('people', 'People and PINs', 'Set PINs and Managers')}
      ${tile('setup2', 'Locations and fields', 'Shelves, bins and custom fields')}
      ${tile('status', 'Device and delivery', 'Sending, billing files, settings')}
    </div>` : `<div class="row"><button class="btn small" data-act="go" data-to="status">Device status</button></div>`}
  </div>`;
};
// Allow "screen?mode=x" in data-to.
const _go = go;
go = (screen, params = {}) => {
  const [s, q] = String(screen).split('?');
  if (q) new URLSearchParams(q).forEach((v, k) => { params[k] = v; });
  if (s === 'cart') { startCart(params.mode || 'take'); }
  return _go(s, params);
};

// ------------------------------------------------------------------ the Cart
function startCart(mode, extra = {}) {
  if (S.cart && !S.cart.correction && !extra.correction && !extra.lines) { S.cart.mode = mode; return; }
  S.cart = { mode, lines: [], note: '', obo: null, jobAll: null, q: '', correction: null, pick_id: null, ...extra };
}
const MODES = { take: 'Take out', return: 'Return', checkout: 'Check out', checkin: 'Check in' };
SCREENS.cart = () => {
  const c = S.cart;
  const modes = c.correction ? ['take', 'return'] : ['take', 'return', 'checkout', 'checkin'];
  return `<div class="head">${back()}<h1>${c.correction ? `Correcting Cart ${c.correction.cart_id}` : 'Cart'}</h1>
      ${isManager() && !c.correction ? `<label class="row small nowrap">For <select data-ch="obo" style="min-height:36px;width:auto">
        <option value="">${esc(S.user.name)} (me)</option>${[...V().users.values()].filter(u => u.id !== S.user.id).map(u => `<option value="${u.id}" ${c.obo === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select></label>` : ''}</div>
    <div class="cols wide-right">
      <section class="panel">
        <div class="pad stack" style="padding-bottom:6px">
          <div class="seg" role="tablist">${modes.map(m => `<button class="${c.mode === m ? 'on' : ''}" data-act="mode" data-m="${m}">${MODES[m]}</button>`).join('')}</div>
          ${c.mode === 'checkin' ? '' : `<div class="search"><input type="search" placeholder="Search name or Item number, or scan" value="${esc(c.q)}"
            data-in="cartQ" data-enter="cartEnter" data-autofocus autocomplete="off">
            ${Scanner.supported() ? '<button class="btn small" data-act="scan" data-for="cart">Scan</button>' : ''}</div>`}
        </div>
        ${region('finder', finderHtml)}
      </section>
      <section class="panel">${region('cartLines', cartLinesHtml)}</section>
    </div>`;
};
CH.obo = v => { S.cart.obo = v ? Number(v) : null; };
ACT.mode = d => { S.cart.mode = d.m; S.cart.q = ''; render(); };
IN.cartQ = v => { S.cart.q = v; refresh('finder'); };
ACT.cartEnter = () => {
  const it = itemByCode(S.cart.q) || (searchItems(S.cart.q, finderFilter()).length === 1 ? searchItems(S.cart.q, finderFilter())[0] : null);
  if (it) { addToCart(it.id); S.cart.q = ''; const i = $('.search input'); if (i) i.value = ''; refresh('finder'); }
};
function finderFilter() {
  const m = S.cart.mode;
  if (m === 'take' || m === 'return') return i => i.kind === 'consumable';
  if (m === 'checkout') return i => i.kind === 'equipment' && (i.counted ? num(i.qty) > 0 : i.status === 'available');
  return () => false;
}
function finderHtml() {
  const c = S.cart; const v = V();
  if (c.mode === 'checkin') {
    const who = c.obo || S.user.id;
    const mine = v.checkouts.filter(x => isManager() && !c.obo ? true : x.user_id === who);
    if (!mine.length) return '<div class="empty">Nothing is checked out.</div>';
    return `<div class="list scroll">${mine.map(x => { const it = item(x.item_id); const left = num(x.qty) - num(x.qty_returned);
      const inCart = c.lines.some(l => l.checkout_id === x.id);
      return `<button class="li" data-act="addCheckin" data-id="${x.id}" ${inCart ? 'disabled' : ''}>
        <span class="grow"><span class="t">${esc(it ? it.name : '?')}</span> <span class="num">${esc(it ? it.number : '')}</span>
        <div class="s">${esc(userName(x.user_id))} · ${fmtD(x.opened_at)} · ${esc(jobLabel(x.jobcode_id))}</div></span>
        <span class="q">${fmtQty(left)}</span></button>`; }).join('')}</div>`;
  }
  let extra = '';
  if (c.mode === 'return' && !c.q) {
    const who = c.obo || S.user.id; const seen = new Set();
    const recent = (S.snap.returnable || []).filter(r => r.user_id === who).sort((a, b) => b.at.localeCompare(a.at))
      .filter(r => { const k = r.item_id + ':' + r.jobcode_id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 15);
    if (recent.length) extra = `<h3 class="pad" style="padding-bottom:0">Recently taken out by ${who === S.user.id ? 'you' : esc(userName(who))}</h3>
      <div class="list">${recent.map(r => { const it = item(r.item_id); return it ? `<button class="li" data-act="addReturn" data-item="${it.id}" data-job="${r.jobcode_id}" data-line="${r.line_id}">
        <span class="grow"><span class="t">${esc(it.name)}</span> <span class="num">${esc(it.number)}</span><div class="s">${esc(jobLabel(r.jobcode_id))} · Cart ${r.cart_id} · ${fmtD(r.at)}</div></span>
        <span class="q">${fmtQty(r.qty)}</span></button>` : ''; }).join('')}</div><h3 class="pad" style="padding-bottom:0">All items</h3>`;
  }
  const res = searchItems(c.q, finderFilter());
  if (!res.length) return extra + `<div class="empty">${c.q ? 'No match.' : 'No items yet.'}${isManager() ? ' Add items in the Catalogue.' : ''}</div>`;
  return extra + `<div class="list scroll">${res.map(i => itemRow(i, 'addItem')).join('')}</div>`;
}
function itemRow(i, act, extraAttrs = '') {
  const ph = firstPhoto(i.id);
  return `<button class="li" data-act="${act}" data-id="${i.id}" ${extraAttrs}>
    ${ph ? `<img class="thumb" data-photo="${ph}" alt="">` : ''}
    <span class="grow"><span class="t">${esc(i.name)}</span> <span class="num">${esc(i.number || 'new')}</span>
    <div class="s">${esc(locPath(i.location_id) || 'No location')}${(i.tags || []).length ? ' · ' + esc(i.tags.join(', ')) : ''}</div></span>
    <span class="q ${num(i.qty) < 0 ? 'bad' : ''}">${esc(onShelf(i))}</span></button>`;
}
ACT.addItem = d => addToCart(d.id);
ACT.addReturn = d => addToCart(d.item, { jobcode_id: Number(d.job), link_line_id: Number(d.line) });
ACT.addCheckin = d => {
  const x = V().checkouts.find(c => c.id === d.id); if (!x) return;
  S.cart.lines.push({ lid: uuid(), kind: 'checkin', item_id: x.item_id, qty: num(x.qty) - num(x.qty_returned), checkout_id: x.id, jobcode_id: x.jobcode_id, note: '' });
  refresh('finder', 'cartLines');
};
function lastJob() { const c = S.cart; if (c.jobAll) return c.jobAll; for (let i = c.lines.length - 1; i >= 0; i--) if (c.lines[i].jobcode_id && c.lines[i].kind !== 'checkin') return c.lines[i].jobcode_id; return null; }
function addToCart(itemId, extra = {}) {
  const c = S.cart; const it = item(itemId); if (!it) return;
  const kind = c.mode;
  if ((kind === 'take' || kind === 'return') && it.kind !== 'consumable') return toast(`${it.name} is Equipment. Use Check out.`);
  if (kind === 'checkout' && it.kind !== 'equipment') return toast(`${it.name} is a Consumable. Use Take out.`);
  const job = extra.jobcode_id || lastJob();
  const same = c.lines.find(l => l.item_id === itemId && l.kind === kind && l.jobcode_id === job && !l.note && !extra.link_line_id);
  if (same && !(kind === 'checkout' && !it.counted)) same.qty = num(same.qty) + 1;
  else if (kind === 'checkout' && !it.counted && c.lines.some(l => l.item_id === itemId && l.kind === 'checkout')) return toast('Already in the Cart');
  else c.lines.push({ lid: uuid(), kind, item_id: itemId, qty: 1, jobcode_id: job, note: '', checkout_id: kind === 'checkout' ? uuid() : undefined, ...extra });
  refresh('cartLines'); if (kind === 'checkout') refresh('finder');
  toast(`Added ${it.name}`, 1200);
}
function cartLinesHtml() {
  const c = S.cart;
  if (!c.lines.length) return `<div class="empty">The Cart is empty. Search or scan on the left to add items.</div>
    ${c.correction ? `<div class="pad"><button class="btn danger" data-act="cancelCart" data-id="${c.correction.cart_id}">Cancel the whole Cart instead</button></div>` : ''}`;
  const jobs = new Set(c.lines.filter(l => l.kind !== 'checkin').map(l => l.jobcode_id));
  return `<div class="pad row" style="padding-bottom:4px"><h2 class="grow">${plural(c.lines.length, 'line')}</h2>
      <button class="btn small" data-act="jobAll">${jobs.size > 1 || !c.jobAll ? 'One Job code for all' : 'Change Job code for all'}</button></div>
    <div class="list">${c.lines.map(lineHtml).join('')}</div>
    <div class="pad stack">
      <label class="f">Cart note (optional)<textarea data-in="cartNote" rows="2" placeholder="e.g. Rough-in, second floor">${esc(c.note)}</textarea>
        <span class="muted small" style="font-weight:400">This note goes on the billing document of every Job code in the Cart. For a note about one job only, use the note on its lines.</span></label>
      <div class="row"><button class="btn" data-act="clearCart">Empty Cart</button><span class="grow"></span>
        <button class="btn primary" data-act="review">Check and save</button></div>
    </div>`;
}
function lineHtml(l) {
  const it = item(l.item_id) || { name: '?', number: '' };
  const fixed = l.kind === 'checkin' || (l.kind === 'checkout' && !it.counted);
  const short = l.kind === 'take' && num(l.qty) > num(it.qty);
  return `<div class="line" data-lid="${l.lid}">
    <div><span class="tag ${l.kind}">${MODES[l.kind]}</span> <b>${esc(it.name)}</b> <span class="num">${esc(it.number)}</span>
      ${short ? `<div class="small" style="color:var(--warn)">Only ${fmtQty(it.qty)} on the shelf. It will still be saved.</div>` : ''}</div>
    ${fixed ? `<b class="q">${fmtQty(l.qty)}</b>` : `<div class="stepper"><button data-act="qty" data-lid="${l.lid}" data-d="-1" aria-label="Less">−</button>
      <input type="number" inputmode="decimal" min="0" step="any" value="${fmtQty(l.qty)}" data-in="qtyIn" data-lid="${l.lid}" aria-label="Quantity">
      <button data-act="qty" data-lid="${l.lid}" data-d="1" aria-label="More">+</button></div>`}
    <div class="meta">
      ${l.kind === 'checkin' ? `<span class="small muted">From ${esc(jobLabel(l.jobcode_id))}</span>` :
        `<button class="jobchip ${l.jobcode_id ? 'set' : 'missing'}" data-act="pickJob" data-lid="${l.lid}">${l.jobcode_id ? esc(jobLabel(l.jobcode_id)) : 'Choose Job code'}</button>`}
      <input class="note-in grow" type="text" placeholder="Line note" value="${esc(l.note)}" data-in="lineNote" data-lid="${l.lid}" style="min-width:140px;width:auto">
      <button class="btn tiny ghost" data-act="rmLine" data-lid="${l.lid}" aria-label="Remove">✕</button>
    </div></div>`;
}
const lineBy = lid => S.cart.lines.find(l => l.lid === lid);
ACT.qty = d => { const l = lineBy(d.lid); l.qty = Math.max(0, num(l.qty) + num(d.d)); if (l.qty === 0) S.cart.lines = S.cart.lines.filter(x => x !== l); refresh('cartLines'); };
IN.qtyIn = (v, d) => { const l = lineBy(d.lid); if (l) l.qty = num(v); };
IN.lineNote = (v, d) => { const l = lineBy(d.lid); if (l) l.note = v; };
IN.cartNote = v => { S.cart.note = v; };
ACT.rmLine = d => { S.cart.lines = S.cart.lines.filter(l => l.lid !== d.lid); refresh('cartLines', 'finder'); };
ACT.clearCart = () => { if (confirm('Empty the Cart?')) { S.cart.lines = []; refresh('cartLines', 'finder'); } };
ACT.jobAll = () => openModal('job', { target: 'all' });
ACT.pickJob = d => openModal('job', { target: d.lid });

// Job code picker
MODALS.job = () => {
  const m = S.modal;
  return modal('Choose a Job code', `<input type="search" placeholder="Customer or job name" value="${esc(m.q || '')}" data-in="jobQ" data-autofocus autocomplete="off">
    ${jobsStale() ? `<div class="msg warn small">The Job code list was last updated ${ago(S.jobs.synced_at)}. A new job may be missing.</div>` : ''}
    ${region('jobRes', jobResHtml)}`);
};
function jobsStale() { return S.jobs.synced_at && Date.now() - new Date(S.jobs.synced_at).getTime() > 36 * 3600000; }
let recentCache = [];
function jobResHtml() {
  const q = (S.modal && S.modal.q) || '';
  if (!q) {
    const rec = recentCache.map(jobOf).filter(Boolean);
    return rec.length ? `<h3>Recent</h3><div class="list">${rec.map(jobLi).join('')}</div>` : '<div class="empty">Type part of the customer or job name.</div>';
  }
  const res = searchJobs(q);
  return res.length ? `<div class="list">${res.map(jobLi).join('')}</div>` : '<div class="empty">No Job code matches.</div>';
}
function jobLi(j) {
  const parts = j.full.split(/\s*:\s*|\s*=>\s*/);
  return `<button class="li" data-act="setJob" data-id="${j.id}"><span class="grow"><span class="t">${esc(parts[parts.length - 1])}</span>
    ${parts.length > 1 ? `<div class="s">${esc(parts.slice(0, -1).join(' › '))}</div>` : ''}</span></button>`;
}
IN.jobQ = v => { S.modal.q = v; refresh('jobRes'); };
const _openModal = openModal;
openModal = async (kind, params) => { if (kind === 'job') recentCache = await recentJobs(); _openModal(kind, params); };
ACT.setJob = async d => {
  const id = Number(d.id); const m = S.modal;
  if (m.onPick) { m.onPick(id); }
  else if (m.target === 'all') { S.cart.jobAll = id; S.cart.lines.forEach(l => { if (l.kind !== 'checkin') l.jobcode_id = id; }); }
  else { const l = lineBy(m.target); if (l) l.jobcode_id = id; }
  await rememberJob(id); closeModal(); if (!m.onPick) refresh('cartLines');
};

// Review and save
ACT.review = () => {
  const c = S.cart;
  c.lines = c.lines.filter(l => num(l.qty) > 0);
  if (!c.lines.length) return toast('The Cart is empty');
  if (c.lines.some(l => l.kind !== 'checkin' && !l.jobcode_id)) { refresh('cartLines'); return toast('Every line needs a Job code'); }
  openModal('review');
};
MODALS.review = () => {
  const c = S.cart; const groups = new Map();
  for (const l of c.lines) { const k = l.jobcode_id || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const short = c.lines.filter(l => l.kind === 'take' && num(l.qty) > num((item(l.item_id) || {}).qty));
  return modal(c.correction ? `Check your Correction to Cart ${c.correction.cart_id}` : 'Check before saving', `
    <dl class="kv"><dt>Entered by</dt><dd>${esc(S.user.name)}</dd>${c.obo ? `<dt>For</dt><dd>${esc(userName(c.obo))}</dd>` : ''}</dl>
    ${[...groups.entries()].map(([job, ls]) => `<div class="panel"><div class="pad" style="padding-bottom:4px"><b>${job ? esc(jobLabel(job)) : 'Equipment coming back'}</b></div>
      <table class="t"><tbody>${ls.map(l => { const it = item(l.item_id) || {}; return `<tr><td><span class="tag ${l.kind}">${MODES[l.kind]}</span></td>
        <td>${esc(it.name)} <span class="num">${esc(it.number || '')}</span>${l.note ? `<div class="small muted">${esc(l.note)}</div>` : ''}</td><td class="n"><b>${fmtQty(l.qty)}</b></td></tr>`; }).join('')}</tbody></table></div>`).join('')}
    ${c.note ? `<div><h3>Cart note</h3><p>${esc(c.note)}</p></div>` : ''}
    ${short.length ? `<div class="msg warn">More than the app thinks is on the shelf: ${short.map(l => esc(item(l.item_id).name)).join(', ')}. It will be saved and Managers will be asked to recount.</div>` : ''}
    ${c.correction ? `<label class="f">Correction note (optional)<input type="text" data-in="corrNote" value="${esc(c.correctionNote || '')}" placeholder="e.g. Took 6, not 8"></label>
      <p class="muted small">The original Cart stays on record. Billing documents for the Job codes this changes are replaced with a corrected version.</p>` : ''}`,
    `<button class="btn" data-act="close">Back</button><button class="btn primary" data-act="saveCart">${c.correction ? 'Save Correction' : 'Save'}</button>`);
};
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

// Scanner
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
      else if (forWhat === 'catalogue') openModal('item', { id: it.id });
      else if (forWhat === 'lines' && S.lineEditor) S.lineEditor.add(it.id);
    }).catch(e => { toast('Camera not available: ' + e.message); closeModal(); });
  }
  fillPhotos($('#modal-host'));
};
const _render = render;
render = () => { _render(); fillPhotos(); };

// ------------------------------------------------------------------ My entries and Corrections
SCREENS.entries = () => {
  const me = S.user.id; const days = num(setting('correction_days', 14));
  const cutoff = Date.now() - days * 86400000;
  const mine = c => isManager() && S.params.all ? true : (c.entered_by === me || c.on_behalf_of === me);
  const carts = (S.snap.carts || []).filter(c => mine(c) && new Date(c.received_at).getTime() > cutoff);
  const pend = V().pendingCarts.filter(o => o.user_id === me || (o.data && o.data.on_behalf_of === me));
  return `<div class="head">${back()}<h1>${S.params.all ? 'All Carts' : 'My entries'}</h1>
    ${isManager() ? `<button class="btn small" data-act="go" data-to="entries" ${S.params.all ? '' : 'data-all="1"'}>${S.params.all ? 'Only mine' : 'Everyone'}</button>` : ''}</div>
    <div class="panel"><div class="list">
      ${pend.map(o => `<div class="li"><span class="grow"><span class="t">Waiting to send</span><div class="s">${fmtDT(o.at)} · ${plural((o.data.lines || []).length, 'line')}</div></span><span class="pill warn">Not sent yet</span></div>`).join('')}
      ${carts.map(c => `<button class="li" data-act="openCart" data-id="${c.id}"><span class="grow"><span class="t">Cart ${c.id}</span>
        ${c.corrections ? `<span class="pill">${plural(c.corrections, 'Correction')}</span>` : ''}${c.cancelled ? ' <span class="pill bad">Cancelled</span>' : ''}
        <div class="s">${fmtDT(c.received_at)} · ${esc(userName(c.entered_by))}${c.on_behalf_of ? ' for ' + esc(userName(c.on_behalf_of)) : ''} ·
          ${esc([...new Set(c.lines.map(l => jobLabel(l.jobcode_id)))].join('; ') || 'Equipment only')}</div></span>
        <span class="q">${plural(c.lines.length + c.equipment.length, 'line')}</span></button>`).join('')}
      ${!carts.length && !pend.length ? `<div class="empty">No Carts in the last ${days} days.</div>` : ''}
    </div></div>`;
};
ACT.openCart = d => openModal('cartDetail', { id: Number(d.id) });
MODALS.cartDetail = () => {
  const c = S.snap.carts.find(x => x.id === S.modal.id); if (!c) return modal('Cart', 'Not found');
  const pending = S.outbox.some(o => o.op === 'correction' && o.data.cart_id === c.id);
  const can = !c.cancelled && !pending && (c.entered_by === S.user.id || c.on_behalf_of === S.user.id || isManager());
  const rows = [...c.lines.map(l => ({ ...l })), ...c.equipment];
  return modal(`Cart ${c.id}`, `<dl class="kv"><dt>Saved</dt><dd>${fmtDT(c.received_at)}</dd><dt>Entered by</dt><dd>${esc(userName(c.entered_by))}</dd>
      ${c.on_behalf_of ? `<dt>For</dt><dd>${esc(userName(c.on_behalf_of))}</dd>` : ''}${c.note ? `<dt>Note</dt><dd>${esc(c.note)}</dd>` : ''}</dl>
    ${c.cancelled ? '<div class="msg bad">This Cart was cancelled.</div>' : ''}${pending ? '<div class="msg warn">A Correction is waiting to send.</div>' : ''}
    <table class="t"><tbody>${rows.map(l => { const it = item(l.item_id) || {}; return `<tr><td><span class="tag ${l.kind}">${MODES[l.kind]}</span></td>
      <td>${esc(it.name)} <span class="num">${esc(it.number || '')}</span><div class="small muted">${esc(jobLabel(l.jobcode_id))}${l.note ? ' · ' + esc(l.note) : ''}</div></td>
      <td class="n"><b>${fmtQty(l.qty)}</b></td></tr>`; }).join('') || '<tr><td class="muted">No lines</td></tr>'}</tbody></table>
    ${c.equipment.length ? '<p class="muted small">Equipment lines cannot be corrected here; check the item in or out again instead.</p>' : ''}`,
    can ? `<button class="btn danger" data-act="cancelCart" data-id="${c.id}">Cancel Cart</button><span class="grow"></span>
      <button class="btn primary" data-act="correctCart" data-id="${c.id}" ${c.lines.length ? '' : 'disabled'}>Correct</button>` : '');
};
ACT.correctCart = d => {
  const c = S.snap.carts.find(x => x.id === Number(d.id));
  S.cart = { mode: 'take', q: '', note: c.note || '', obo: null, jobAll: null, correction: { cart_id: c.id },
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
SCREENS.catalogue = () => {
  const p = S.params; p.q = p.q || '';
  const locs = [...V().locations.values()].filter(l => !l.archived);
  const tags = [...new Set(V().itemList.flatMap(i => i.tags || []))].sort();
  return `<div class="head">${back()}<h1>Catalogue</h1>
      ${isManager() ? `<button class="btn small" data-act="labelMode">${p.labels ? 'Done choosing' : 'Print labels'}</button>
      <button class="btn small primary" data-act="newItem">New item</button>` : ''}</div>
    <div class="panel pad stack">
      <div class="search"><input type="search" placeholder="Search name, Item number, tag or field" value="${esc(p.q)}" data-in="catQ" data-autofocus autocomplete="off">
        ${Scanner.supported() ? '<button class="btn small" data-act="scan" data-for="catalogue">Scan</button>' : ''}</div>
      <div class="row">
        <select data-ch="catF" data-f="kind" style="width:auto"><option value="">All types</option><option value="consumable" ${p.kind === 'consumable' ? 'selected' : ''}>Consumables</option><option value="equipment" ${p.kind === 'equipment' ? 'selected' : ''}>Equipment</option></select>
        <select data-ch="catF" data-f="loc" style="width:auto"><option value="">All locations</option>${locs.map(l => `<option value="${l.id}" ${p.loc === l.id ? 'selected' : ''}>${esc(locPath(l.id))}</option>`).join('')}</select>
        ${tags.length ? `<select data-ch="catF" data-f="tag" style="width:auto"><option value="">All tags</option>${tags.map(t => `<option ${p.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        <select data-ch="catF" data-f="stock" style="width:auto"><option value="">Any stock</option><option value="low" ${p.stock === 'low' ? 'selected' : ''}>Low or out</option><option value="out" ${p.stock === 'out' ? 'selected' : ''}>Checked out</option>${isManager() ? `<option value="archived" ${p.stock === 'archived' ? 'selected' : ''}>Archived</option>` : ''}</select>
        <select data-ch="catF" data-f="sort" style="width:auto"><option value="">Sort by name</option><option value="number" ${p.sort === 'number' ? 'selected' : ''}>Item number</option><option value="qty" ${p.sort === 'qty' ? 'selected' : ''}>Count</option><option value="changed" ${p.sort === 'changed' ? 'selected' : ''}>Last change</option></select>
      </div>
      ${p.labels ? `<div class="row"><span class="grow muted">Tick items, then print. Labels fit 30-per-sheet address label paper.</span>
        <button class="btn small" data-act="labelAll">Tick all shown</button><button class="btn small primary" data-act="printLabels">Print ${(p.picked || []).length} labels</button></div>` : ''}
    </div>
    <div class="panel" style="margin-top:10px">${region('catList', catListHtml)}</div>`;
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
  if (!list.length) return `<div class="empty">${V().itemList.length ? 'Nothing matches.' : 'The catalogue is empty.' + (isManager() ? ' Tap New item to add the first one.' : '')}</div>`;
  const picked = new Set(p.picked || []);
  return `<div class="pad small muted" style="padding-bottom:0">${plural(list.length, 'item')}</div><div class="list">${list.slice(0, 400).map(i =>
    p.labels ? `<label class="li"><input type="checkbox" data-ch="pickLabel" data-id="${i.id}" ${picked.has(i.id) ? 'checked' : ''} style="width:22px;height:22px">
      <span class="grow"><span class="t">${esc(i.name)}</span> <span class="num">${esc(i.number || 'new')}</span></span></label>` : itemRow(i, 'openItem')).join('')}</div>
    ${list.length > 400 ? '<div class="empty">Showing the first 400. Search to narrow it down.</div>' : ''}`;
}
IN.catQ = v => { S.params.q = v; refresh('catList'); fillPhotos(); };
CH.catF = (v, d) => { S.params[d.f] = v; refresh('catList'); fillPhotos(); };
ACT.labelMode = () => { S.params.labels = !S.params.labels; S.params.picked = []; render(); };
CH.pickLabel = (v, d, el) => { const s = new Set(S.params.picked || []); el.checked ? s.add(d.id) : s.delete(d.id); S.params.picked = [...s]; const b = $('[data-act=printLabels]'); if (b) b.textContent = `Print ${s.size} labels`; };
ACT.labelAll = () => { S.params.picked = catFiltered().filter(i => i.number).map(i => i.id); render(); };
ACT.printLabels = () => { const its = (S.params.picked || []).map(item).filter(i => i && i.number); if (!its.length) return toast('Tick some items first'); printLabels(its); };
ACT.openItem = d => openModal('item', { id: d.id });

MODALS.item = () => {
  const i = item(S.modal.id); if (!i) return modal('Item', 'Not found');
  const v = V(); const outs = v.checkouts.filter(c => c.item_id === i.id);
  const photos = [...((S.snap.photos || {})[i.id] || []), ...S.outbox.filter(o => o.op === 'photo_add' && o.data.item_id === i.id).map(o => o.data.id)];
  const fields = [...v.fields.values()].filter(f => !f.archived && i.custom && i.custom[f.id] !== undefined && i.custom[f.id] !== '');
  return modal(`${esc(i.name)} <span class="num">${esc(i.number || 'new')}</span>`, `
    ${photos.length ? `<div class="photos">${photos.map(id => `<img data-photo="${id}" alt="">`).join('')}</div>` : ''}
    <dl class="kv"><dt>Type</dt><dd>${i.kind === 'equipment' ? (i.counted ? 'Equipment (counted)' : 'Equipment (individual)') : 'Consumable'}</dd>
      <dt>${i.kind === 'equipment' && !i.counted ? 'Status' : 'On shelf'}</dt><dd>${esc(onShelf(i))}${num(i.qty) < 0 ? ' <span class="pill bad">Count is off</span>' : ''}</dd>
      <dt>Location</dt><dd>${esc(locPath(i.location_id) || 'None')}</dd>
      ${i.low_stock !== null && i.low_stock !== undefined ? `<dt>Low-stock level</dt><dd>${fmtQty(i.low_stock)}</dd>` : ''}
      ${(i.tags || []).length ? `<dt>Tags</dt><dd>${esc(i.tags.join(', '))}</dd>` : ''}
      ${i.description ? `<dt>Notes</dt><dd>${esc(i.description)}</dd>` : ''}
      ${fields.map(f => `<dt>${esc(f.name)}</dt><dd>${esc(fieldShow(f, i.custom[f.id]))}</dd>`).join('')}</dl>
    ${outs.length ? `<h3>Checked out</h3><table class="t"><tbody>${outs.map(c => `<tr><td>${esc(userName(c.user_id))}</td><td>${fmtD(c.opened_at)}</td><td>${esc(jobLabel(c.jobcode_id))}</td><td class="n">${fmtQty(num(c.qty) - num(c.qty_returned))}</td></tr>`).join('')}</tbody></table>` : ''}
    ${i.number ? `<div class="row"><div style="width:96px">${qrSvg(i.number)}</div><span class="muted small">Label code: ${esc(i.number)}</span></div>` : ''}`,
    isManager() ? `<button class="btn small" data-act="history" data-id="${i.id}">History</button>
      ${i.number ? `<button class="btn small" data-act="printOne" data-id="${i.id}">Print label</button>` : ''}
      <label class="btn small">Add photo<input type="file" accept="image/*" capture="environment" data-ch="addPhoto" data-id="${i.id}" hidden></label>
      ${i.kind === 'equipment' && !i.counted ? `<button class="btn small" data-act="eqStatus" data-id="${i.id}">Set status</button>` : ''}
      <button class="btn small primary" data-act="editItem" data-id="${i.id}">Edit</button>` : '');
};
function fieldShow(f, v) { if (f.ftype === 'bool') return v ? 'Yes' : 'No'; if (f.ftype === 'date') return fmtD(v + 'T12:00:00Z'); return String(v); }
ACT.printOne = d => printLabels([item(d.id)]);
ACT.history = d => { closeModal(); go('reports', { kind: 'flow', item: d.id }); };
CH.addPhoto = async (v, d, el) => {
  const f = el.files && el.files[0]; if (!f) return;
  const data = await resizePhoto(f); const id = uuid();
  S.photoCache.set(id, data); await DB.put('photos', data, id);
  await queue('photo_add', { id, item_id: d.id, data }); renderModal(); toast('Photo added');
};
ACT.eqStatus = d => openModal('eqStatus', { id: d.id });
MODALS.eqStatus = () => {
  const i = item(S.modal.id);
  return modal(`Status of ${esc(i.name)}`, `${i.status === 'checked_out' ? '<div class="msg warn">Checked out. Check it in first.</div>' : ''}
    <div class="stack">${['available', 'in_repair', 'lost', 'retired'].map(s => `<button class="btn ${i.status === s ? 'primary' : ''}" data-act="setEq" data-s="${s}" ${i.status === 'checked_out' ? 'disabled' : ''}>${({ available: 'Available', in_repair: 'In repair', lost: 'Lost', retired: 'Retired' })[s]}</button>`).join('')}</div>`);
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
      <p class="muted small">The Item number is given automatically and never changes.</p>` : ''}
    <label class="f">Name<input type="text" value="${esc(x.name)}" data-in="draft" data-f="name" data-autofocus></label>
    <div class="grid2">
      <label class="f">Location<select data-ch="draft" data-f="location_id"><option value="">None</option>${locs.map(l => `<option value="${l.id}" ${x.location_id === l.id ? 'selected' : ''}>${esc(locPath(l.id))}</option>`).join('')}</select></label>
      <label class="f">Low-stock level<input type="number" inputmode="decimal" value="${esc(x.low_stock)}" data-in="draft" data-f="low_stock" placeholder="No alert"></label>
    </div>
    <label class="f">Tags (comma between)<input type="text" value="${esc((x.tags || []).join(', '))}" data-in="draftTags"></label>
    <label class="f">Notes<textarea data-in="draft" data-f="description" rows="2">${esc(x.description)}</textarea></label>
    ${fields.map(f => fieldInput(f, x.custom[f.id])).join('')}
    ${m.isNew ? `<p class="muted small">After saving, use Adjust counts to enter how many are on the shelf.</p>` : `<label class="check"><input type="checkbox" data-ch="draft" data-f="archived" ${x.archived ? 'checked' : ''}> Archived (hidden, never deleted)</label>`}`,
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
  await queue('item_save', data); closeModal(); toast(isNew ? 'Item added. Use Adjust counts to enter how many there are.' : 'Saved', 3500); render();
};

// ------------------------------------------------------------------ pick lists (picking)
SCREENS.picks = () => {
  const picks = V().picks.filter(p => p.status === 'open');
  return `<div class="head">${back()}<h1>Pick lists</h1>${isManager() ? '<button class="btn small primary" data-act="editPick">New pick list</button>' : ''}</div>
    <div class="panel"><div class="list">${picks.map(p => `<div class="li"><span class="grow"><span class="t">${esc(p.name)}</span>
      <div class="s">${esc(jobLabel(p.jobcode_id))} · ${plural(p.lines.length, 'line')} · ${p.lines.filter(l => l.picked).length} picked</div></span>
      ${isManager() ? `<button class="btn small" data-act="editPick" data-id="${p.id}">Edit</button>` : ''}
      <button class="btn small primary" data-act="go" data-to="pick" data-id="${p.id}">Pick</button></div>`).join('') || '<div class="empty">No open pick lists.</div>'}</div></div>`;
};
SCREENS.pick = () => {
  const p = V().picks.find(x => x.id === S.params.id); if (!p) return back() + '<div class="empty">Not found</div>';
  S.pickDraft = S.pickDraft && S.pickDraft.id === p.id ? S.pickDraft : JSON.parse(JSON.stringify(p));
  const x = S.pickDraft;
  return `<div class="head">${back('Pick lists', 'picks')}<h1>${esc(x.name)}</h1><span class="pill">${esc(jobLabel(x.jobcode_id))}</span></div>
    <div class="panel"><div class="list">${x.lines.map((l, n) => { const it = item(l.item_id) || {}; return `<label class="li">
      <input type="checkbox" data-ch="pickTick" data-n="${n}" ${l.picked ? 'checked' : ''} style="width:24px;height:24px">
      <span class="grow"><span class="t">${esc(it.name)}</span> <span class="num">${esc(it.number || '')}</span><div class="s">${esc(locPath(it.location_id) || '')} · ${esc(onShelf(it))}</div></span>
      <span class="q">${fmtQty(l.qty)}</span></label>`; }).join('')}</div></div>
    <div class="row" style="margin-top:10px"><span class="grow muted small">Finishing makes a Take out Cart for this Job code. You can change it before saving.</span>
      <button class="btn primary" data-act="finishPick">Finish and make Take out</button></div>`;
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
SCREENS.counts = () => {
  const me = S.user.id;
  const list = V().counts.filter(c => isManager() || (c.assigned_to === me && c.status === 'open'));
  return `<div class="head">${back()}<h1>Stock counts</h1>${isManager() ? '<button class="btn small primary" data-act="newCount">New count</button>' : ''}</div>
    <div class="panel"><div class="list">${list.map(c => `<div class="li"><span class="grow"><span class="t">${esc(c.name)}</span>
      <div class="s">${({ open: 'Open', submitted: 'Counted, waiting for review', applied: 'Applied', cancelled: 'Cancelled' })[c.status]} ·
        ${c.assigned_to ? esc(userName(c.assigned_to)) : 'Anyone'} · ${plural(c.lines.length, 'item')}</div></span>
      ${c.status === 'open' && (c.assigned_to === me || isManager()) ? `<button class="btn small primary" data-act="go" data-to="count" data-id="${c.id}">Count</button>` : ''}
      ${c.status === 'submitted' && isManager() ? `<button class="btn small primary" data-act="go" data-to="countReview" data-id="${c.id}">Review</button>` : ''}</div>`).join('') || '<div class="empty">No counts.</div>'}</div></div>`;
};
SCREENS.count = () => {
  const c = V().counts.find(x => x.id === S.params.id); if (!c) return back() + '<div class="empty">Not found</div>';
  S.countDraft = S.countDraft && S.countDraft.id === c.id ? S.countDraft : JSON.parse(JSON.stringify(c));
  const x = S.countDraft;
  return `<div class="head">${back('Counts', 'counts')}<h1>${esc(x.name)}</h1></div>
    <p class="muted small" style="margin-bottom:8px">Enter what is on the shelf. Leave blank anything you did not count.</p>
    <div class="panel"><div class="list">${x.lines.map((l, n) => { const it = item(l.item_id) || {}; return `<div class="li" style="cursor:default">
      <span class="grow"><span class="t">${esc(it.name)}</span> <span class="num">${esc(it.number || '')}</span><div class="s">${esc(locPath(it.location_id) || '')}</div></span>
      <input type="number" inputmode="decimal" style="width:110px" value="${l.counted ?? ''}" data-in="countIn" data-n="${n}" aria-label="Counted"></div>`; }).join('')}</div></div>
    <div class="row" style="margin-top:10px"><span class="grow"></span><button class="btn" data-act="saveCount">Save for later</button>
      <button class="btn primary" data-act="submitCount">Finished counting</button></div>`;
};
IN.countIn = (v, d) => { S.countDraft.lines[d.n].counted = v === '' ? null : num(v); };
ACT.saveCount = async () => { await queue('count_save', { id: S.countDraft.id, lines: S.countDraft.lines }); toast('Saved'); };
ACT.submitCount = async () => {
  await queue('count_save', { id: S.countDraft.id, lines: S.countDraft.lines, status: 'submitted' });
  S.countDraft = null; go('home'); toast('Count sent to the Managers');
};
