/* Manager screens: alerts, receiving, adjustments, supplier returns, POs, pick list and count setup,
   reports, people, locations and fields, device status. */
'use strict';

// ------------------------------------------------------------------ a reusable list of item lines
// cols: { job: bool, reason: bool, qtyLabel: string }
function lineEditor(key, cols) {
  S.le = S.le || {};
  const ed = S.le[key] || (S.le[key] = { lines: [], note: '', po_id: null });
  S.lineEditor = { add: id => { addEdLine(key, id); } };
  return `<div class="panel"><div class="pad row" style="padding-bottom:4px"><h2 class="grow">${plural(ed.lines.length, 'line')}</h2>
      <button class="btn small" data-act="edAdd" data-key="${key}">Add item</button>
      ${Scanner.supported() ? '<button class="btn small" data-act="scan" data-for="lines">Scan</button>' : ''}</div>
    <div class="list">${ed.lines.map((l, n) => { const it = item(l.item_id) || {}; return `<div class="line">
      <div><b>${esc(it.name)}</b> <span class="num">${esc(it.number || 'new')}</span><div class="small muted">${esc(onShelf(it))}</div></div>
      <label class="small" style="text-align:right">${esc(cols.qtyLabel || 'Quantity')}<input type="number" inputmode="decimal" step="any" min="0" value="${l.qty ?? ''}"
        data-in="edQty" data-key="${key}" data-n="${n}" style="width:100px;margin-left:6px">${key === 'adjust' ? `<span class="chg" id="chg-${n}">${adjChange(l)}</span>` : ''}</label>
      <div class="meta">
        ${cols.job ? `<button class="jobchip ${l.jobcode_id ? 'set' : 'missing'}" data-act="edJob" data-key="${key}" data-n="${n}">${l.jobcode_id ? esc(jobLabel(l.jobcode_id)) : 'Choose Job code'}</button>` : ''}
        ${cols.reason ? `<select data-ch="edReason" data-key="${key}" data-n="${n}" style="width:auto;min-height:36px" aria-label="Reason"><option value="">Reason: recount (more or fewer)</option>${REASONS.map(r => `<option ${l.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` : ''}
        ${cols.note ? `<input class="note-in grow" type="text" placeholder="Line note" value="${esc(l.note || '')}" data-in="edNote" data-key="${key}" data-n="${n}" style="width:auto">` : '<span class="grow"></span>'}
        <button class="btn tiny ghost" data-act="edRm" data-key="${key}" data-n="${n}" aria-label="Remove">✕</button></div></div>`; }).join('') || '<div class="empty">No lines yet.</div>'}</div></div>`;
}
const REASONS = ['Initial count', 'Recount found more', 'Recount found fewer', 'Damaged and thrown away', 'Other'];
// What an adjustment will change, shown beside the new count before saving.
function adjChange(l) {
  if (l.qty === '' || l.qty === null || l.qty === undefined) return '';
  const d = num(l.qty) - num((item(l.item_id) || {}).qty);
  return d === 0 ? 'No change' : `Change ${d > 0 ? '+' : '−'}${fmtQty(Math.abs(d))}`;
}
function adjReason(l) {
  if (l.reason) return l.reason;
  const d = num(l.qty) - num((item(l.item_id) || {}).qty);
  return d > 0 ? 'Recount found more' : d < 0 ? 'Recount found fewer' : 'Recount, no change';
}
function addEdLine(key, id) {
  const ed = S.le[key]; const it = item(id); if (!it) return;
  if (ed.lines.some(l => l.item_id === id)) return toast('Already on the list');
  ed.lines.push({ item_id: id, qty: key === 'adjust' ? num(it.qty) : 1, reason: '', jobcode_id: ed.lines.length ? ed.lines[ed.lines.length - 1].jobcode_id : null, note: '' });
  closeModal(); render();
}
ACT.edAdd = d => openModal('itemPick', { q: '', onPick: id => addEdLine(d.key, id), allowNew: d.key !== 'supplierReturn',
  filter: d.key === 'supplierReturn' ? (i => i.kind === 'consumable') : d.key === 'adjust' || d.key === 'receive' ? (i => i.kind === 'consumable' || i.counted) : null });
IN.edQty = (v, d) => { const l = S.le[d.key].lines[d.n]; l.qty = v === '' ? '' : num(v); const c = $('#chg-' + d.n); if (c) c.textContent = adjChange(l); };
IN.edNote = (v, d) => { S.le[d.key].lines[d.n].note = v; };
CH.edReason = (v, d) => { S.le[d.key].lines[d.n].reason = v; };
ACT.edRm = d => { S.le[d.key].lines.splice(Number(d.n), 1); render(); };
ACT.edJob = d => openModal('job', { onPick: id => { S.le[d.key].lines[d.n].jobcode_id = id; setTimeout(render); } });

MODALS.itemPick = () => modal('Add an item', `<div class="ip-top"><input type="search" placeholder="Search name or Item number" value="${esc(S.modal.q)}" data-in="ipQ" data-enter="ipEnter" data-autofocus autocomplete="off">
  ${S.modal.allowNew && isManager() ? `<button class="btn" data-act="ipNew">${icon('plus', 18)}New catalogue item</button>` : ''}</div>
  ${region('ipRes', () => `<div class="list">${searchItems(S.modal.q, S.modal.filter || (() => true), 40).map(i => itemRow(i, 'ipPick')).join('') || '<div class="empty">No match</div>'}</div>`)}`);
IN.ipQ = v => { S.modal.q = v; refresh('ipRes'); fillPhotos($('#modal-host')); };
ACT.ipPick = d => S.modal.onPick(d.id);
// Not in the Catalogue yet: make the item, then it goes straight onto the list.
ACT.ipNew = () => { const m = S.modal; ACT.newItem({ name: m.q.trim(), onSaved: m.onPick }); };
ACT.ipEnter = () => { const it = itemByCode(S.modal.q); if (it) S.modal.onPick(it.id); };

// ------------------------------------------------------------------ receive, adjust, supplier return
const RCV_SOURCES = { supplier: 'Supplier delivery', back: 'Brought back, no Job code', other: 'Other' };
SCREENS.receive = () => {
  S.le = S.le || {}; const ed = S.le.receive || (S.le.receive = { lines: [], note: '', po_id: null, source: 'supplier', reason: '' });
  const pos = V().pos.filter(p => p.status === 'open' || p.status === 'partial');
  const src = ed.source || 'supplier';
  const extra = src === 'supplier'
    ? `<label class="f">Purchase order (optional)<select data-ch="rcvPo"><option value="">No PO</option>${pos.map(p => `<option value="${p.id}" ${ed.po_id === p.id ? 'selected' : ''}>PO ${p.number} · ${esc(p.supplier)}</option>`).join('')}</select></label>`
    : src === 'other' ? `<label class="f">Reason<input type="text" value="${esc(ed.reason)}" data-in="rcvReason" placeholder="Where it came from"></label>` : '';
  return `<div class="head">${back('More', 'more')}<h1>Receive items</h1></div><div class="stack">
    <p class="muted">Anything coming into the warehouse. Parts coming back from a Job code are a Return in a Cart, so the job is credited.</p>
    <div class="panel pad grid2"><label class="f">What's coming in<select data-ch="rcvSrc">${Object.entries(RCV_SOURCES).map(([k, v]) => `<option value="${k}" ${src === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${extra}
      <label class="f">Note${src === 'supplier' ? ' (e.g. packing slip number)' : ' (optional)'}<input type="text" value="${esc(ed.note)}" data-in="leNote" data-key="receive"></label></div>
    ${lineEditor('receive', { qtyLabel: 'Received', note: true })}
    <div class="row"><span class="grow"></span><button class="btn primary" data-act="saveLe" data-key="receive">Add to Stock</button></div></div>`;
};
CH.rcvSrc = v => { const ed = S.le.receive; ed.source = v; if (v !== 'supplier') ed.po_id = null; render(); };
IN.rcvReason = v => { S.le.receive.reason = v; };
CH.rcvPo = v => {
  const ed = S.le.receive; ed.po_id = v || null;
  const po = V().pos.find(p => p.id === v);
  if (po) ed.lines = po.lines.map(l => ({ item_id: l.item_id, qty: Math.max(0, num(l.qty) - num(l.received)), note: '' })).filter(l => l.qty > 0);
  render();
};
IN.leNote = (v, d) => { S.le[d.key].note = v; };
SCREENS.adjust = () => `<div class="head">${back('More', 'more')}<h1>Adjust counts</h1></div><div class="stack">
  <p class="muted">Enter what is really on the shelf. The difference is recorded with the reason. Adjustments never go to billing.</p>
  ${lineEditor('adjust', { qtyLabel: 'New count', reason: true })}
  <div class="row"><span class="grow"></span><button class="btn primary" data-act="saveLe" data-key="adjust">Save counts</button></div></div>`;
SCREENS.supplierReturn = () => `<div class="head">${back('More', 'more')}<h1>Supplier return</h1></div><div class="stack">
  <p class="muted">Material from a Job code going straight back to the supplier. It never comes into the warehouse, so Stock does not change.</p>
  ${lineEditor('supplierReturn', { qtyLabel: 'Quantity', job: true, note: true })}
  <label class="f">Note<input type="text" value="${esc((S.le && S.le.supplierReturn && S.le.supplierReturn.note) || '')}" data-in="leNote" data-key="supplierReturn"></label>
  <div class="row"><span class="grow"></span><button class="btn primary" data-act="saveLe" data-key="supplierReturn">Save</button></div></div>`;
ACT.saveLe = async d => {
  const ed = S.le[d.key]; const lines = ed.lines.filter(l => l.qty !== '' && (d.key === 'adjust' ? num(l.qty) >= 0 : num(l.qty) > 0));
  if (!lines.length) return toast('Nothing to save');
  if (d.key === 'supplierReturn' && lines.some(l => !l.jobcode_id)) return toast('Every line needs a Job code');
  if (d.key === 'receive' && ed.source === 'other' && !String(ed.reason || '').trim()) return toast('Say where the items came from');
  const op = { receive: 'received', adjust: 'adjustment', supplierReturn: 'supplier_return' }[d.key];
  let note = ed.note || '';
  if (d.key === 'receive' && ed.source && ed.source !== 'supplier')
    note = [ed.source === 'back' ? RCV_SOURCES.back : 'Other: ' + String(ed.reason).trim(), note].filter(Boolean).join(' · ');
  await queue(op, { po_id: ed.po_id || undefined, note, source: d.key === 'receive' ? ed.source : undefined, count_id: ed.count_id || undefined,
    lines: lines.map(l => ({ item_id: l.item_id, qty: num(l.qty), jobcode_id: l.jobcode_id || undefined, note: l.note || '', reason: d.key === 'adjust' ? adjReason(l) : undefined })) });
  delete S.le[d.key]; go('home'); toast('Saved');
};

// ------------------------------------------------------------------ purchase orders
SCREENS.pos = () => {
  const pos = V().pos;
  return `<div class="head">${back('More', 'more')}<h1>Purchase orders</h1><button class="btn small primary" data-act="editPo">New PO</button></div>
    <div class="panel"><div class="list">${pos.map(p => `<div class="li"><span class="grow"><span class="t">PO ${p.number} · ${esc(p.supplier || 'No supplier')}</span>
      <div class="s">${({ open: 'Open', partial: 'Partly received', received: 'Received', cancelled: 'Cancelled' })[p.status]} · ${plural(p.lines.length, 'line')} · ${fmtD(p.created_at)}</div></span>
      <button class="btn small" data-act="printPo" data-id="${p.id}">Print</button><button class="btn small" data-act="csvPo" data-id="${p.id}">CSV</button>
      <button class="btn small" data-act="editPo" data-id="${p.id}">Edit</button></div>`).join('') || '<div class="empty">No purchase orders yet.</div>'}</div></div>`;
};
ACT.editPo = d => {
  const p = V().pos.find(x => x.id === d.id);
  S.le = S.le || {}; S.le.po = p ? { id: p.id, supplier: p.supplier, note: p.note, status: p.status, lines: p.lines.map(l => ({ ...l })) }
    : { id: uuid(), supplier: '', note: '', status: 'open', lines: [] };
  go('poEdit');
};
SCREENS.poEdit = () => {
  const x = S.le.po;
  return `<div class="head">${back('POs', 'pos')}<h1>${x.number ? 'PO ' + x.number : 'Purchase order'}</h1></div><div class="stack">
    <div class="panel pad grid2"><label class="f">Supplier<input type="text" value="${esc(x.supplier)}" data-in="poF" data-f="supplier" data-autofocus></label>
      <label class="f">Status<select data-ch="poF" data-f="status">${['open', 'partial', 'received', 'cancelled'].map(s => `<option value="${s}" ${x.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="f" style="grid-column:1/-1">Note<input type="text" value="${esc(x.note)}" data-in="poF" data-f="note"></label></div>
    ${lineEditor('po', { qtyLabel: 'Order' })}
    <div class="row"><span class="grow"></span><button class="btn primary" data-act="savePo">Save PO</button></div></div>`;
};
IN.poF = CH.poF = (v, d) => { S.le.po[d.f] = v; };
ACT.savePo = async () => {
  const x = S.le.po; if (!x.lines.length) return toast('Add at least one item');
  await queue('po_save', { id: x.id, supplier: x.supplier, note: x.note, status: x.status, lines: x.lines.map(l => ({ item_id: l.item_id, qty: num(l.qty), received: num(l.received) })) });
  delete S.le.po; go('pos'); toast('PO saved');
};
function poRows(p) { return p.lines.map(l => { const it = item(l.item_id) || {}; return [it.number, it.name, fmtQty(l.qty), fmtQty(l.received || 0)]; }); }
ACT.printPo = d => {
  const p = V().pos.find(x => x.id === d.id);
  printHtml(`<h1>${esc(B.company || '')} Purchase order ${p.number}</h1><p>Supplier: ${esc(p.supplier)}<br>Date: ${fmtD(p.created_at)}${p.note ? '<br>Note: ' + esc(p.note) : ''}</p>
    <table><thead><tr><th>Item number</th><th>Item</th><th>Quantity</th><th>Received</th></tr></thead><tbody>${poRows(p).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
};
ACT.csvPo = d => { const p = V().pos.find(x => x.id === d.id); downloadCsv(`PO-${p.number}.csv`, [['Item number', 'Item', 'Quantity', 'Received'], ...poRows(p)]); };

// ------------------------------------------------------------------ pick list setup
ACT.editPick = d => {
  const p = V().picks.find(x => x.id === d.id);
  S.le = S.le || {}; S.le.pick = p ? { id: p.id, name: p.name, jobcode_id: p.jobcode_id, status: p.status, lines: p.lines.map(l => ({ ...l })) }
    : { id: uuid(), name: '', jobcode_id: null, status: 'open', lines: [] };
  go('pickEdit');
};
SCREENS.pickEdit = () => {
  const x = S.le.pick;
  return `<div class="head">${back('Pick lists', 'picks')}<h1>Pick list</h1></div><div class="stack">
    <div class="panel pad grid2"><label class="f">Name<input type="text" value="${esc(x.name)}" data-in="pkF" data-f="name" placeholder="e.g. Smith rough-in" data-autofocus></label>
      <label class="f">Job code<button class="jobchip ${x.jobcode_id ? 'set' : 'missing'}" data-act="pkJob">${x.jobcode_id ? esc(jobLabel(x.jobcode_id)) : 'Choose Job code'}</button></label></div>
    ${lineEditor('pick', { qtyLabel: 'Quantity' })}
    <div class="row">${x.status === 'open' ? '<button class="btn danger" data-act="cancelPick">Cancel list</button>' : ''}<span class="grow"></span><button class="btn primary" data-act="savePick">Save</button></div></div>`;
};
IN.pkF = (v, d) => { S.le.pick[d.f] = v; };
ACT.pkJob = () => openModal('job', { onPick: id => { S.le.pick.jobcode_id = id; setTimeout(render); } });
ACT.savePick = async () => {
  const x = S.le.pick; if (!x.name.trim() || !x.jobcode_id || !x.lines.length) return toast('Give it a name, a Job code and at least one item');
  await queue('pick_save', { id: x.id, name: x.name.trim(), jobcode_id: x.jobcode_id, status: x.status, lines: x.lines.map(l => ({ item_id: l.item_id, qty: num(l.qty), picked: !!l.picked })) });
  delete S.le.pick; go('picks'); toast('Pick list saved');
};
ACT.cancelPick = async () => { const x = S.le.pick; x.status = 'cancelled'; await ACT.savePick(); };

// ------------------------------------------------------------------ stock count setup and review
ACT.newCount = () => openModal('newCount', { name: 'Count ' + fmtD(new Date().toISOString()), locs: [], who: '' });
MODALS.newCount = () => {
  const m = S.modal; const locs = [...V().locations.values()].filter(l => !l.archived);
  return modal('New stock count', `<label class="f">Name<input type="text" value="${esc(m.name)}" data-in="ncF" data-f="name"></label>
    <label class="f">Who counts<select data-ch="ncF" data-f="who"><option value="">Anyone (Managers)</option>${[...V().users.values()].map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
    <div><h3>Locations (none ticked = everywhere)</h3>${locs.map(l => `<label class="check"><input type="checkbox" data-ch="ncLoc" data-id="${l.id}"> ${esc(locPath(l.id))}</label>`).join('') || '<p class="muted small">No locations set up, so the count covers everything.</p>'}</div>`,
    `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="createCount">Start count</button>`);
};
IN.ncF = CH.ncF = (v, d) => { S.modal[d.f] = v; };
CH.ncLoc = (v, d, el) => { const s = new Set(S.modal.locs); el.checked ? s.add(d.id) : s.delete(d.id); S.modal.locs = [...s]; };
ACT.createCount = async () => {
  const m = S.modal; const L = V().locations;
  const inside = id => { let cur = L.get(id), g = 0; while (cur && g++ < 10) { if (m.locs.includes(cur.id)) return true; cur = L.get(cur.parent_id); } return false; };
  const items = V().itemList.filter(i => !i.archived && (i.kind === 'consumable' || i.counted) && (!m.locs.length || inside(i.location_id)));
  if (!items.length) return toast('No items in those locations');
  await queue('count_save', { id: uuid(), name: m.name, location_ids: m.locs, assigned_to: m.who ? Number(m.who) : null,
    lines: items.map(i => ({ item_id: i.id, expected: num(i.qty), counted: null })), status: 'open' });
  closeModal(); toast('Count started'); render();
};
SCREENS.countReview = () => {
  const c = V().counts.find(x => x.id === S.params.id); if (!c) return back() + '<div class="empty">Not found</div>';
  const rows = c.lines.filter(l => l.counted !== null && l.counted !== undefined);
  return `<div class="head">${back('Counts', 'counts')}<h1>Review: ${esc(c.name)}</h1></div>
    <p class="muted small" style="margin-bottom:8px">Applying sets each counted item to the counted number, with the reason "Recount". Items left blank are not changed.</p>
    <div class="panel table-wrap"><table class="t"><thead><tr><th>Item</th><th class="right">Expected</th><th class="right">Now</th><th class="right">Counted</th><th class="right">Difference</th></tr></thead>
      <tbody>${rows.map(l => { const it = item(l.item_id) || {}; const diff = num(l.counted) - num(it.qty);
        return `<tr><td>${esc(it.name)} <span class="num">${esc(it.number || '')}</span></td><td class="n">${fmtQty(l.expected)}</td><td class="n">${fmtQty(it.qty)}</td>
          <td class="n"><b>${fmtQty(l.counted)}</b></td><td class="n" style="color:${diff ? 'var(--warn)' : 'inherit'}">${diff > 0 ? '+' : ''}${fmtQty(diff)}</td></tr>`; }).join('')}</tbody></table></div>
    <div class="row" style="margin-top:10px"><button class="btn danger" data-act="cancelCount" data-id="${c.id}">Discard count</button><span class="grow"></span>
      <button class="btn primary" data-act="applyCount" data-id="${c.id}">Apply ${plural(rows.filter(l => num(l.counted) !== num((item(l.item_id) || {}).qty)).length, 'change')}</button></div>`;
};
ACT.applyCount = async d => {
  const c = V().counts.find(x => x.id === d.id);
  const lines = c.lines.filter(l => l.counted !== null && l.counted !== undefined && num(l.counted) !== num((item(l.item_id) || {}).qty))
    .map(l => ({ item_id: l.item_id, qty: num(l.counted), reason: 'Recount: ' + c.name }));
  if (lines.length) await queue('adjustment', { lines, count_id: c.id, note: c.name });
  else await queue('count_save', { id: c.id, status: 'applied' });
  go('counts'); toast('Count applied');
};
ACT.cancelCount = async d => { if (!confirm('Discard this count?')) return; await queue('count_save', { id: d.id, status: 'cancelled' }); go('counts'); };

// ------------------------------------------------------------------ alerts
function alertList() {
  const v = V(); const out = []; const today = new Date();
  for (const i of v.itemList) {
    if (i.archived) continue;
    if (num(i.qty) < 0) out.push({ kind: 'bad', text: `Count is off: ${i.name}`, sub: `${i.number} · the app thinks ${fmtQty(i.qty)} are on the shelf. Please recount.`, item: i.id });
    else if (i.low_stock !== null && i.low_stock !== undefined && num(i.qty) <= num(i.low_stock)) out.push({ kind: 'warn', text: `Low stock: ${i.name}`, sub: `${i.number} · ${fmtQty(i.qty)} left, alert at ${fmtQty(i.low_stock)}`, item: i.id });
    for (const f of v.fields.values()) {
      if (f.ftype !== 'date' || f.archived || f.alert_days === null || f.alert_days === undefined) continue;
      const d = i.custom && i.custom[f.id]; if (!d) continue;
      const days = Math.floor((new Date(d + 'T12:00:00Z') - today) / 86400000);
      if (days <= num(f.alert_days)) out.push({ kind: days < 0 ? 'bad' : 'warn', text: `${f.name}: ${i.name}`, sub: `${i.number} · ${days < 0 ? 'was due ' + -days + ' days ago' : days === 0 ? 'due today' : 'due in ' + days + ' days'}`, item: i.id });
    }
  }
  const od = num(setting('overdue_days', 7));
  for (const c of v.checkouts) {
    const days = Math.floor((Date.now() - new Date(c.opened_at)) / 86400000);
    if (days >= od) { const it = item(c.item_id) || {}; out.push({ kind: 'warn', text: `Overdue: ${it.name}`, sub: `With ${userName(c.user_id)} for ${days} days · ${jobLabel(c.jobcode_id)}`, item: c.item_id }); }
  }
  if (jobsStale()) out.push({ kind: 'warn', text: 'Job code list is old', sub: `Last updated ${ago(S.jobs.synced_at)}. New jobs may be missing.` });
  const dl = S.snap.delivery || {};
  if (dl.waiting && dl.oldest_waiting && Date.now() - new Date(dl.oldest_waiting) > 20 * 60000) out.push({ kind: 'bad', text: 'Billing documents are not reaching Drive', sub: `${plural(dl.waiting, 'document')} waiting since ${fmtDT(dl.oldest_waiting)}${dl.last_error ? ' · ' + dl.last_error : ''}` });
  if (S.failed.length) out.push({ kind: 'bad', text: `${plural(S.failed.length, 'entry', 'entries')} refused by the server`, sub: 'See Device and delivery.', to: 'status' });
  if (S.outbox.length && S.outbox.some(o => Date.now() - o.queued > 30 * 60000)) out.push({ kind: 'warn', text: 'Entries waiting to send for over 30 minutes', sub: 'Check the internet connection.', to: 'status' });
  return out;
}
SCREENS.alerts = () => {
  const a = alertList();
  return `<div class="head">${back('More', 'more')}<h1>Alerts</h1></div><div class="panel"><div class="list">${a.map(x => `<button class="li" ${x.item ? `data-act="openItem" data-id="${x.item}"` : x.to ? `data-act="go" data-to="${x.to}"` : ''}>
    <span class="pill ${x.kind}">${x.kind === 'bad' ? '!' : '•'}</span><span class="grow"><span class="t">${esc(x.text)}</span><div class="s">${esc(x.sub)}</div></span></button>`).join('') || '<div class="empty">Nothing needs a look.</div>'}</div></div>`;
};

// ------------------------------------------------------------------ reports
const REPORTS = {
  activity: 'Activity history', stock: 'Stock summary', users: 'User activity', low: 'Low stock', moves: 'Moves',
  flow: 'Item flow', transactions: 'Transactions',
};
SCREENS.reports = () => {
  const p = S.params; p.kind = p.kind || 'transactions';
  if (!p.from) { const d = new Date(); d.setDate(d.getDate() - 30); p.from = d.toISOString().slice(0, 10); }
  if (!p.to) p.to = new Date().toISOString().slice(0, 10);
  const needsDates = !['stock', 'low'].includes(p.kind);
  const saved = S.snap.reports || [];
  const kinds = isDesk() ? `<div class="rep-kinds">${Object.entries(REPORTS).map(([k, t]) => `<button class="nav-i ${p.kind === k ? 'on' : ''}" aria-pressed="${p.kind === k}" data-act="rpKind" data-k="${k}"><span class="nav-l">${t}</span></button>`).join('')}
      ${saved.length ? `<span class="nav-h">Saved</span>${saved.map(r => `<button class="nav-i" data-act="rpLoadBtn" data-id="${r.id}"><span class="nav-l">${esc(r.name)}</span></button>`).join('')}` : ''}</div>`
    : `<select data-ch="rpF" data-f="kind" aria-label="Report" class="rep-sel">${Object.entries(REPORTS).map(([k, t]) => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  return `${pageHead('Reports', '', isWide() ? null : 'more', 'More')}<div class="rep ${isDesk() ? 'desk' : ''}">${isDesk() ? kinds : ''}
    <section class="rep-main">
      <div class="filters">${isDesk() ? '' : kinds}
        ${needsDates ? `<label class="filt">From <input type="date" value="${p.from}" data-ch="rpF" data-f="from"></label>
        <label class="filt">To <input type="date" value="${p.to}" data-ch="rpF" data-f="to"></label>` : ''}
        <label class="filt">Person <select data-ch="rpF" data-f="user"><option value="">Everyone</option>${[...V().users.values()].map(u => `<option value="${u.id}" ${String(p.user) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
        <span class="filt">Job code <button class="link" data-act="rpJob">${p.job ? esc(jobLabel(p.job)) : 'Any'}</button>${p.job ? `<button class="icon-x" data-act="rpClear" data-f="job" aria-label="Clear Job code">${icon('x', 16)}</button>` : ''}</span>
        ${V().locations.size ? `<label class="filt">Location <select data-ch="rpF" data-f="loc"><option value="">Any</option>${[...V().locations.values()].map(l => `<option value="${l.id}" ${p.loc === l.id ? 'selected' : ''}>${esc(locPath(l.id))}</option>`).join('')}</select></label>` : ''}
        <label class="filt">Tag <input type="text" value="${esc(p.tag || '')}" data-ch="rpF" data-f="tag" placeholder="Any" size="8"></label>
        <span class="filt">Item <button class="link" data-act="rpItem">${p.item ? esc((item(p.item) || {}).name || 'Item') : 'Any'}</button>${p.item ? `<button class="icon-x" data-act="rpClear" data-f="item" aria-label="Clear item">${icon('x', 16)}</button>` : ''}</span>
      </div>
      <div class="row"><button class="btn primary" data-act="runReport">Run</button><span class="grow"></span>
        <button class="btn" data-act="rpSave">Save as…</button><button class="btn" data-act="rpPrint">Print or PDF</button><button class="btn" data-act="rpCsv">Export CSV</button>
        ${!isDesk() && saved.length ? `<select data-ch="rpLoad" aria-label="Saved reports"><option value="">Saved reports</option>${saved.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>` : ''}</div>
      ${region('rpOut', () => S.report ? reportTable(S.report) : '<div class="empty card flat">Choose a report and press Run.</div>')}
    </section></div>`;
};
ACT.rpKind = d => { S.params.kind = d.k; S.report = null; render(); };
ACT.rpLoadBtn = d => CH.rpLoad(d.id);
CH.rpF = (v, d) => { S.params[d.f] = v; if (d.f === 'kind') { S.report = null; render(); } };
ACT.rpJob = () => openModal('job', { onPick: id => { S.params.job = id; setTimeout(render); } });
ACT.rpItem = () => openModal('itemPick', { q: '', onPick: id => { S.params.item = id; closeModal(); render(); } });
ACT.rpClear = d => { delete S.params[d.f]; render(); };
ACT.rpSave = async () => {
  const name = prompt('Name for this report'); if (!name) return;
  const { kind, user, job, loc, tag, item: it } = S.params;
  await queue('report_save', { id: uuid(), name, kind, filters: { user, job, loc, tag, item: it } }); toast('Saved');
};
CH.rpLoad = v => { const r = (S.snap.reports || []).find(x => x.id === v); if (!r) return; S.params = { ...S.params, kind: r.kind, ...r.filters }; S.report = null; render(); };
ACT.runReport = async () => {
  const p = S.params; refresh('rpOut'); $('#rpOut').innerHTML = '<div class="empty">Loading…</div>';
  try { S.report = await buildReport(p); } catch (e) { S.report = { title: 'Error', head: ['Message'], rows: [[e.message]] }; }
  refresh('rpOut');
};
async function fetchRange(kind) {
  const p = S.params; const from = new Date(p.from + 'T00:00:00'); const to = new Date(p.to + 'T00:00:00'); to.setDate(to.getDate() + 1);
  return rpc('wh_query', { p_key: S.key, p_kind: kind, p_from: from.toISOString(), p_to: to.toISOString() });
}
const KIND_NAMES = { take: 'Take out', return: 'Return', checkout: 'Check out', checkin: 'Check in', received: 'Received', adjust: 'Adjustment',
  supplier_return: 'Supplier return', correction: 'Correction', move: 'Move', status: 'Status' };
function itemOk(id) {
  const p = S.params; const it = item(id) || {};
  if (p.item && id !== p.item) return false;
  if (p.loc && it.location_id !== p.loc) return false;
  if (p.tag && !(it.tags || []).map(norm).includes(norm(p.tag))) return false;
  return true;
}
async function buildReport(p) {
  const uOk = (...ids) => !p.user || ids.some(x => String(x) === String(p.user));
  const jOk = j => !p.job || String(j) === String(p.job);
  const name = id => (item(id) || {}).name || '?'; const nr = id => (item(id) || {}).number || '';
  if (p.kind === 'stock' || p.kind === 'low') {
    let list = V().itemList.filter(i => !i.archived && itemOk(i.id));
    if (p.kind === 'low') list = list.filter(i => num(i.qty) < 0 || (i.low_stock !== null && i.low_stock !== undefined && num(i.qty) <= num(i.low_stock)));
    return { title: REPORTS[p.kind], head: p.kind === 'low' ? ['Item number', 'Item', 'Location', 'On shelf', 'Low-stock level', 'To reach level'] : ['Item number', 'Item', 'Type', 'Location', 'Tags', 'On shelf'],
      rows: list.map(i => p.kind === 'low' ? [i.number, i.name, locPath(i.location_id), fmtQty(i.qty), fmtQty(i.low_stock ?? ''), fmtQty(Math.max(0, num(i.low_stock) - num(i.qty)))]
        : [i.number, i.name, i.kind === 'equipment' ? 'Equipment' : 'Consumable', locPath(i.location_id), (i.tags || []).join(', '), onShelf(i)]), num: [p.kind === 'low' ? 3 : 5] };
  }
  if (p.kind === 'activity') {
    const rows = (await fetchRange('activity')).filter(a => uOk(a.user_id));
    return { title: REPORTS.activity, head: ['When', 'Who', 'What', 'Detail'],
      rows: rows.map(a => [fmtDT(a.at), userName(a.user_id), a.action.replace(/_/g, ' '), [a.target, Object.entries(a.detail || {}).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')].filter(Boolean).join(' · ')]) };
  }
  if (p.kind === 'moves' || p.kind === 'flow') {
    const rows = (await fetchRange('ledger')).filter(l => itemOk(l.item_id) && uOk(l.user_id, l.on_behalf_of) && jOk(l.jobcode_id) && (p.kind === 'flow' || l.kind === 'move'));
    if (p.kind === 'moves') return { title: REPORTS.moves, head: ['When', 'Item number', 'Item', 'From', 'To', 'Who'], rows: rows.map(l => [fmtDT(l.at), nr(l.item_id), name(l.item_id), locPath(l.from_location), locPath(l.to_location), userName(l.user_id)]) };
    return { title: REPORTS.flow, head: ['When', 'Item number', 'Item', 'What', 'Before', 'Change', 'After', 'Job code', 'Who', 'Cart', 'Note'], num: [4, 5, 6],
      rows: rows.filter(l => l.kind !== 'move').map(l => [fmtDT(l.at), nr(l.item_id), name(l.item_id), KIND_NAMES[l.kind] || l.kind, fmtQty(num(l.qty_after) - num(l.delta)), (num(l.delta) > 0 ? '+' : '') + fmtQty(l.delta), fmtQty(l.qty_after), jobLabel(l.jobcode_id), userName(l.user_id) + (l.on_behalf_of ? ' for ' + userName(l.on_behalf_of) : ''), l.cart_id || '', l.note || ''] ) };
  }
  const carts = await fetchRange('carts');
  if (p.kind === 'users') {
    const by = new Map();
    for (const c of carts) {
      const who = c.on_behalf_of || c.entered_by; if (!uOk(who)) continue;
      const r = by.get(who) || { carts: 0, take: 0, ret: 0, out: 0, back: 0, corr: 0 }; by.set(who, r);
      if (c.kind === 'correction') { r.corr++; continue; } if (c.kind !== 'cart') continue; r.carts++;
      for (const l of c.lines) { if (!itemOk(l.item_id) || !jOk(l.jobcode_id)) continue;
        if (l.kind === 'take') r.take += num(l.qty); if (l.kind === 'return') r.ret += num(l.qty); if (l.kind === 'checkout') r.out++; if (l.kind === 'checkin') r.back++; }
    }
    return { title: REPORTS.users, head: ['Person', 'Carts', 'Taken out', 'Returned', 'Checked out', 'Checked in', 'Corrections'], num: [1, 2, 3, 4, 5, 6],
      rows: [...by.entries()].sort((a, b) => userName(a[0]).localeCompare(userName(b[0]))).map(([u, r]) => [userName(u), r.carts, fmtQty(r.take), fmtQty(r.ret), r.out, r.back, r.corr]) };
  }
  const rows = [];
  for (const c of carts) for (const l of c.lines) {
    if (!itemOk(l.item_id) || !jOk(l.jobcode_id) || !uOk(c.entered_by, c.on_behalf_of)) continue;
    rows.push([fmtDT(c.received_at), c.kind === 'correction' ? `${c.correction_of} (Correction ${c.correction_seq})` : c.id, KIND_NAMES[l.kind] || l.kind, nr(l.item_id), name(l.item_id), fmtQty(l.qty),
      jobLabel(l.jobcode_id), userName(c.entered_by) + (c.on_behalf_of ? ' for ' + userName(c.on_behalf_of) : ''), [l.note, l.reason, c.correction_note].filter(Boolean).join(' · ')]);
  }
  return { title: REPORTS.transactions, head: ['When', 'Cart', 'What', 'Item number', 'Item', 'Qty', 'Job code', 'Who', 'Notes'], rows, num: [5] };
}
function reportTable(r) {
  const n = new Set(r.num || []);
  return `<p class="muted sub">${esc(r.title)} · ${plural(r.rows.length, 'row')}</p><div class="card flat table-wrap"><table class="t"><thead><tr>${r.head.map((h, i) => `<th class="${n.has(i) ? 'right' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${r.rows.slice(0, 2000).map(row => `<tr>${row.map((c, i) => `<td class="${n.has(i) ? 'n' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${r.head.length}" class="muted">Nothing in this period.</td></tr>`}</tbody></table></div>`;
}
ACT.rpCsv = () => { if (!S.report) return toast('Run the report first'); downloadCsv(`${S.report.title} ${S.params.from || ''}.csv`.trim(), [S.report.head, ...S.report.rows]); };
ACT.rpPrint = () => { if (!S.report) return toast('Run the report first'); const r = S.report;
  printHtml(`<h1>${esc(r.title)}</h1><p>${['stock', 'low'].includes(S.params.kind) ? fmtD(new Date().toISOString()) : esc(S.params.from + ' to ' + S.params.to)}</p><table><thead><tr>${r.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${r.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); };

// ------------------------------------------------------------------ people and PINs
SCREENS.people = () => `<div class="head">${back('More', 'more')}<h1>People and PINs</h1></div>
  <p class="muted small" style="margin-bottom:8px">The list comes from QuickBooks Time. New hires appear on their own; people who leave disappear.</p>
  <div class="panel"><div class="list">${[...V().users.values()].map(u => `<div class="li" style="cursor:default"><span class="grow"><span class="t">${esc(u.name)}</span>
    <div class="s">${u.role === 'manager' ? 'Manager' : 'User'} · ${u.hash ? 'Has a PIN' : 'No PIN yet'}</div></span>
    <button class="btn small" data-act="setPinFor" data-id="${u.id}">${u.hash ? 'Change PIN' : 'Set PIN'}</button>
    ${u.id !== S.user.id ? `<button class="btn small" data-act="toggleRole" data-id="${u.id}">${u.role === 'manager' ? 'Make User' : 'Make Manager'}</button>` : ''}</div>`).join('')}</div></div>`;
ACT.toggleRole = async d => {
  const u = V().users.get(Number(d.id)); const role = u.role === 'manager' ? 'user' : 'manager';
  if (!confirm(`${role === 'manager' ? 'Make' : 'Remove'} ${u.name} ${role === 'manager' ? 'a Manager' : 'as Manager'}?`)) return;
  await queue('user_save', { user_id: u.id, role }); render();
};

// ------------------------------------------------------------------ locations and custom fields
SCREENS.setup2 = () => {
  const locs = [...V().locations.values()].sort((a, b) => locPath(a.id).localeCompare(locPath(b.id)));
  const fields = [...V().fields.values()].sort((a, b) => a.sort - b.sort);
  return `<div class="head">${back('More', 'more')}<h1>Locations and fields</h1></div><div class="cols">
    <section class="panel"><div class="pad row"><h2 class="grow">Locations</h2><button class="btn small primary" data-act="editLoc">Add</button></div>
      <div class="list">${locs.map(l => `<button class="li" data-act="editLoc" data-id="${l.id}"><span class="grow"><span class="t">${esc(locPath(l.id))}</span>${l.archived ? '<div class="s">Archived</div>' : ''}</span></button>`).join('') || '<div class="empty">No locations yet. Add areas, shelves and bins.</div>'}</div></section>
    <section class="panel"><div class="pad row"><h2 class="grow">Custom fields</h2><button class="btn small primary" data-act="editField">Add</button></div>
      <div class="list">${fields.map(f => `<button class="li" data-act="editField" data-id="${f.id}"><span class="grow"><span class="t">${esc(f.name)}</span>
        <div class="s">${({ text: 'Text', number: 'Number', date: 'Date', bool: 'Yes / no', choice: 'Pick from a list' })[f.ftype]}${f.ftype === 'date' && f.alert_days !== null && f.alert_days !== undefined ? ` · alert ${f.alert_days} days before` : ''}${f.archived ? ' · Archived' : ''}</div></span></button>`).join('') || '<div class="empty">No custom fields yet.</div>'}</div></section></div>`;
};
ACT.editLoc = d => { const l = V().locations.get(d.id); openModal('loc', { x: l ? { ...l } : { id: uuid(), name: '', parent_id: '', archived: false } }); };
MODALS.loc = () => { const x = S.modal.x; const others = [...V().locations.values()].filter(l => l.id !== x.id && !l.archived);
  return modal(x.name ? 'Edit location' : 'New location', `<label class="f">Name<input type="text" value="${esc(x.name)}" data-in="mx" data-f="name" data-autofocus placeholder="e.g. Shelf B"></label>
    <label class="f">Inside<select data-ch="mx" data-f="parent_id"><option value="">Top level</option>${others.map(l => `<option value="${l.id}" ${x.parent_id === l.id ? 'selected' : ''}>${esc(locPath(l.id))}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" data-ch="mx" data-f="archived" ${x.archived ? 'checked' : ''}> Archived</label>`,
    `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="saveLoc">Save</button>`); };
IN.mx = CH.mx = (v, d, el) => { S.modal.x[d.f] = el.type === 'checkbox' ? el.checked : v; if (d.f === 'ftype') renderModal(); };
ACT.saveLoc = async () => { const x = S.modal.x; if (!x.name.trim()) return toast('Give it a name');
  await queue('location_save', { id: x.id, name: x.name.trim(), parent_id: x.parent_id || null, archived: !!x.archived }); closeModal(); render(); };
ACT.editField = d => { const f = V().fields.get(d.id); openModal('field', { x: f ? { ...f, options: (f.options || []).join(', ') } : { id: uuid(), name: '', ftype: 'text', options: '', alert_days: '', sort: V().fields.size, archived: false } }); };
MODALS.field = () => { const x = S.modal.x;
  return modal(x.name ? 'Edit field' : 'New custom field', `<label class="f">Name<input type="text" value="${esc(x.name)}" data-in="mx" data-f="name" data-autofocus placeholder="e.g. Supplier part number"></label>
    <label class="f">Type<select data-ch="mx" data-f="ftype">${[['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['bool', 'Yes / no'], ['choice', 'Pick from a list']].map(([k, t]) => `<option value="${k}" ${x.ftype === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    ${x.ftype === 'choice' ? `<label class="f">Choices (comma between)<input type="text" value="${esc(x.options)}" data-in="mx" data-f="options"></label>` : ''}
    ${x.ftype === 'date' ? `<label class="f">Alert this many days before (blank for no alert)<input type="number" value="${esc(x.alert_days ?? '')}" data-in="mx" data-f="alert_days"></label>` : ''}
    <label class="check"><input type="checkbox" data-ch="mx" data-f="archived" ${x.archived ? 'checked' : ''}> Archived</label>`,
    `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="saveField">Save</button>`); };
ACT.saveField = async () => { const x = S.modal.x; if (!x.name.trim()) return toast('Give it a name');
  await queue('field_save', { id: x.id, name: x.name.trim(), ftype: x.ftype, options: String(x.options || '').split(',').map(s => s.trim()).filter(Boolean),
    alert_days: x.alert_days === '' || x.alert_days === null || x.alert_days === undefined ? null : num(x.alert_days), sort: num(x.sort), archived: !!x.archived });
  closeModal(); render(); };

// ------------------------------------------------------------------ device, sending and billing delivery
SCREENS.status = () => {
  const dl = (S.snap && S.snap.delivery) || {};
  return `<div class="head">${back('More', 'more')}<h1>Device and delivery</h1><button class="btn small" data-act="syncNow">Send and refresh now</button></div><div class="cols">
    <section class="panel pad stack"><h2>This device</h2><dl class="kv">
      <dt>Connection</dt><dd>${S.lastError ? 'Offline: ' + esc(S.lastError) : S.lastSync ? 'Online, updated ' + ago(S.lastSync) : 'Not connected yet'}</dd>
      <dt>Waiting to send</dt><dd>${plural(S.outbox.length, 'entry', 'entries')}</dd>
      <dt>Storage kept safe</dt><dd>${S.persisted ? 'Yes' : S.persisted === false ? 'No. Chrome may clear data if space runs low.' : 'Unknown'}</dd>
      <dt>Job codes</dt><dd>${S.jobs.list.length} · updated in QuickBooks Time ${S.jobs.synced_at ? ago(S.jobs.synced_at) : '?'}</dd>
      <dt>App version</dt><dd>${esc(B.version || '')}</dd></dl>
      ${S.failed.length ? `<h3>Refused by the server</h3><div class="list">${S.failed.map((f, n) => `<div class="li" style="cursor:default"><span class="grow"><span class="t">${esc(f.op)} by ${esc(userName(f.user_id))}</span>
        <div class="s">${fmtDT(f.at)} · ${esc(f.error)}</div></span>${isManager() ? `<button class="btn small" data-act="dropFailed" data-n="${n}">Dismiss</button>` : ''}</div>`).join('')}</div>
        <p class="muted small">These were not saved. Enter them again if they are still needed.</p>` : ''}
      ${isManager() ? `<h3>Unsent entries</h3>
        <p class="muted small">Save the entries that have not been sent yet to a file on this tablet before anything is done to the browser. If its data is ever lost, load the file here after entering the device key again. Loading the same file twice is safe: the server ignores entries it already has.</p>
        <div class="row"><button class="btn small" data-act="exportOutbox" ${S.outbox.length ? '' : 'disabled'}>Save ${plural(S.outbox.length, 'unsent entry', 'unsent entries')} to a file</button>
          <label class="btn small">Load entries from a file<input type="file" accept=".json,application/json" data-ch="importOutbox" hidden></label></div>
        <button class="btn danger small" data-act="forgetKey">Disconnect this device</button>` : ''}</section>
    ${isManager() ? `<section class="panel pad stack"><h2>Billing documents in Drive</h2><dl class="kv">
      <dt>Waiting</dt><dd>${dl.waiting || 0}${dl.oldest_waiting ? ' since ' + fmtDT(dl.oldest_waiting) : ''}</dd>
      <dt>Last delivered</dt><dd>${dl.last_delivered ? fmtDT(dl.last_delivered) : 'Never'}</dd>
      ${dl.last_error ? `<dt>Last problem</dt><dd>${esc(dl.last_error)}</dd>` : ''}</dl>
      <p class="muted small">The script in the billing Google account checks every 5 minutes.</p>
      <h2>Settings</h2>
      <label class="f">Sign out after this many minutes without a tap<input type="number" min="1" value="${esc(setting('idle_minutes', 10))}" data-ch="setS" data-k="idle_minutes" style="width:120px"></label>
      <label class="f">Equipment is overdue after this many days<input type="number" min="1" value="${esc(setting('overdue_days', 7))}" data-ch="setS" data-k="overdue_days" style="width:120px"></label></section>` : ''}</div>`;
};
ACT.syncNow = async () => { await sync({ full: true }); render(); toast(S.lastError ? 'Could not reach the server' : 'Up to date'); };
ACT.dropFailed = async d => { S.failed.splice(Number(d.n), 1); await DB.put('kv', S.failed, 'failed'); render(); };
CH.setS = async (v, d) => { if (num(v) < 1) return; await queue('setting_save', { key: d.k, value: num(v) }); toast('Saved'); };
ACT.exportOutbox = () => {
  if (!S.outbox.length) return toast('Nothing waiting to send');
  const file = { kind: 'warehouse-unsent-entries', version: 1, exported_at: new Date().toISOString(), entries: S.outbox };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
  a.download = `unsent-entries-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  toast(`Saved ${plural(S.outbox.length, 'entry', 'entries')}. Keep the file until they are sent.`, 4000);
};
CH.importOutbox = async (v, d, el) => {
  const f = el.files && el.files[0]; el.value = ''; if (!f) return;
  let file; try { file = JSON.parse(await f.text()); } catch { return toast('That is not a saved entries file'); }
  if (!file || file.kind !== 'warehouse-unsent-entries' || !Array.isArray(file.entries)) return toast('That is not a saved entries file');
  let added = 0;
  for (const o of file.entries) {
    if (!o || !o.client_id || !o.op || S.outbox.some(x => x.client_id === o.client_id)) continue;
    await DB.put('outbox', o); S.outbox.push(o); added++;
  }
  S.viewVer++; toast(added ? `Loaded ${plural(added, 'entry', 'entries')}. Sending now.` : 'Those entries are already on this tablet', 4000);
  await sync(); render();
};
ACT.forgetKey = async () => {
  if (S.outbox.length) return toast('Some entries have not been sent yet. Connect to the internet first.');
  if (!confirm('Disconnect this device? It will need the device key again.')) return;
  await DB.del('kv', 'device_key'); S.key = null; S.user = null; go('setup');
};
