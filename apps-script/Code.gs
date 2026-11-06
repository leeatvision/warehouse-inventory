/**
 * Warehouse billing delivery. Runs every 5 minutes in the Google account that owns the billing folder.
 * For every Cart and Job code with new or corrected Take outs, it saves one PDF and replaces the previous version.
 * A previous version that is no longer in the billing folder is replaced where it is, unless it is in a "billed"
 * folder (then it is left alone); either way an email with both versions goes to the address in the PDF settings.
 * A cancelled Cart, or a Job code a Correction emptied, gets no new PDF. Nothing is marked delivered until the PDF
 * is saved, so a failed run is simply retried 5 minutes later.
 *
 * Script properties (Project Settings > Script properties):
 *   SUPABASE_URL    https://<project>.supabase.co
 *   SUPABASE_KEY    the publishable key
 *   DELIVERY_TOKEN  the wh_delivery_token value from Supabase Vault
 *   FOLDER_ID       the billing folder's id (the part after /folders/ in its link)
 */

function setup() {
  const p = props_();
  DriveApp.getFolderById(p.FOLDER_ID).getName(); // fails here if the folder is wrong or not shared with this account
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'deliver').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('deliver').timeBased().everyMinutes(5).create();
  deliver();
  Logger.log('Set up: delivery runs every 5 minutes.');
}

function deliver() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a run is already going
  try {
    const p = props_();
    const folder = DriveApp.getFolderById(p.FOLDER_ID);
    const brand = loadBrand_(p);
    for (let round = 0; round < 5; round++) {
      const docs = rpc_(p, 'wh_delivery_claim', { p_token: p.DELIVERY_TOKEN, p_limit: 20 });
      if (!docs.length) break;
      for (const d of docs) {
        try {
          deliverOne_(p, folder, brand, d);
        } catch (e) {
          try { rpc_(p, 'wh_delivery_confirm', { p_token: p.DELIVERY_TOKEN, p_doc: d.doc_id, p_revision: d.revision, p_file_id: null, p_file_name: null, p_error: String(e && e.message || e) }); } catch (ignored) {}
          throw e; // stop this run; Google emails the account owner about repeated failures
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// Every version of a document carries the same tag in its Drive description, e.g. "Billing document D457".
function docTag_(d) { return 'Billing document D' + d.doc_id; }

// One document. Where the previous version is decides what happens:
//   in the billing folder        -> replaced there (old one to Trash, new one saved in the billing folder)
//   moved to another folder that is not a "billed" folder -> replaced in that folder, and an email is sent
//   in a "billed" folder         -> left alone; the new one is saved in the billing folder, and an email is sent
//   deleted                      -> the new one is saved in the billing folder, and an email is sent
// A cancelled Cart, or a Job code a Correction emptied, gets no new PDF (the previous one is still removed where allowed).
function deliverOne_(p, folder, brand, d) {
  const old = previousVersion_(d, folder);
  const nothingToBill = d.cancelled || !(d.current || []).length;
  const name = d.file_name + '.pdf';
  const pdf = Utilities.newBlob(buildHtml(d, brand), 'text/html', d.file_name + '.html').getAs('application/pdf').setName(name);
  const target = old.state === 'moved' && old.parent ? old.parent : folder;
  let file = null;
  if (!nothingToBill) { file = target.createFile(pdf); file.setDescription(docTag_(d)); }
  if ((old.state === 'home' || old.state === 'moved') && old.file) old.file.setTrashed(true);
  trashOlder_(folder, d, file && file.getId());
  if (old.state !== 'none' && old.state !== 'home') notify_(brand, d, old, pdf, file, nothingToBill);
  rpc_(p, 'wh_delivery_confirm', { p_token: p.DELIVERY_TOKEN, p_doc: d.doc_id, p_revision: d.revision,
    p_file_id: file ? file.getId() : null, p_file_name: file ? name : null, p_error: null });
}

// Where the previous PDF of this document is now: none (first version), home (billing folder), moved (another folder
// that is not billed), billed, deleted (in Trash) or gone (deleted for good / no longer reachable).
function previousVersion_(d, folder) {
  if (!d.old_file_id) return { state: 'none' };
  let f;
  try { f = DriveApp.getFileById(d.old_file_id); f.getName(); } catch (e) { return { state: 'gone' }; }
  if (f.isTrashed()) return { state: 'deleted', file: f };
  const parents = []; const it = f.getParents(); while (it.hasNext()) parents.push(it.next());
  if (parents.some(x => x.getId() === folder.getId())) return { state: 'home', file: f, parent: folder };
  const billed = parents.find(x => inBilledFolder_(x));
  if (billed) return { state: 'billed', file: f, parent: billed };
  return { state: 'moved', file: f, parent: parents[0] || null };
}
// A folder counts as billed when its name, or the name of a folder above it, contains the word "billed"
// ("Billed", "Billed 2026", "Jobs - billed"), but not "unbilled" or "not billed".
function inBilledFolder_(folder) {
  let f = folder;
  for (let i = 0; i < 12 && f; i++) {
    const n = f.getName();
    if (/\bbilled\b/i.test(n) && !/\bnot[\s_-]*billed\b/i.test(n)) return true;
    const up = f.getParents(); f = up.hasNext() ? up.next() : null;
  }
  return false;
}

// Email the previous and the new version when the previous one was not in the billing folder.
function notify_(brand, d, old, pdf, file, nothingToBill) {
  const to = brand.notify_email; if (!to) return;
  try {
    let original, originalNote = '';
    if (old.file) original = old.file.getBlob().setName('Previous - ' + old.file.getName());
    else {
      const first = Object.assign({}, d, { corrections: [], current: d.original, cancelled: false, version: 'T1',
        current_note: d.cart.note, file_name: d.file_name + ' (original, rebuilt)' });
      original = Utilities.newBlob(buildHtml(first, brand), 'text/html', 'original.html').getAs('application/pdf')
        .setName('Original (rebuilt) - ' + d.file_name + '.pdf');
      originalNote = ' The earlier PDF could not be found, so the original Cart is rebuilt from the records.';
    }
    const folderName = old.parent ? old.parent.getName() : '?';
    const where = {
      moved: 'had been moved to the folder "' + folderName + '". ' +
        (nothingToBill ? 'It has been moved to Trash; there is nothing left to bill.' : 'It has been replaced there with the corrected version.'),
      billed: 'is in the billed folder "' + folderName + '", so it was left there. ' +
        (nothingToBill ? 'Nothing is left to bill on this document: credit what was billed.' : 'The corrected version was saved in the billing folder: bill the difference.'),
      deleted: 'had been deleted. ' + (nothingToBill ? 'Nothing is left to bill.' : 'The corrected version was saved in the billing folder.'),
      gone: 'could not be found (deleted or no longer shared). ' + (nothingToBill ? 'Nothing is left to bill.' : 'The corrected version was saved in the billing folder.'),
    }[old.state];
    const what = d.cancelled ? 'Cart ' + d.cart.id + ' was cancelled' : nothingToBill ? 'Every item for this Job code was taken off Cart ' + d.cart.id : 'Cart ' + d.cart.id + ' was corrected';
    const job = (d.job && (d.job.name || d.job.full_name)) || ('Job code ' + (d.job && d.job.id));
    MailApp.sendEmail({
      to: to,
      subject: (nothingToBill ? 'Billing document removed: ' : 'Billing document corrected: ') + job + ' (D' + d.doc_id + ')',
      htmlBody: '<p>' + esc_(what) + ' (' + esc_(job) + ', document D' + d.doc_id + ').</p><p>The earlier PDF ' + esc_(where) + esc_(originalNote) + '</p>' +
        (file ? '<p>Corrected PDF: <a href="' + file.getUrl() + '">' + esc_(file.getName()) + '</a></p>' : '') +
        '<p>Attached: the earlier version and the ' + (nothingToBill ? 'cancellation' : 'corrected') + ' version.</p>',
      attachments: [original, pdf],
    });
  } catch (e) {
    console.error('Could not send the correction email for D' + d.doc_id + ': ' + (e && e.message || e));
  }
}

// Move any other copy of this document still in the billing folder to Trash (older files were named "..._D457").
function trashOlder_(folder, d, keepId) {
  const tag = docTag_(d), suffix = '_D' + d.doc_id + '.pdf';
  const searches = ['fullText contains "' + tag + '" and trashed = false', 'title contains "_D' + d.doc_id + '" and trashed = false'];
  for (const q of searches) {
    const it = folder.searchFiles(q);
    while (it.hasNext()) {
      const f = it.next();
      if (f.getId() !== keepId && (f.getDescription() === tag || f.getName().endsWith(suffix))) f.setTrashed(true);
    }
  }
}

// The PDF's look (company name, colours, logo) comes from the database, so this script holds nothing company-specific.
// The logo is fetched once and kept for 6 hours.
function loadBrand_(p) {
  let brand = {};
  try { brand = rpc_(p, 'wh_delivery_brand', { p_token: p.DELIVERY_TOKEN }) || {}; } catch (e) { brand = {}; }
  if (brand.logo_url) {
    const cache = CacheService.getScriptCache(); const key = 'logo:' + brand.logo_url;
    let data = cache.get(key);
    if (!data) {
      try {
        const r = UrlFetchApp.fetch(brand.logo_url, { muteHttpExceptions: true });
        if (r.getResponseCode() === 200) {
          const blob = r.getBlob();
          data = 'data:' + (blob.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(blob.getBytes());
          if (data.length < 95000) cache.put(key, data, 21600);
        }
      } catch (e) { data = null; }
    }
    brand.logo = data || '';
  }
  if (brand.font_url) brand.font = fetchData_(brand.font_url, 'font/woff2');
  return brand;
}

// Fetch a file once and keep it for 6 hours as a data: address the PDF can use.
function fetchData_(url, type) {
  const cache = CacheService.getScriptCache(); const key = 'data:' + url;
  let data = cache.get(key);
  if (data) return data;
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return '';
    data = 'data:' + type + ';base64,' + Utilities.base64Encode(r.getBlob().getBytes());
    if (data.length < 95000) cache.put(key, data, 21600);
    return data;
  } catch (e) { return ''; }
}

function props_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'DELIVERY_TOKEN', 'FOLDER_ID']) {
    if (!all[k]) throw new Error('Script property ' + k + ' is not set');
  }
  return all;
}

function rpc_(p, fn, args) {
  const r = UrlFetchApp.fetch(p.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'post', contentType: 'application/json', headers: { apikey: p.SUPABASE_KEY },
    payload: JSON.stringify(args), muteHttpExceptions: true,
  });
  const body = r.getContentText();
  if (r.getResponseCode() >= 300) throw new Error(fn + ' failed (' + r.getResponseCode() + '): ' + body.slice(0, 300));
  return JSON.parse(body);
}

// ------------------------------------------------------------------ the PDF
// Simple HTML and tables, because Google's HTML-to-PDF converter handles little else reliably.
function esc_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function qty_(v) { const n = Number(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000); }

// Condensed layout using the company design kit: kit greys, the brand green and font (falls back to Arial).
function buildHtml(d, brand) {
  brand = brand || {};
  const accent = brand.accent || '#2563EB', ink = brand.accent_ink || '#1E3A8A', tint = brand.tint || '#EFF4FF';
  const INK = '#1E1E1E', INK2 = '#3D3D3D', MUT = '#8C9090', LINE = '#E0E0E0', ZEBRA = '#FAFAFA';
  const FONT = (brand.font ? '"Brand",' : '') + 'Arial,Helvetica,sans-serif';
  const corr = d.corrections || [];
  const latest = corr[0];
  const job = d.job || {};
  const addr = job.address && job.address.lines && job.address.lines.length ? job.address : null;
  const sum = rows => rows.reduce((a, r) => a + Number(r.qty || 0), 0);
  const cell = 'font-size:8.5pt;padding:3pt 6pt;border-bottom:.5pt solid ' + LINE + ';vertical-align:top;';
  const th = 'font-size:6.5pt;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:' + MUT + ';text-align:left;padding:3pt 6pt;border-bottom:1pt solid ' + INK + ';';
  const lbl = 'font-size:6.5pt;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:' + MUT + ';';

  const css = (brand.font ? '@font-face{font-family:"Brand";src:url(' + brand.font + ') format("woff2");font-weight:200 800}' : '') +
    'body{font-family:' + FONT + ';font-size:8.5pt;color:' + INK + ';margin:0;line-height:1.3}' +
    'table{border-collapse:collapse;width:100%}td,th{font-family:' + FONT + ';font-size:8.5pt;vertical-align:top}' +
    '.mono{font-family:"Courier New",monospace;font-size:8pt;color:' + INK2 + '}';

  function itemsTable(rows) {
    if (!rows.length) return '<div style="font-size:8.5pt;color:' + MUT + ';padding:2pt 0">No items for this Job code.</div>';
    return '<table><tr><th style="' + th + 'width:14pt">#</th><th style="' + th + 'width:52pt">Item no.</th><th style="' + th + '">Item</th>' +
      '<th style="' + th + 'text-align:right;width:34pt">Qty</th><th style="' + th + 'width:150pt">Note</th></tr>' +
      rows.map((r, i) => '<tr style="background:' + (i % 2 ? ZEBRA : '#FFFFFF') + '"><td style="' + cell + 'color:' + MUT + '">' + (i + 1) + '</td>' +
        '<td style="' + cell + '"><span class="mono">' + esc_(r.number) + '</span></td><td style="' + cell + 'font-weight:bold">' + esc_(r.name) + '</td>' +
        '<td style="' + cell + 'text-align:right;font-weight:bold;font-size:9pt">' + qty_(r.qty) + '</td><td style="' + cell + 'color:' + INK2 + '">' + esc_(r.note) + '</td></tr>').join('') +
      '<tr><td style="font-size:8pt;padding:3pt 6pt"></td><td colspan="2" style="font-size:8pt;padding:3pt 6pt;font-weight:bold;color:' + INK2 + '">' + rows.length + (rows.length === 1 ? ' line' : ' lines') + '</td>' +
      '<td style="font-size:9pt;padding:3pt 6pt;text-align:right;font-weight:bold">' + qty_(sum(rows)) + '</td><td></td></tr></table>';
  }
  function changesTable(c) {
    if (!c.changes.length) return '<div style="font-size:8.5pt;color:' + MUT + '">No quantity changes for this Job code.</div>';
    return '<table><tr><th style="' + th + 'width:52pt">Item no.</th><th style="' + th + '">Item</th><th style="' + th + 'text-align:right;width:40pt">Before</th>' +
      '<th style="' + th + 'text-align:right;width:40pt">After</th><th style="' + th + 'text-align:right;width:44pt">Change</th></tr>' +
      c.changes.map(x => {
        const diff = Number(x.after) - Number(x.before);
        return '<tr><td style="' + cell + '"><span class="mono">' + esc_(x.number) + '</span></td><td style="' + cell + '"><b>' + esc_(x.name) + '</b>' +
          (x.note ? ' <span style="color:' + MUT + '">· ' + esc_(x.note) + '</span>' : '') + '</td>' +
          '<td style="' + cell + 'text-align:right;color:' + MUT + '">' + qty_(x.before) + '</td><td style="' + cell + 'text-align:right;font-weight:bold">' + qty_(x.after) + '</td>' +
          '<td style="' + cell + 'text-align:right;font-weight:bold;color:' + (diff > 0 ? ink : '#A33333') + '">' + (diff > 0 ? '+' : diff < 0 ? '&minus;' : '') + qty_(Math.abs(diff)) + '</td></tr>';
      }).join('') + '</table>';
  }
  const h2 = (title, sub) => '<div style="margin:10pt 0 3pt;font-size:9pt;font-weight:bold;color:' + INK + '">' + title +
    (sub ? ' <span style="font-weight:normal;color:' + MUT + ';font-size:8pt">' + sub + '</span>' : '') + '</div>';

  const status = d.cancelled ? ['CANCELLED', '#FDEAEA', '#A33333'] : corr.length ? ['CORRECTED · ' + d.version, '#FDF3E0', '#7A4F00'] : ['TAKE OUT · ' + d.version, tint, ink];
  const meta = [['Cart', d.cart.id], ['Date', d.cart.at], ['Entered by', d.cart.entered_by]]
    .concat(d.cart.on_behalf_of ? [['For', d.cart.on_behalf_of]] : [])
    .concat([['Branch', d.branch_code || d.branch]]);

  let banner = '';
  if (d.cancelled) banner = '<div style="margin-top:8pt;padding:4pt 8pt;border-left:3pt solid #C94040;background:#FDEAEA;color:#7A1F1F;font-size:8.5pt;font-weight:bold">Cancelled' +
    (latest ? ' ' + esc_(latest.at) + ' by ' + esc_(latest.by) : '') + '. Nothing on this document should be billed. Replaces every earlier version of D' + d.doc_id + '.</div>';
  else if (latest) banner = '<div style="margin-top:8pt;padding:4pt 8pt;border-left:3pt solid #E8A020;background:#FDF3E0;color:#5C3B00;font-size:8.5pt;font-weight:bold">Corrected ' +
    corr.length + (corr.length === 1 ? ' time' : ' times') + ', last ' + esc_(latest.at) + ' by ' + esc_(latest.by) +
    '. Bill the items below. Replaces every earlier version of D' + d.doc_id + '.</div>';

  let body = h2(corr.length ? 'Items to bill (current)' : 'Items taken out') + itemsTable(d.cancelled ? [] : d.current);
  const noteNow = d.current_note;
  if (noteNow) body += '<div style="margin-top:4pt;font-size:8.5pt"><span style="' + lbl + '">Cart note</span>&nbsp; ' + esc_(noteNow) + '</div>';
  corr.forEach(c => {
    body += h2(c.cancelled ? 'Cancellation' : 'Correction ' + c.seq, '· ' + esc_(c.at) + ' · ' + esc_(c.by) + (c.correction_note ? ' · “' + esc_(c.correction_note) + '”' : ''));
    if ((c.note_before || '') !== (c.note_after || '')) body += '<div style="font-size:8pt;color:' + MUT + ';margin:0 0 3pt">Cart note changed from “' +
      esc_(c.note_before) + '” to “' + esc_(c.note_after) + '”</div>';
    body += changesTable(c);
  });
  if (corr.length) body += h2('Original Cart ' + d.cart.id, '· ' + esc_(d.cart.at) + ' · ' + esc_(d.cart.entered_by)) + itemsTable(d.original) +
    (d.cart.note && d.cart.note !== noteNow ? '<div style="margin-top:4pt;font-size:8.5pt"><span style="' + lbl + '">Original Cart note</span>&nbsp; ' + esc_(d.cart.note) + '</div>' : '');

  const logo = brand.logo ? '<img src="' + brand.logo + '" style="height:32pt">' : '<div style="font-size:12pt;font-weight:bold">' + esc_(brand.company || '') + '</div>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div style="padding:22pt 26pt">' +
    // Header: logo, document number and status on one line
    '<table><tr><td style="vertical-align:middle">' + logo + '</td>' +
    '<td style="text-align:right;vertical-align:middle"><span style="' + lbl + '">Material usage</span>&nbsp;&nbsp;' +
    '<span style="font-size:14pt;font-weight:bold;vertical-align:middle">D' + d.doc_id + '</span>&nbsp;&nbsp;' +
    '<span style="padding:1.5pt 5pt;font-size:6.5pt;font-weight:bold;letter-spacing:.04em;background:' + status[1] + ';color:' + status[2] + ';vertical-align:middle">' + status[0] + '</span></td></tr></table>' +
    '<div style="height:2pt;background:' + accent + ';margin:6pt 0 8pt"></div>' +
    // Job, address and Cart details side by side
    '<table><tr>' +
    '<td style="width:44%;padding-right:10pt"><div style="' + lbl + '">Job</div>' +
    '<div style="font-size:12pt;font-weight:bold;line-height:1.2">' + esc_(job.name || ('Job code ' + job.id)) + '</div>' +
    (job.customer ? '<div style="font-size:8.5pt;color:' + INK2 + '">' + esc_(String(job.customer).replace(/\s*=>\s*/g, ' › ')) + '</div>' : '') +
    '</td>' +
    '<td style="width:28%;padding:4pt 8pt;background:' + tint + '"><div style="' + lbl + 'color:' + ink + '">' + (addr && addr.source !== 'site' ? 'Billing address' : 'Job site') + '</div>' +
    (addr ? addr.lines.map(l => '<div style="font-size:8.5pt">' + esc_(l) + '</div>').join('') : '<div style="font-size:8pt;color:' + MUT + '">No address in QuickBooks</div>') + '</td>' +
    '<td style="padding-left:10pt"><table>' + meta.map(m => '<tr><td style="font-size:7.5pt;color:' + MUT + ';padding:0 6pt 1pt 0;white-space:nowrap">' + m[0] + '</td>' +
      '<td style="font-size:8pt;font-weight:bold;padding:0 0 1pt">' + esc_(m[1]) + '</td></tr>').join('') + '</table></td>' +
    '</tr></table>' + banner + body +
    '<table style="margin-top:14pt;border-top:.5pt solid ' + LINE + '"><tr><td style="padding-top:3pt;font-size:6.5pt;color:' + MUT + '">' +
    esc_(brand.company ? brand.company + ' · ' : '') + 'Take outs only · Made ' + esc_(d.generated_at) + '</td>' +
    '<td style="padding-top:3pt;text-align:right;font-size:6.5pt;color:' + MUT + '">' + esc_(d.file_name) + '.pdf</td></tr></table></div></body></html>';
}
