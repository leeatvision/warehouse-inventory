// Runs the billing script's delivery against a pretend Google Drive and checks where each version ends up.
// Run: node tests/delivery-sim.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let nextId = 1; const files = new Map(); const folders = new Map(); const mails = [];
const iter = list => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
function mkFolder(name, parent) {
  const f = { id: 'fo' + nextId++, name, parent, getId: () => f.id, getName: () => f.name, getParents: () => iter(f.parent ? [f.parent] : []),
    createFile: blob => mkFile(blob.name, f), searchFiles: () => iter([...files.values()].filter(x => x.parent === f && !x.trashed)) };
  folders.set(f.id, f); return f;
}
function mkFile(name, parent, desc = '') {
  const x = { id: 'fi' + nextId++, name, parent, trashed: false, desc, getId: () => x.id, getName: () => x.name, getParents: () => iter([x.parent]),
    isTrashed: () => x.trashed, setTrashed: v => { x.trashed = v; }, setDescription: v => { x.desc = v; }, getDescription: () => x.desc,
    getUrl: () => 'https://drive/' + x.id, getBlob: () => blob(x.name) };
  files.set(x.id, x); return x;
}
const blob = name => { const b = { name, getAs: () => blob(name), setName: n => { b.name = n; return b; } }; return b; };

const root = mkFolder('My Drive', null);
const billing = mkFolder('Warehouse billing', root);
const unbilled = mkFolder('To check', root);
const billedTop = mkFolder('Billed', root); const billedSub = mkFolder('November', billedTop);
const notBilled = mkFolder('Not billed yet', root);

const ctx = {
  console, Logger: { log() {} },
  DriveApp: { getFileById: id => { const f = files.get(id); if (!f || f.gone) throw new Error('not found'); return f; } },
  Utilities: { newBlob: (html, type, name) => blob(name) },
  MailApp: { sendEmail: m => mails.push(m) },
};
vm.runInNewContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);
const confirms = []; ctx.rpc_ = (p, fn, args) => { confirms.push(args); return {}; };
const brand = { notify_email: 'billing@example.com' };

const base = { revision: 2, version: 'C1', branch: 'B', timezone: 'UTC', generated_at: 'now', job: { id: 1, name: 'Main St', full_name: 'Acme=>Main St' },
  cart: { id: 9, at: 'then', entered_by: 'Sam', note: '' }, current_note: '', corrections: [{ seq: 1, at: 'x', by: 'Alex', changes: [] }],
  original: [{ number: 'C-1', name: 'Wire', qty: 2 }], current: [{ number: 'C-1', name: 'Wire', qty: 3 }], cancelled: false };
let n = 100;
function run(label, placeOld, extra = {}) {
  const docId = n++; const old = placeOld ? placeOld(docId) : null;
  const d = { ...base, ...extra, doc_id: docId, file_name: 'Main St 11/06/2026 Correction 1 by Alex', old_file_id: old ? old.id : null };
  const before = mails.length; ctx.deliverOne_({}, billing, brand, d);
  const made = [...files.values()].filter(f => f.desc === 'Billing document D' + docId && f !== old && !f.trashed);
  return { label, oldTrashed: old ? old.trashed : null, newIn: made.map(f => f.parent.name), emailed: mails.length > before };
}
const tag = id => 'Billing document D' + id;
const results = [
  run('first version', null),
  run('in the billing folder', id => mkFile('old.pdf', billing, tag(id))),
  run('moved to another folder', id => mkFile('old.pdf', unbilled, tag(id))),
  run('in a "Billed" sub-folder', id => mkFile('old.pdf', billedSub, tag(id))),
  run('in "Not billed yet"', id => mkFile('old.pdf', notBilled, tag(id))),
  run('deleted (in Trash)', id => { const f = mkFile('old.pdf', billing, tag(id)); f.trashed = true; return f; }),
  run('deleted for good', id => { const f = mkFile('old.pdf', billing, tag(id)); f.gone = true; return f; }),
  run('cancelled, in billing folder', id => mkFile('old.pdf', billing, tag(id)), { cancelled: true, current: [] }),
  run('cancelled, in Billed', id => mkFile('old.pdf', billedTop, tag(id)), { cancelled: true, current: [] }),
  run('job emptied, moved', id => mkFile('old.pdf', unbilled, tag(id)), { current: [] }),
];
const expect = {
  'first version': [null, ['Warehouse billing'], false],
  'in the billing folder': [true, ['Warehouse billing'], false],
  'moved to another folder': [true, ['To check'], true],
  'in a "Billed" sub-folder': [false, ['Warehouse billing'], true],
  'in "Not billed yet"': [true, ['Not billed yet'], true],
  'deleted (in Trash)': [true, ['Warehouse billing'], false],
  'deleted for good': [null, ['Warehouse billing'], true],
  'cancelled, in billing folder': [true, [], false],
  'cancelled, in Billed': [false, [], true],
  'job emptied, moved': [true, [], true],
};
let bad = 0;
for (const r of results) {
  const [t, where, mail] = expect[r.label];
  const gone = r.label === 'deleted for good';
  const ok = (gone || r.oldTrashed === t) && JSON.stringify(r.newIn) === JSON.stringify(where) && r.emailed === mail;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.label}: old to Trash ${r.oldTrashed}, new PDF in ${JSON.stringify(r.newIn)}, email ${r.emailed}`);
}
const m = mails[0]; if (!m || m.attachments.length !== 2 || m.to !== 'billing@example.com') { bad++; console.log('FAIL email has both versions attached'); }
if (bad) process.exit(1);
console.log('All delivery cases behave as intended');
