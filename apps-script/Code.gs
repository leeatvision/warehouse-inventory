/**
 * Warehouse billing delivery. Runs every 5 minutes in the Google account that owns the billing folder.
 * For every Cart and Job code with new or corrected Take outs, it saves one PDF into the folder and moves
 * the previous version of that document to Trash. A cancelled Cart gets no PDF; its earlier PDF goes to Trash. Nothing is marked delivered until the PDF is saved,
 * so a failed run is simply retried 5 minutes later.
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
          // Cancelled Carts never go to billing: move any earlier PDF of this document to Trash and make no new one.
          if (d.cancelled) {
            trashOlder_(folder, d, null);
            rpc_(p, 'wh_delivery_confirm', { p_token: p.DELIVERY_TOKEN, p_doc: d.doc_id, p_revision: d.revision, p_file_id: null, p_file_name: null, p_error: null });
            continue;
          }
          const name = d.file_name + '.pdf';
          const pdf = Utilities.newBlob(buildHtml(d, brand), 'text/html', d.file_name + '.html').getAs('application/pdf').setName(name);
          const file = folder.createFile(pdf);
          file.setDescription(docTag_(d));
          trashOlder_(folder, d, file.getId());
          rpc_(p, 'wh_delivery_confirm', { p_token: p.DELIVERY_TOKEN, p_doc: d.doc_id, p_revision: d.revision, p_file_id: file.getId(), p_file_name: name, p_error: null });
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

// Move every earlier version of this document to Trash, keeping the one just made. Older files were named with
// "_D457" at the end instead of the tag, so those are found by name.
function trashOlder_(folder, d, keepId) {
  const tag = docTag_(d), suffix = '_D' + d.doc_id + '.pdf';
  if (d.old_file_id && d.old_file_id !== keepId) {
    try { DriveApp.getFileById(d.old_file_id).setTrashed(true); } catch (e) { /* already gone or moved out of reach */ }
  }
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
