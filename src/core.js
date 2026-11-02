/* Core: storage, server calls, offline outbox, sign-in, rendering helpers. Brand values come from config.js. */
'use strict';

const B = window.WH_BRAND || {};
const PREFIX = B.storagePrefix || 'warehouse';
const PBKDF2_ITER = 100000;

// ------------------------------------------------------------------ small helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmtQty = v => { const n = num(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000); };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || w + 's')}`;

function tz() { return (S.snap && S.snap.settings && S.snap.settings.timezone) || undefined; }
function fmtDT(iso) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(undefined, { timeZone: tz(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
  catch { return new Date(iso).toLocaleString(); }
}
function fmtD(iso) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(undefined, { timeZone: tz(), year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso)); }
  catch { return new Date(iso).toLocaleDateString(); }
}
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 36) return h + ' h ago';
  return Math.round(h / 24) + ' days ago';
}
function setting(k, d) { const v = S.snap && S.snap.settings ? S.snap.settings[k] : undefined; return v === undefined || v === null ? d : v; }

let toastTimer;
function toast(msg, ms = 2600) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ IndexedDB
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(PREFIX + '-db', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('kv'); d.createObjectStore('outbox', { keyPath: 'client_id' }); d.createObjectStore('photos');
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store); let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    get: (store, k) => tx(store, 'readonly', s => req(s.get(k))),
    put: (store, v, k) => tx(store, 'readwrite', s => req(k === undefined ? s.put(v) : s.put(v, k))),
    del: (store, k) => tx(store, 'readwrite', s => req(s.delete(k))),
    all: store => tx(store, 'readonly', s => req(s.getAll())),
  };
})();

// ------------------------------------------------------------------ state
const S = {
  key: null, snap: null, jobs: { list: [], byId: new Map(), synced_at: null, fetched: 0 },
  outbox: [], failed: [], user: null, screen: 'boot', params: {}, modal: null, cart: null,
  syncing: false, lastSync: null, lastError: null, persisted: null, photoCache: new Map(), viewVer: 0, setupMsg: '',
};

// ------------------------------------------------------------------ server calls
async function rpc(fn, args) {
  if (!B.supabaseUrl || !B.supabaseKey) throw new Error('This build has no server address. See brand.json.');
  const r = await fetch(B.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: { apikey: B.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) {
    const msg = (body && body.message) || ('Server error ' + r.status);
    const e = new Error(msg); e.status = r.status; e.keyRejected = /device key not accepted/i.test(msg); throw e;
  }
  return body;
}

// ------------------------------------------------------------------ outbox and sync
async function queue(op, data, userId) {
  const o = { client_id: uuid(), op, user_id: userId === undefined ? (S.user && S.user.id) : userId, at: new Date().toISOString(),
    data, queued: Date.now() };
  await DB.put('outbox', o);
  S.outbox.push(o); S.viewVer++;
  sync();
  return o;
}

let syncTimer = null;
async function sync({ full = false } = {}) {
  if (S.syncing || !S.key) return;
  S.syncing = true; updateStatus();
  try {
    const pending = S.outbox.slice().sort((a, b) => a.queued - b.queued);
    for (let i = 0; i < pending.length; i += 20) {
      const batch = pending.slice(i, i + 20).map(({ queued, ...o }) => o);
      const res = await rpc('wh_submit', { p_key: S.key, p_ops: batch });
      for (const r of res) {
        const o = S.outbox.find(x => x.client_id === r.client_id);
        if (!o) continue;
        await DB.del('outbox', o.client_id);
        S.outbox = S.outbox.filter(x => x !== o);
        if (r.ok === false) {
          const f = { ...o, error: r.error, failed_at: new Date().toISOString() };
          S.failed.push(f); await DB.put('kv', S.failed, 'failed');
          if (S.user && S.user.id === o.user_id) toast('Not saved on the server: ' + r.error, 6000);
        }
      }
    }
    const snap = await rpc('wh_snapshot', { p_key: S.key });
    S.snap = snap; await DB.put('kv', snap, 'snapshot');
    if (full || !S.jobs.fetched || Date.now() - S.jobs.fetched > 30 * 60000) await loadJobs();
    S.lastSync = new Date().toISOString(); S.lastError = null; S.viewVer++;
    if (S.user) { const u = snap.users.find(x => x.id === S.user.id); if (!u) signOut('You are no longer on the user list.'); else S.user = u; }
    rerenderSoft();
  } catch (e) {
    S.lastError = e.message;
    if (e.keyRejected) { S.key = null; await DB.del('kv', 'device_key'); S.setupMsg = 'The device key was not accepted. Enter it again.'; go('setup'); }
  } finally {
    S.syncing = false; updateStatus();
  }
}
async function loadJobs() {
  const j = await rpc('wh_jobs', { p_key: S.key });
  await DB.put('kv', j, 'jobs'); setJobs(j); S.jobs.fetched = Date.now(); await DB.put('kv', S.jobs.fetched, 'jobs_fetched');
}
function setJobs(j) {
  const list = (j.jobs || []).map(a => ({ id: a[0], name: a[1], full: a[2] || a[1], parent: a[3], parentOnly: !!a[4] }));
  list.forEach(x => { x.n = norm(x.full); });
  S.jobs.list = list; S.jobs.byId = new Map(list.map(x => [x.id, x])); S.jobs.synced_at = j.synced_at;
}
function startSyncLoop() {
  clearInterval(syncTimer); syncTimer = setInterval(() => sync(), 30000);
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
}

// ------------------------------------------------------------------ the view: server data plus what is waiting to send
let viewCache = { ver: -1 };
function V() {
  if (viewCache.ver === S.viewVer && viewCache.snap === S.snap) return viewCache;
  const snap = S.snap || {};
  const items = new Map((snap.items || []).map(i => [i.id, { ...i }]));
  const locations = new Map((snap.locations || []).map(l => [l.id, { ...l }]));
  const fields = new Map((snap.fields || []).map(f => [f.id, { ...f }]));
  const users = new Map((snap.users || []).map(u => [u.id, { ...u }]));
  const checkouts = (snap.checkouts || []).map(c => ({ ...c }));
  const pendingCarts = [];
  const add = (id, d) => { const it = items.get(id); if (it) it.qty = num(it.qty) + d; };
  for (const o of S.outbox) {
    const d = o.data || {};
    if (o.op === 'item_save') {
      const it = items.get(d.id);
      items.set(d.id, { qty: it ? it.qty : (d.kind === 'equipment' && !d.counted ? 1 : 0), status: it ? it.status : 'available',
        number: it ? it.number : null, kind: it ? it.kind : d.kind, counted: it ? it.counted : !!d.counted, ...(it || {}),
        ...d, tags: d.tags || [], pending: true, id: d.id });
    } else if (o.op === 'cart') {
      pendingCarts.push(o);
      for (const l of d.lines || []) {
        const it = items.get(l.item_id); if (!it) continue;
        if (l.kind === 'take') add(l.item_id, -num(l.qty));
        else if (l.kind === 'return') add(l.item_id, num(l.qty));
        else if (l.kind === 'checkout') {
          if (it.counted) add(l.item_id, -num(l.qty)); else { it.status = 'checked_out'; it.qty = 0; }
          checkouts.push({ id: l.checkout_id, item_id: l.item_id, user_id: d.on_behalf_of || o.user_id, jobcode_id: l.jobcode_id,
            qty: it.counted ? num(l.qty) : 1, qty_returned: 0, opened_at: o.at, pending: true });
        } else if (l.kind === 'checkin') {
          const c = checkouts.find(x => x.id === l.checkout_id);
          if (c) { c.qty_returned = num(c.qty_returned) + num(l.qty); }
          if (it.counted) add(l.item_id, num(l.qty)); else { it.status = 'available'; it.qty = 1; }
        }
      }
    } else if (o.op === 'correction') {
      const c = (snap.carts || []).find(x => x.id === d.cart_id);
      if (c) {
        for (const l of c.lines) add(l.item_id, l.kind === 'take' ? num(l.qty) : -num(l.qty));
        for (const l of (d.cancel ? [] : d.lines || [])) add(l.item_id, l.kind === 'take' ? -num(l.qty) : num(l.qty));
      }
    } else if (o.op === 'adjustment') {
      for (const l of d.lines || []) { const it = items.get(l.item_id); if (it) it.qty = num(l.qty); }
    } else if (o.op === 'received') {
      for (const l of d.lines || []) add(l.item_id, num(l.qty));
    } else if (o.op === 'equipment_status') {
      const it = items.get(d.item_id); if (it) { it.status = d.status; it.qty = d.status === 'available' ? 1 : 0; }
    } else if (o.op === 'location_save') {
      locations.set(d.id, { ...(locations.get(d.id) || {}), ...d });
    } else if (o.op === 'field_save') {
      fields.set(d.id, { ...(fields.get(d.id) || {}), ...d });
    } else if (o.op === 'user_save') {
      const u = users.get(d.user_id);
      if (u) { if (d.role) u.role = d.role; if (d.pin_hash) { u.hash = d.pin_hash; u.salt = d.pin_salt; u.iter = d.pin_iter; } }
    }
  }
  // Pick lists, POs and counts that are still waiting to send.
  const merged = (list, op, extra = {}) => {
    const out = (list || []).map(x => ({ ...x }));
    for (const o of S.outbox) if (op.includes(o.op)) {
      const i = out.findIndex(x => x.id === o.data.id);
      if (i >= 0) out[i] = { ...out[i], ...o.data, pending: true };
      else if (o.op !== 'pick_progress') out.unshift({ ...extra, created_at: o.at, ...o.data, pending: true });
    }
    return out;
  };
  const picks = merged(snap.picks, ['pick_save', 'pick_progress'], { status: 'open', lines: [] });
  const pos = merged(snap.pos, ['po_save'], { status: 'open', lines: [], number: 'new' });
  const counts = merged(snap.counts, ['count_save'], { status: 'open', lines: [] });
  const openCheckouts = checkouts.filter(c => num(c.qty_returned) < num(c.qty));
  viewCache = { ver: S.viewVer, snap: S.snap, items, locations, fields, users, checkouts: openCheckouts, pendingCarts, picks, pos, counts,
    itemList: [...items.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))) };
  return viewCache;
}
const item = id => V().items.get(id);
const userName = id => { if (!id) return ''; const u = V().users.get(Number(id)); return u ? u.name : 'User ' + id; };
const jobOf = id => S.jobs.byId.get(Number(id));
const jobLabel = id => { const j = jobOf(id); return j ? j.full : (id ? 'Job code ' + id : ''); };
function locPath(id) {
  const L = V().locations; const parts = []; let cur = L.get(id); let guard = 0;
  while (cur && guard++ < 10) { parts.unshift(cur.name); cur = L.get(cur.parent_id); }
  return parts.join(' › ');
}
const isManager = () => S.user && S.user.role === 'manager';
function onShelf(it) {
  if (!it) return '';
  if (it.kind === 'equipment' && !it.counted) return ({ available: 'Available', checked_out: 'Checked out', in_repair: 'In repair', lost: 'Lost', retired: 'Retired' })[it.status] || it.status;
  return fmtQty(it.qty) + ' on shelf';
}

// ------------------------------------------------------------------ PINs (checked on the device so sign-in works offline)
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function pinHash(pin, saltB64, iter) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
}
async function makePin(pin) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { pin_salt: salt, pin_hash: await pinHash(pin, salt, PBKDF2_ITER), pin_iter: PBKDF2_ITER };
}
async function checkPin(u, pin) {
  if (!u.hash || !u.salt) return false;
  return (await pinHash(pin, u.salt, u.iter || PBKDF2_ITER)) === u.hash;
}

// ------------------------------------------------------------------ idle sign-out
let lastTap = Date.now(); let idleWarned = false;
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { lastTap = Date.now(); if (idleWarned) { idleWarned = false; toast('Still signed in'); } }, true));
setInterval(() => {
  if (!S.user) return;
  const limit = num(setting('idle_minutes', 10)) * 60000; const idle = Date.now() - lastTap;
  if (idle > limit) signOut(`Signed out after ${setting('idle_minutes', 10)} minutes without a tap.`);
  else if (idle > limit - 30000 && !idleWarned) { idleWarned = true; toast('Signing out in 30 seconds. Tap anywhere to stay.', 30000); }
}, 5000);
function signOut(msg) {
  S.user = null; S.cart = null; S.modal = null; idleWarned = false;
  go('signin'); if (msg) toast(msg, 5000);
}

// ------------------------------------------------------------------ rendering
const SCREENS = {}; const ACT = {}; const IN = {}; const CH = {};
const regions = {};
function region(id, fn) { regions[id] = fn; return `<div id="${id}">${fn()}</div>`; }
function refresh(...ids) { for (const id of ids) { const el = document.getElementById(id); if (el && regions[id]) el.innerHTML = regions[id](); } }

function go(screen, params = {}) {
  S.screen = screen; S.params = params; S.modal = null;
  if (history.state?.screen !== screen) history.pushState({ screen }, '');
  render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  if (S.modal) { S.modal = null; render(); return; }
  if (S.user && S.screen !== 'home') { S.screen = 'home'; S.params = {}; render(); }
});
function openModal(kind, params = {}) { S.modal = { kind, ...params }; renderModal(); }
function closeModal() { S.modal = null; renderModal(); }
const MODALS = {};

// ------------------------------------------------------------------ icons (stroke, 24px grid)
const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 11.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.5L22 7H6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  swap: '<path d="M16 3l4 4-4 4"/><path d="M20 7H4"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h16"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
};
const icon = (name, size = 24, extra = '') => `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICON_PATHS[name] || ''}</svg>`;
const initials = name => String(name || '?').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const isWide = () => matchMedia('(min-width: 760px)').matches;
const isDesk = () => matchMedia('(min-width: 1400px)').matches;

// ------------------------------------------------------------------ the frame: side menu (tablet, desktop), bottom bar and header (phone)
const NAV_MAIN = [['home', 'Home', 'home'], ['cart', 'Cart', 'cart'], ['catalogue', 'Catalogue', 'box'], ['entries', 'Entries', 'list'], ['more', 'More', 'menu']];
const NAV_GROUPS = [
  ['Stock', [['receive', 'Receive delivery'], ['adjust', 'Adjust counts'], ['counts', 'Stock counts']]],
  ['Jobs and orders', [['picks', 'Pick lists'], ['pos', 'Purchase orders'], ['supplierReturn', 'Supplier returns']]],
  ['Office', [['alerts', 'Alerts'], ['reports', 'Reports'], ['people', 'People and PINs'], ['setup2', 'Locations and fields'], ['status', 'Device and billing']]],
];
const SECTION_OF = { review: 'cart', pick: 'more', count: 'more', countReview: 'more', poEdit: 'more', pickEdit: 'more' };
function navSection() { return SECTION_OF[S.screen] || S.screen; }
function navCount(to) {
  if (to === 'cart') return S.cart && S.cart.lines.length ? S.cart.lines.length : '';
  if (!isManager()) return '';
  if (to === 'alerts') { const n = alertList().length; return n || ''; }
  if (to === 'picks') return V().picks.filter(p => p.status === 'open').length || '';
  if (to === 'counts') return V().counts.filter(c => c.status === 'open' || c.status === 'submitted').length || '';
  return '';
}
function logoHtml(cls = '') { return B.logo ? `<img class="logo ${cls}" src="${esc(B.logo)}" alt="">` : ''; }
function sideNav() {
  const cur = navSection(); const desk = isDesk();
  const main = NAV_MAIN.filter(([to]) => !(desk && to === 'more'));
  const groups = desk && isManager() ? NAV_GROUPS.map(([h, items]) => `<span class="nav-h">${h}</span>${items.map(([to, label]) =>
    `<a href="#" class="nav-i ${cur === to ? 'on' : ''}" data-act="go" data-to="${to}"><span class="nav-l">${label}</span><span class="nav-c">${navCount(to)}</span></a>`).join('')}`).join('') : '';
  return `<nav class="side" aria-label="Main">
    <div class="side-brand">${logoHtml()}<span class="side-name">${esc(B.shortName || 'Warehouse')}</span></div>
    ${main.map(([to, label, ic]) => `<a href="#" class="nav-i ${cur === to ? 'on' : ''}" data-act="go" data-to="${to}" ${cur === to ? 'aria-current="page"' : ''}>
      ${icon(ic)}<span class="nav-l">${label}</span><span class="nav-c">${navCount(to)}</span></a>`).join('')}
    ${groups}
    <span class="grow"></span>
    <div class="side-foot"><span id="status">${statusPill()}</span>
      <button class="me" data-act="logout" title="Sign out ${esc(S.user.name)}"><span class="avatar">${esc(initials(S.user.name))}</span>
      <span class="me-t"><b>${esc(S.user.name)}</b><span>${isManager() ? 'Manager · ' : ''}Sign out</span></span></button></div>
  </nav>`;
}
function bottomNav() {
  const cur = navSection();
  return `<nav class="bottom" aria-label="Main">${NAV_MAIN.filter(([to]) => to !== 'entries').map(([to, label, ic]) =>
    `<a href="#" class="${cur === to ? 'on' : ''}" data-act="go" data-to="${to}" ${cur === to ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${navCount(to) && to === 'cart' ? `<i class="dot">${navCount(to)}</i>` : ''}</a>`).join('')}</nav>`;
}
function phoneHead() {
  return `<header class="phead">${logoHtml()}<span class="side-name">${esc(B.shortName || 'Warehouse')}</span>
    <span id="status-p">${statusPill()}</span><span class="grow"></span>
    ${S.user ? `<button class="avatar" data-act="go" data-to="more" aria-label="${esc(S.user.name)}, menu">${esc(initials(S.user.name))}</button>` : ''}</header>`;
}
function statusPill() {
  const n = S.outbox.length;
  if (S.syncing && n) return `<span class="pill">Sending ${n}…</span>`;
  if (n) return `<span class="pill warn" title="${esc(S.lastError || '')}">${plural(n, 'entry', 'entries')} waiting to send</span>`;
  if (S.lastError) return `<span class="pill warn" title="${esc(S.lastError)}">Offline</span>`;
  if (S.lastSync) return `<span class="pill ok">Up to date</span>`;
  return '';
}
function updateStatus() { for (const id of ['#status', '#status-p']) { const el = $(id); if (el) el.innerHTML = statusPill(); } }

function render() {
  const fn = SCREENS[S.screen] || SCREENS.home;
  const bare = S.screen === 'setup' || S.screen === 'boot';
  const noBottom = ['cart', 'review', 'pick', 'count'].includes(S.screen);
  $('#app').innerHTML = bare ? `<main class="bare">${fn()}</main>`
    : `<div class="shell ${S.user ? 'in' : 'out'} ${noBottom ? 'no-bottom' : ''}">${S.user ? sideNav() : ''}
        <div class="page">${phoneHead()}<main class="main screen-${esc(S.screen)}">${fn()}</main></div>${S.user ? bottomNav() : ''}</div>`;
  renderModal();
  const af = $('[data-autofocus]'); if (af && matchMedia('(min-width: 860px)').matches) af.focus();
}
function renderModal() {
  let host = $('#modal-host');
  if (!host) { host = document.createElement('div'); host.id = 'modal-host'; document.body.appendChild(host); }
  if (!S.modal) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="scrim" data-act="scrim">${MODALS[S.modal.kind]()}</div>`;
  const af = host.querySelector('[data-autofocus]'); if (af) af.focus();
}
// Re-render after background sync without disturbing someone who is typing.
function rerenderSoft() {
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { updateStatus(); return; }
  if (S.modal) { updateStatus(); return; }
  // Screens holding a draft are left alone; the rest redraw with the new data.
  const drafts = ['cart', 'review', 'pick', 'count', 'poEdit', 'pickEdit', 'receive', 'adjust', 'supplierReturn', 'reports', 'countReview', 'setup'];
  if (drafts.includes(S.screen)) updateStatus(); else render();
}
function modal(title, body, footer = '', wide = false, cls = '') {
  return `<div class="modal ${wide ? 'wide' : ''} ${cls}" role="dialog" aria-modal="true" data-stop>
    <header><h2>${title}</h2><button class="btn small ghost" data-act="close" aria-label="Close">✕</button></header>
    <div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
}
function back(label = 'Home', to = 'home') { return `<button class="back" data-act="go" data-to="${to}" aria-label="Back to ${esc(label)}">${icon('back')}<span>${esc(label)}</span></button>`; }
// A screen's title row: optional back button, title, actions on the right.
function pageHead(title, actions = '', backTo = null, backLabel = 'Home') {
  return `<div class="head">${backTo ? back(backLabel, backTo) : ''}<h1>${title}</h1>${actions ? `<div class="head-act">${actions}</div>` : ''}</div>`;
}
// Redraw when the window crosses a layout breakpoint (phone, tablet, desktop).
['(min-width: 760px)', '(min-width: 1400px)'].forEach(q => matchMedia(q).addEventListener('change', () => { if (S.screen !== 'boot') render(); }));

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'scrim') { if (!e.target.closest('[data-stop]')) closeModal(); return; }
  const f = ACT[el.dataset.act];
  if (f) { e.preventDefault(); f(el.dataset, el, e); }
});
document.addEventListener('input', e => { const el = e.target.closest('[data-in]'); if (el && IN[el.dataset.in]) IN[el.dataset.in](el.value, el.dataset, el, e); });
document.addEventListener('change', e => { const el = e.target.closest('[data-ch]'); if (el && CH[el.dataset.ch]) CH[el.dataset.ch](el.value, el.dataset, el, e); });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') { const el = e.target.closest('[data-enter]'); if (el && ACT[el.dataset.enter]) { e.preventDefault(); ACT[el.dataset.enter](el.dataset, el, e); } }
  if (e.key === 'Escape' && S.modal) closeModal();
});

ACT.go = d => { const { act, to, ...rest } = d; go(to, rest); };
ACT.close = () => closeModal();
ACT.logout = () => signOut();

// ------------------------------------------------------------------ search helpers
function searchItems(q, filter = () => true, limit = 60) {
  const list = V().itemList.filter(i => !i.archived && filter(i));
  const t = norm(q).trim();
  if (!t) return list.slice(0, limit);
  const words = t.split(/\s+/);
  const scored = [];
  for (const i of list) {
    const hay = norm([i.number, i.name, i.description, (i.tags || []).join(' '), Object.values(i.custom || {}).join(' ')].join(' '));
    if (!words.every(w => hay.includes(w))) continue;
    const n = norm(i.number);
    scored.push([n === t ? 0 : norm(i.name).startsWith(t) || n.startsWith(t) ? 1 : 2, i]);
  }
  return scored.sort((a, b) => a[0] - b[0] || String(a[1].name).localeCompare(b[1].name)).slice(0, limit).map(x => x[1]);
}
function itemByCode(code) {
  const c = norm(code).trim(); if (!c) return null;
  return V().itemList.find(i => norm(i.number) === c) || null;
}
function searchJobs(q, limit = 60) {
  const t = norm(q).trim(); if (!t) return [];
  const words = t.split(/\s+/);
  const out = [];
  for (const j of S.jobs.list) { if (j.parentOnly) continue; if (words.every(w => j.n.includes(w))) { out.push(j); if (out.length >= limit) break; } }
  return out;
}
async function recentJobs() { return (await DB.get('kv', 'recent_jobs')) || []; }
async function rememberJob(id) {
  if (!id) return; const r = (await recentJobs()).filter(x => x !== id); r.unshift(id); await DB.put('kv', r.slice(0, 12), 'recent_jobs');
}

// ------------------------------------------------------------------ photos
async function photoData(id) {
  if (S.photoCache.has(id)) return S.photoCache.get(id);
  let d = await DB.get('photos', id);
  if (!d && S.key) { try { const r = await rpc('wh_photos', { p_key: S.key, p_ids: [id] }); d = r[id]; if (d) await DB.put('photos', d, id); } catch { } }
  if (d) S.photoCache.set(id, d);
  return d;
}
async function fillPhotos(root = document) {
  for (const img of root.querySelectorAll('img[data-photo]')) {
    if (img.src) continue; const d = await photoData(img.dataset.photo); if (d) img.src = d;
  }
}
function firstPhoto(itemId) {
  const ids = (S.snap && S.snap.photos && S.snap.photos[itemId]) || [];
  const pend = S.outbox.filter(o => o.op === 'photo_add' && o.data.item_id === itemId).map(o => o.data.id);
  return ids[0] || pend[0] || null;
}
async function resizePhoto(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const max = 720; const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

// ------------------------------------------------------------------ QR labels
function qrSvg(text, cell = 4) {
  if (typeof qrcode !== 'function') return '';
  const q = qrcode(0, 'M'); q.addData(String(text)); q.make();
  return q.createSvgTag({ cellSize: cell, margin: 0, scalable: true });
}
function printLabels(items) {
  $('#print').innerHTML = `<div class="labels">${items.map(i => `<div class="label">${qrSvg(i.number)}<div><b>${esc(i.number)}</b><span>${esc(i.name)}</span></div></div>`).join('')}</div>`;
  setTimeout(() => window.print(), 50);
}
function printHtml(html) { $('#print').innerHTML = `<div class="print-report">${html}</div>`; setTimeout(() => window.print(), 50); }
function downloadCsv(name, rows) {
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

// ------------------------------------------------------------------ barcode / QR scanning with the camera
const Scanner = {
  stream: null, timer: null,
  supported: () => 'BarcodeDetector' in window && !!navigator.mediaDevices,
  async start(video, onCode) {
    const det = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'upc_a'] });
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = this.stream; await video.play();
    this.timer = setInterval(async () => {
      try { const r = await det.detect(video); if (r && r[0]) { this.stop(); onCode(r[0].rawValue); } } catch { }
    }, 250);
  },
  stop() { clearInterval(this.timer); this.timer = null; if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null; },
};

// ------------------------------------------------------------------ start
async function boot() {
  try {
    S.key = await DB.get('kv', 'device_key');
    S.snap = await DB.get('kv', 'snapshot');
    const j = await DB.get('kv', 'jobs'); if (j) setJobs(j);
    S.jobs.fetched = (await DB.get('kv', 'jobs_fetched')) || 0;
    S.outbox = await DB.all('outbox');
    S.failed = (await DB.get('kv', 'failed')) || [];
  } catch (e) { console.error(e); }
  if (navigator.storage && navigator.storage.persist) {
    try { S.persisted = await navigator.storage.persisted() || await navigator.storage.persist(); } catch { }
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
  history.replaceState({ screen: 'boot' }, '');
  if (!S.key) { go('setup'); return; }
  go(S.snap ? 'signin' : 'setup');
  startSyncLoop(); sync({ full: !S.jobs.list.length });
}
document.addEventListener('DOMContentLoaded', boot);
