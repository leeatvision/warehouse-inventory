// A stand-in for the wh_ database functions, used only by the browser tests. Made-up people and jobs.
// It follows the real functions closely enough to walk through every screen; the real logic is tested in SQL.
export function createMock() {
  const now = () => new Date().toISOString();
  const db = {
    settings: { timezone: 'America/Denver', idle_minutes: 10, overdue_days: 7, correction_days: 14, branch: { code: 'BR1', name: 'Branch One' } },
    users: [
      { id: 1, name: 'Alex Manager', role: 'manager' }, { id: 2, name: 'Sam Worker', role: 'user' },
      { id: 3, name: 'Robin Field', role: 'user' }, { id: 4, name: 'Jordan Park', role: 'user' },
    ],
    items: [], photos: {}, locations: [], fields: [], checkouts: [], carts: [], lines: [], pos: [], picks: [], counts: [], reports: [],
    ledger: [], activity: [], ops: new Map(), docs: [], seq: { c: 0, e: 0, cart: 0, po: 0, line: 0 },
  };
  const jobs = [
    [100, 'Acme Builders', 'Acme Builders', null, true], [101, 'Main St Remodel', 'Acme Builders:Main St Remodel', 100, false, '12 Main St, Springfield, ST 00001'],
    [102, 'Oak Ave Addition', 'Acme Builders:Oak Ave Addition', 100, false], [200, 'Smith Residence', 'Smith Residence', null, false, '400 Elm Rd, Shelbyville, ST 00002'],
    [300, 'Service Calls', 'Service Calls', null, false],
  ];
  const item = id => db.items.find(i => i.id === id);
  // Current Take out lines of Carts that were not cancelled, newest first (like wh__takeouts).
  const takeouts = user => db.carts.filter(c => c.kind === 'cart' && (!user || (c.on_behalf_of || c.entered_by) === user) && !db.carts.some(k => k.correction_of === c.id && k.cancelled))
    .flatMap(c => state(c.id).filter(l => l.kind === 'take').map(l => ({ line_id: l.id, cart_id: c.id, item_id: l.item_id, qty: l.qty, jobcode_id: l.jobcode_id, note: l.note || '',
      user_id: c.on_behalf_of || c.entered_by, at: c.received_at })))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)) || b.line_id - a.line_id);
  const state = root => { const k = db.carts.filter(c => c.correction_of === root).sort((a, b) => b.correction_seq - a.correction_seq)[0];
    return db.lines.filter(l => l.cart_id === (k ? k.id : root) && ['take', 'return'].includes(l.kind)); };
  const move = (id, d, kind, cart, u, job) => { const it = item(id); it.qty += d; db.ledger.push({ at: now(), cart_id: cart, item_id: id, delta: d, qty_after: it.qty, kind, user_id: u, jobcode_id: job }); };

  function apply(p) {
    const d = p.data || {}; const u = p.user_id;
    if (p.op === 'user_save') { const x = db.users.find(z => z.id === d.user_id); if (d.role) x.role = d.role; if (d.pin_hash) Object.assign(x, { salt: d.pin_salt, hash: d.pin_hash, iter: d.pin_iter }); return {}; }
    if (p.op === 'item_save') {
      let it = item(d.id);
      if (!it) { const e = d.kind === 'equipment'; const n = ++db.seq[e ? 'e' : 'c']; it = { id: d.id, number: (e ? 'E-' : 'C-') + String(n).padStart(4, '0'), qty: e && !d.counted ? 1 : 0, status: 'available', created_at: now() }; db.items.push(it); }
      Object.assign(it, { kind: it.kind || d.kind, counted: it.counted ?? !!d.counted, name: d.name, description: d.description || '', location_id: d.location_id || null,
        tags: d.tags || [], custom: d.custom || {}, low_stock: d.low_stock, archived: !!d.archived || !!d.purged, purged_at: it.purged_at || (d.purged ? now() : null), updated_at: now() });
      return { number: it.number };
    }
    if (['cart', 'received', 'adjustment', 'supplier_return'].includes(p.op)) {
      const id = ++db.seq.cart; db.carts.push({ id, client_id: p.client_id, kind: p.op, entered_by: u, on_behalf_of: d.on_behalf_of || null, note: d.note || '', received_at: now() });
      (d.lines || []).forEach((l, n) => {
        const kind = p.op === 'cart' ? l.kind : { received: 'received', adjustment: 'adjust', supplier_return: 'supplier_return' }[p.op];
        const it = item(l.item_id); let q = Number(l.qty); let co = null;
        if (kind === 'take') move(it.id, -q, kind, id, u, l.jobcode_id);
        if (kind === 'return' || kind === 'received') move(it.id, q, kind, id, u, l.jobcode_id);
        if (kind === 'adjust') move(it.id, q - it.qty, kind, id, u, null);
        if (kind === 'checkout') { co = l.checkout_id; if (!it.counted) { it.status = 'checked_out'; it.qty = 0; q = 1; } else move(it.id, -q, kind, id, u, l.jobcode_id);
          db.checkouts.push({ id: co, item_id: it.id, user_id: d.on_behalf_of || u, jobcode_id: l.jobcode_id, qty: q, qty_returned: 0, opened_at: now(), closed_at: null }); }
        if (kind === 'checkin') { const c = db.checkouts.find(x => x.id === l.checkout_id); c.qty_returned += q; if (c.qty_returned >= c.qty) c.closed_at = now(); co = c.id;
          if (!it.counted) { it.status = 'available'; it.qty = 1; } else move(it.id, q, kind, id, u, c.jobcode_id); }
        db.lines.push({ id: ++db.seq.line, cart_id: id, line_no: n + 1, kind, item_id: it.id, qty: q, jobcode_id: l.jobcode_id || null, note: l.note || '', checkout_id: co, reason: l.reason || '' });
      });
      if (p.op === 'cart') new Set(db.lines.filter(l => l.cart_id === id && l.kind === 'take').map(l => l.jobcode_id)).forEach(j => db.docs.push({ cart_id: id, jobcode_id: j, revision: 1, delivered: 0 }));
      return { cart_id: id };
    }
    if (p.op === 'correction') {
      const root = db.carts.find(c => c.id === d.cart_id); const prev = state(root.id);
      const seq = db.carts.filter(c => c.correction_of === root.id).length + 1; const id = ++db.seq.cart;
      db.carts.push({ id, client_id: p.client_id, kind: 'correction', entered_by: u, correction_of: root.id, correction_seq: seq, note: d.note ?? root.note, cancelled: !!d.cancel, correction_note: d.correction_note || '', received_at: now() });
      for (const l of prev) move(l.item_id, l.kind === 'take' ? l.qty : -l.qty, 'correction', id, u, null);
      (d.cancel ? [] : d.lines).forEach((l, n) => { move(l.item_id, l.kind === 'take' ? -l.qty : l.qty, 'correction', id, u, null);
        db.lines.push({ id: ++db.seq.line, cart_id: id, line_no: n + 1, kind: l.kind, item_id: l.item_id, qty: Number(l.qty), jobcode_id: l.jobcode_id, note: l.note || '' }); });
      return { cart_id: id, seq };
    }
    if (p.op === 'equipment_status') { const it = item(d.item_id); it.status = d.status; it.qty = d.status === 'available' ? 1 : 0; return {}; }
    if (p.op === 'photo_add') { (db.photos[d.item_id] = db.photos[d.item_id] || []).push(d.id); db.photoData = db.photoData || {}; db.photoData[d.id] = d.data; return {}; }
    const upsert = (list, x) => { const i = list.findIndex(y => y.id === x.id); if (i >= 0) list[i] = { ...list[i], ...x, updated_at: now() }; else list.push({ ...x, created_at: now(), updated_at: now() }); };
    if (p.op === 'location_save') { upsert(db.locations, d); return {}; }
    if (p.op === 'field_save') { upsert(db.fields, d); return {}; }
    if (p.op === 'pick_save' || p.op === 'pick_progress') { upsert(db.picks, d); return {}; }
    if (p.op === 'po_save') { const ex = db.pos.find(x => x.id === d.id); upsert(db.pos, { ...d, number: ex ? ex.number : ++db.seq.po }); return {}; }
    if (p.op === 'count_save') { upsert(db.counts, { status: 'open', ...d }); return {}; }
    if (p.op === 'report_save') { upsert(db.reports, d); return {}; }
    if (p.op === 'setting_save') { db.settings[d.key] = d.value; return {}; }
    throw new Error('unknown operation ' + p.op);
  }

  function snapshot() {
    const carts = db.carts.filter(c => c.kind === 'cart').map(c => {
      const ks = db.carts.filter(k => k.correction_of === c.id);
      return { ...c, note: ks.length ? ks[ks.length - 1].note : c.note, corrections: ks.length, cancelled: ks.some(k => k.cancelled),
        original: ks.some(k => k.cancelled) ? db.lines.filter(l => l.cart_id === c.id && ['take', 'return'].includes(l.kind)) : null,
        lines: state(c.id), equipment: db.lines.filter(l => l.cart_id === c.id && ['checkout', 'checkin'].includes(l.kind)) };
    }).reverse();
    return { server_time: now(), settings: db.settings, users: db.users, items: db.items, photos: db.photos, locations: db.locations, fields: db.fields,
      checkouts: db.checkouts.filter(c => !c.closed_at), carts,
      returnable: Object.values(takeouts().reduce((m, t) => { (m[t.user_id] = m[t.user_id] || []).push(t); return m; }, {})).flatMap(a => a.slice(0, 14)),
      picks: db.picks, pos: db.pos, counts: db.counts, reports: db.reports,
      delivery: { waiting: db.docs.filter(x => x.revision > x.delivered).length, oldest_waiting: null, last_delivered: null, last_error: null } };
  }

  return {
    db,
    handle(fn, args) {
      if (fn !== 'wh_delivery_claim' && args.p_key !== 'test-device-key') return [401, { message: 'wh: device key not accepted' }];
      if (fn === 'wh_snapshot') return [200, snapshot()];
      if (fn === 'wh_jobs') return [200, { synced_at: now(), jobs }];
      if (fn === 'wh_photos') return [200, Object.fromEntries(args.p_ids.map(id => [id, (db.photoData || {})[id]]).filter(x => x[1]))];
      if (fn === 'wh_submit') return [200, args.p_ops.map(p => {
        if (db.ops.has(p.client_id)) return { client_id: p.client_id, dup: true, ...db.ops.get(p.client_id) };
        let r; try { r = { ok: true, ...apply(p) }; } catch (e) { r = { ok: false, error: e.message }; }
        db.ops.set(p.client_id, r); return { client_id: p.client_id, ...r };
      })];
      if (fn === 'wh_takeout_search') {
        const words = String(args.p_q || '').toLowerCase().split(/\s+/).filter(Boolean);
        return [200, takeouts(args.p_user).filter(t => { const it = item(t.item_id) || {}; const j = jobs.find(x => x[0] === t.jobcode_id);
          const hay = [it.name, it.number, j ? j[2] : '', t.cart_id, t.note].join(' ').toLowerCase(); return words.every(w => hay.includes(w)); }).slice(0, args.p_limit || 50)];
      }
      if (fn === 'wh_query') {
        const inRange = x => x >= args.p_from && x < args.p_to;
        if (args.p_kind === 'ledger') return [200, db.ledger.filter(l => inRange(l.at))];
        if (args.p_kind === 'activity') return [200, db.activity.filter(a => inRange(a.at))];
        return [200, db.carts.filter(c => inRange(c.received_at)).map(c => ({ ...c, lines: db.lines.filter(l => l.cart_id === c.id) }))];
      }
      return [404, { message: 'no such function ' + fn }];
    },
  };
}
